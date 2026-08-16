-- Add bonus_tokens column: one-time token grants that persist across monthly resets.
alter table public.profiles
  add column if not exists bonus_tokens bigint not null default 0
  check (bonus_tokens >= 0);

-- Update the reservation function to include bonus_tokens in the quota ceiling.
create or replace function public.reserve_llm_tokens(
  p_user_id uuid,
  p_estimated_tokens bigint,
  p_feature text,
  p_provider text,
  p_model text
)
returns table(reservation_id uuid, remaining_tokens bigint)
language plpgsql
security definer set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_month text := to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM');
  v_id uuid := gen_random_uuid();
  v_limit bigint;
begin
  if p_estimated_tokens <= 0 then
    raise exception 'INVALID_RESERVATION';
  end if;

  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  if v_profile.status <> 'active' then raise exception 'ACCOUNT_BLOCKED'; end if;

  if v_profile.usage_month <> v_month then
    update public.profiles
       set used_tokens = 0, reserved_tokens = 0, usage_month = v_month, updated_at = now()
     where id = p_user_id;
    v_profile.used_tokens := 0;
    v_profile.reserved_tokens := 0;
    v_profile.usage_month := v_month;
  end if;

  v_limit := v_profile.monthly_token_limit + coalesce(v_profile.bonus_tokens, 0);

  if v_limit - v_profile.used_tokens - v_profile.reserved_tokens < p_estimated_tokens then
    raise exception 'QUOTA_EXCEEDED';
  end if;

  insert into public.llm_usage (
    id, user_id, feature, provider, model, reserved_tokens, usage_month
  ) values (
    v_id, p_user_id, p_feature, p_provider, p_model, p_estimated_tokens, v_month
  );

  update public.profiles
     set reserved_tokens = reserved_tokens + p_estimated_tokens, updated_at = now()
   where id = p_user_id;

  return query select v_id,
    v_limit - v_profile.used_tokens - v_profile.reserved_tokens - p_estimated_tokens;
end;
$$;

-- Update settle to use bonus_tokens in remaining calculation.
create or replace function public.settle_llm_tokens(
  p_reservation_id uuid,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cache_read_tokens bigint,
  p_cache_write_tokens bigint,
  p_provider_request_id text,
  p_cost_usd numeric,
  p_measured boolean
)
returns table(charged_tokens bigint, remaining_tokens bigint)
language plpgsql
security definer set search_path = public
as $$
declare
  v_usage public.llm_usage%rowtype;
  v_profile public.profiles%rowtype;
  v_total bigint := greatest(0, p_input_tokens) + greatest(0, p_output_tokens)
    + greatest(0, p_cache_read_tokens) + greatest(0, p_cache_write_tokens);
  v_limit bigint;
begin
  select * into v_usage from public.llm_usage where id = p_reservation_id for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_usage.status <> 'reserved' then raise exception 'RESERVATION_ALREADY_SETTLED'; end if;
  select * into v_profile from public.profiles where id = v_usage.user_id for update;

  v_limit := v_profile.monthly_token_limit + coalesce(v_profile.bonus_tokens, 0);

  update public.llm_usage
     set status = 'completed', input_tokens = greatest(0, p_input_tokens),
         output_tokens = greatest(0, p_output_tokens), cache_read_tokens = greatest(0, p_cache_read_tokens),
         cache_write_tokens = greatest(0, p_cache_write_tokens), total_tokens = v_total,
         provider_request_id = p_provider_request_id, cost_usd = p_cost_usd,
         measured = p_measured, completed_at = now()
   where id = p_reservation_id;

  if v_usage.usage_month = v_profile.usage_month then
    update public.profiles
       set reserved_tokens = greatest(0, reserved_tokens - v_usage.reserved_tokens),
           used_tokens = used_tokens + v_total, updated_at = now()
     where id = v_usage.user_id;
    return query select v_total,
      greatest(0, v_limit - v_profile.used_tokens - v_total
        - greatest(0, v_profile.reserved_tokens - v_usage.reserved_tokens));
  else
    return query select v_total,
      greatest(0, v_limit - v_profile.used_tokens - v_profile.reserved_tokens);
  end if;
end;
$$;

revoke all on function public.reserve_llm_tokens(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.settle_llm_tokens(uuid, bigint, bigint, bigint, bigint, text, numeric, boolean) from public, anon, authenticated;
