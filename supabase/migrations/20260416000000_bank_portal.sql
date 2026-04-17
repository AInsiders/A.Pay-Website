-- Profiles (theme + display) — users can only access their own row.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  accent_color text default '#8ef2ff',
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- Server-side Teller enrollment (no client access; Edge Functions use service role).
create table if not exists public.teller_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  enrollment_id text not null,
  access_token text not null,
  environment text not null default 'sandbox',
  institution_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id)
);

alter table public.teller_enrollments enable row level security;

-- Intentionally no policies: only service_role via Edge Functions.

-- Single-use nonces for Teller Connect (Edge Functions only).
create table if not exists public.teller_nonces (
  nonce text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null
);

create index if not exists teller_nonces_user_id_idx on public.teller_nonces (user_id);

alter table public.teller_nonces enable row level security;
