-- Teklif Numarası + Teklif Geçmişi: her hesaplanan teklifi ("Anında Teklif Al"
-- ve cam.html'in teklif motorunun ortak kullandığı /cam-quote route'u) isteği
-- yapan kullanıcıya bağlı olarak saklar, partgo.co'daki "TEKLİF NO" alanına
-- karşılık gelen sıralı, insan-okunabilir bir numara üretir.
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  quote_seq bigint generated always as identity,
  quote_number text generated always as ('TK-' || lpad(quote_seq::text, 6, '0')) stored,
  part_name text not null default '',
  material text not null default '',
  mode text not null default 'basit' check (mode in ('basit', 'detayli')),
  quantity integer not null default 1 check (quantity > 0),
  minutes numeric not null default 0,
  subtotal numeric not null default 0,
  unit_price numeric not null default 0,
  total numeric not null default 0,
  currency text not null default 'TRY',
  items jsonb not null default '[]'::jsonb,
  bbox jsonb not null default '{}'::jsonb,
  tolerance text not null default '',
  surface_finish text not null default '',
  validity_days integer not null default 0 check (validity_days >= 0),
  valid_until timestamptz,
  pdf_url text,
  created_at timestamptz not null default now()
);

create index if not exists quotes_user_created_idx on public.quotes (user_id, created_at desc);
create unique index if not exists quotes_number_idx on public.quotes (quote_number);

alter table public.quotes enable row level security;

drop policy if exists "Users can read own quotes" on public.quotes;
create policy "Users can read own quotes" on public.quotes for select using (auth.uid() = user_id);
