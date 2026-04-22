create extension if not exists pgcrypto;

create table if not exists public.guidebook_app_states (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.guidebook_admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  username text unique not null,
  nickname text not null,
  color text not null default '#3a7bff',
  is_super_admin boolean not null default false,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  last_login_ip text not null default '',
  last_login_at timestamptz
);

create table if not exists public.guidebook_presence (
  session_id text primary key,
  nickname text not null,
  is_admin boolean not null default false,
  ip text not null default '',
  admin_id uuid references public.guidebook_admin_profiles(id) on delete set null,
  device_id text,
  last_seen_at timestamptz not null default now()
);

create or replace function public.is_guidebook_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.guidebook_admin_profiles p
    where p.id = auth.uid()
      and p.disabled = false
  );
$$;

create or replace function public.is_guidebook_super_admin()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.guidebook_admin_profiles p
    where p.id = auth.uid()
      and p.disabled = false
      and p.is_super_admin = true
  );
$$;

alter table public.guidebook_app_states enable row level security;
alter table public.guidebook_admin_profiles enable row level security;
alter table public.guidebook_presence enable row level security;

-- app state: 누구나 읽기, 관리자만 쓰기
create policy "guidebook_app_states_select_all"
  on public.guidebook_app_states
  for select
  to anon, authenticated
  using (true);

create policy "guidebook_app_states_insert_admin"
  on public.guidebook_app_states
  for insert
  to authenticated
  with check (public.is_guidebook_admin());

create policy "guidebook_app_states_update_admin"
  on public.guidebook_app_states
  for update
  to authenticated
  using (public.is_guidebook_admin())
  with check (public.is_guidebook_admin());

-- admin profile: 누구나 읽기, 본인/슈퍼관리자만 수정
create policy "guidebook_admin_profiles_select_all"
  on public.guidebook_admin_profiles
  for select
  to anon, authenticated
  using (true);

create policy "guidebook_admin_profiles_update_self_or_super"
  on public.guidebook_admin_profiles
  for update
  to authenticated
  using (id = auth.uid() or public.is_guidebook_super_admin())
  with check (id = auth.uid() or public.is_guidebook_super_admin());

create policy "guidebook_admin_profiles_insert_super"
  on public.guidebook_admin_profiles
  for insert
  to authenticated
  with check (public.is_guidebook_super_admin());

-- presence: 공개 읽기, 접속 현황 쓰기 허용
create policy "guidebook_presence_select_all"
  on public.guidebook_presence
  for select
  to anon, authenticated
  using (true);

create policy "guidebook_presence_insert_all"
  on public.guidebook_presence
  for insert
  to anon, authenticated
  with check (true);

create policy "guidebook_presence_update_all"
  on public.guidebook_presence
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "guidebook_presence_delete_all"
  on public.guidebook_presence
  for delete
  to anon, authenticated
  using (true);

insert into public.guidebook_app_states (id, payload)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('guidebook-media', 'guidebook-media', true)
on conflict (id) do nothing;

create policy "guidebook_media_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'guidebook-media');

create policy "guidebook_media_admin_insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'guidebook-media' and public.is_guidebook_admin());

create policy "guidebook_media_admin_update"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'guidebook-media' and public.is_guidebook_admin())
  with check (bucket_id = 'guidebook-media' and public.is_guidebook_admin());

create policy "guidebook_media_admin_delete"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'guidebook-media' and public.is_guidebook_admin());
