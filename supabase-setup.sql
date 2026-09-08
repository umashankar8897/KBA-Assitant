-- Schema for the KBA assistant. Run this once in the Supabase SQL editor
-- (Dashboard -> SQL Editor -> New query) before using the app.
--
-- Three tables:
--   organisations  a team, identified to newcomers by its join code
--   profiles       links each signed-in user to an organisation and a role
--   kbas           the KBA library, one row per KBA, scoped to an organisation
--
-- Roles: 'admin' can change the KBA library and see the join code; 'analyst'
-- can work calls but not edit the library.
--
-- Row level security is what makes the anon key in config.js safe to ship, and
-- it is also what actually enforces read-only analysts. The app hides the edit
-- controls, but the policies below are what stop a determined analyst from
-- writing anyway.

-- ---------------------------------------------------------------------------
-- organisations
-- ---------------------------------------------------------------------------

create table if not exists public.organisations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  -- Short, shareable, and easy to read out over the phone.
  join_code  text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id      uuid primary key references auth.users on delete cascade,
  org_id  uuid not null references public.organisations on delete cascade,
  role    text not null default 'analyst' check (role in ('admin', 'analyst'))
);

-- The caller's organisation and role. security definer so the policies below can
-- call them while they are themselves being evaluated.

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid();
$$;

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Sign-up carries two optional values in the user's metadata:
--
--   join_code          given -> join that organisation as an analyst
--   organisation_name  no join code -> create that organisation and be its admin
--
-- Raising here makes auth.signUp fail with the message, which the sign-up form
-- shows as-is, so a mistyped join code is reported rather than silently creating
-- a stray organisation.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  code       text := nullif(btrim(new.raw_user_meta_data ->> 'join_code'), '');
  org_name   text := nullif(btrim(new.raw_user_meta_data ->> 'organisation_name'), '');
  target_org uuid;
  new_role   text;
begin
  if code is not null then
    select id into target_org from public.organisations where upper(join_code) = upper(code);
    if target_org is null then
      raise exception 'That join code does not match any organisation.';
    end if;
    new_role := 'analyst';
  else
    insert into public.organisations (name)
      values (coalesce(org_name, split_part(new.email, '@', 1) || '''s team'))
      returning id into target_org;
    new_role := 'admin';
  end if;

  insert into public.profiles (id, org_id, role) values (new.id, target_org, new_role);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- kbas
-- ---------------------------------------------------------------------------

create table if not exists public.kbas (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null default public.current_org_id() references public.organisations on delete cascade,
  reference      text not null,          -- the app's human id, e.g. kba-till-power
  title          text not null,
  keywords       text[] not null default '{}',
  issue_example  text,
  -- Text pulled out of a source PDF in the browser, kept so whoever edits the
  -- KBA next can see where its steps came from. Never parsed, only displayed.
  source_text    text,
  start_step     text not null,          -- "start" on its own is a reserved word
  flow           jsonb not null,         -- the decision tree; "steps" in the app
  created_at     timestamptz not null default now(),

  -- One reference per organisation, and the conflict target the app upserts on,
  -- so saving an edit replaces the row instead of duplicating it.
  unique (org_id, reference)
);

create index if not exists kbas_org_id_idx on public.kbas (org_id);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

alter table public.organisations enable row level security;
alter table public.profiles      enable row level security;
alter table public.kbas          enable row level security;

-- Only admins can read the organisation row, because it carries the join code.
-- Anyone holding that code can add themselves to the organisation.
drop policy if exists "admins read own organisation" on public.organisations;
create policy "admins read own organisation" on public.organisations
  for select using (id = public.current_org_id() and public.current_role_name() = 'admin');

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (id = auth.uid());

-- Everyone in the organisation reads the KBAs; only admins change them.
drop policy if exists "members read org kbas" on public.kbas;
create policy "members read org kbas" on public.kbas
  for select using (org_id = public.current_org_id());

drop policy if exists "admins insert org kbas" on public.kbas;
create policy "admins insert org kbas" on public.kbas
  for insert with check (org_id = public.current_org_id() and public.current_role_name() = 'admin');

drop policy if exists "admins update org kbas" on public.kbas;
create policy "admins update org kbas" on public.kbas
  for update using (org_id = public.current_org_id() and public.current_role_name() = 'admin')
          with check (org_id = public.current_org_id() and public.current_role_name() = 'admin');

drop policy if exists "admins delete org kbas" on public.kbas;
create policy "admins delete org kbas" on public.kbas
  for delete using (org_id = public.current_org_id() and public.current_role_name() = 'admin');

-- ---------------------------------------------------------------------------
-- Step screenshots
-- ---------------------------------------------------------------------------
--
-- The bucket already exists. This is here so the file describes everything the
-- app expects, and so it can be rebuilt if it ever needs to be.
--
-- Private, because a screenshot of a till or a back office screen is internal.
-- Private also means a stored path is not a URL: the app signs paths in a batch
-- when the library loads, never during a call.
--
-- Files are laid out as <org_id>/<kba_reference>/<filename>, so the first path
-- segment is what the policies below check against.

insert into storage.buckets (id, name, public)
  values ('kba-images', 'kba-images', false)
  on conflict (id) do nothing;

-- Anyone in the organisation can look at its screenshots; only admins can put
-- them there or take them away. Mirrors the policies on the kbas table.

drop policy if exists "members read org images" on storage.objects;
create policy "members read org images" on storage.objects
  for select using (
    bucket_id = 'kba-images'
    and (storage.foldername(name))[1] = public.current_org_id()::text
  );

drop policy if exists "admins write org images" on storage.objects;
create policy "admins write org images" on storage.objects
  for insert with check (
    bucket_id = 'kba-images'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_role_name() = 'admin'
  );

drop policy if exists "admins delete org images" on storage.objects;
create policy "admins delete org images" on storage.objects
  for delete using (
    bucket_id = 'kba-images'
    and (storage.foldername(name))[1] = public.current_org_id()::text
    and public.current_role_name() = 'admin'
  );
