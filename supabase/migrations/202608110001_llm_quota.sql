create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  email text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  plan text not null default 'free' check (plan in ('free', 'pro', 'enterprise')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  monthly_token_limit bigint not null default 50000 check (monthly_token_limit >= 0),
  used_tokens bigint not null default 0 check (used_tokens >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  usage_month text not null default to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_email_lower_idx on public.profiles (lower(email));

create table if not exists public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  feature text not null,
  provider text not null,
  model text not null,
  status text not null default 'reserved' check (status in ('reserved', 'completed', 'released')),
  reserved_tokens bigint not null check (reserved_tokens > 0),
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  measured boolean not null default true,
  provider_request_id text,
  cost_usd numeric(14, 8),
  error_reason text,
  usage_month text not null default to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM'),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists llm_usage_user_created_idx on public.llm_usage (user_id, created_at desc);
create index if not exists llm_usage_month_status_idx on public.llm_usage (usage_month, status);

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.email, '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_auth_user();

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

  if v_profile.monthly_token_limit - v_profile.used_tokens - v_profile.reserved_tokens < p_estimated_tokens then
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
    v_profile.monthly_token_limit - v_profile.used_tokens - v_profile.reserved_tokens - p_estimated_tokens;
end;
$$;

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
begin
  select * into v_usage from public.llm_usage where id = p_reservation_id for update;
  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if v_usage.status <> 'reserved' then raise exception 'RESERVATION_ALREADY_SETTLED'; end if;
  select * into v_profile from public.profiles where id = v_usage.user_id for update;

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
      greatest(0, v_profile.monthly_token_limit - v_profile.used_tokens - v_total
        - greatest(0, v_profile.reserved_tokens - v_usage.reserved_tokens));
  else
    -- A call reserved before midnight belongs to the previous quota period.
    -- The new month's counters were already reset, so do not charge it twice.
    return query select v_total,
      greatest(0, v_profile.monthly_token_limit - v_profile.used_tokens - v_profile.reserved_tokens);
  end if;
end;
$$;

create or replace function public.release_llm_reservation(p_reservation_id uuid, p_reason text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare v_usage public.llm_usage%rowtype;
begin
  select * into v_usage from public.llm_usage where id = p_reservation_id for update;
  if not found or v_usage.status <> 'reserved' then return; end if;
  update public.llm_usage set status = 'released', error_reason = p_reason, completed_at = now()
   where id = p_reservation_id;
  update public.profiles set reserved_tokens = greatest(0, reserved_tokens - v_usage.reserved_tokens), updated_at = now()
   where id = v_usage.user_id;
end;
$$;

create or replace function public.reset_expired_free_quotas()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_month text := to_char(now() at time zone 'Europe/Istanbul', 'YYYY-MM');
  v_count integer;
begin
  update public.profiles
     set used_tokens = 0, reserved_tokens = 0, usage_month = v_month, updated_at = now()
   where plan = 'free' and usage_month <> v_month;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table public.profiles enable row level security;
alter table public.llm_usage enable row level security;

drop policy if exists "Users can read own profile" on public.profiles;
create policy "Users can read own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "Users can read own usage" on public.llm_usage;
create policy "Users can read own usage" on public.llm_usage for select using (auth.uid() = user_id);

revoke all on function public.reserve_llm_tokens(uuid, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.settle_llm_tokens(uuid, bigint, bigint, bigint, bigint, text, numeric, boolean) from public, anon, authenticated;
revoke all on function public.release_llm_reservation(uuid, text) from public, anon, authenticated;
revoke all on function public.reset_expired_free_quotas() from public, anon, authenticated;
