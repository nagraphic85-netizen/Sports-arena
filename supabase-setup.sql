-- Supabase → SQL Editor-এ পুরোটা পেস্ট করে RUN চাপুন
create table if not exists public.app_state (
  id int primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

drop policy if exists "app_read"   on public.app_state;
drop policy if exists "app_insert" on public.app_state;
drop policy if exists "app_update" on public.app_state;

create policy "app_read"   on public.app_state for select using (true);
create policy "app_insert" on public.app_state for insert with check (id = 1);
create policy "app_update" on public.app_state for update using (id = 1) with check (id = 1);
