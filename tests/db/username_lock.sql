-- Tests the username lock (20261111120000_lock_users_username.sql) on a throwaway Postgres: the
-- trigger and update policy as they are live (20260824231800), then the migration. Nothing here
-- touches the real project.
--
-- Run from the repo root:
--   docker run -d --name ul-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec ul-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/username_lock.sql
--   docker rm -f ul-pg
-- It stops at the first failed check; "all checks passed" at the end means everything held.

\set ON_ERROR_STOP on

create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
grant usage on schema auth to authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.users (
  id uuid primary key, username text, email text, subscription text, created_at timestamp,
  pi_uid text, scheduled_deletion_at timestamptz, pi_wallet_address text
);
alter table public.users enable row level security;
create policy "Users can view their own profile" on public.users for select to authenticated
  using ((select auth.uid()) = id);
grant select, update on public.users to authenticated, service_role;

-- Two accounts with one username (one person, two Pi apps), as on the live project
insert into public.users (id, username, email, subscription, pi_uid) values
  ('00000000-0000-0000-0000-00000000000a', 'JordynDaniel', 'a@test', 'individual', 'pi-testnet-a'),
  ('00000000-0000-0000-0000-00000000000b', 'JordynDaniel', 'b@test', 'individual', 'pi-mainnet-b');

-- A SECURITY DEFINER path, owned by postgres like the live ones (upsert_user_profile)
create function public.set_username_as_server(p_id uuid, p_username text) returns void
language sql security definer set search_path = public as $$
  update public.users set username = p_username where id = p_id
$$;
grant execute on function public.set_username_as_server(uuid, text) to authenticated;

\i /app/supabase/migrations/20260824231800_fca1eacf-a7aa-4f1e-a8b6-dc7deb87d6a1.sql
-- Before the migration a user could rename themselves (the gap this closes)
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
update public.users set username = 'Renamed' where id = '00000000-0000-0000-0000-00000000000a';
reset role;
do $$ begin
  if (select username from public.users where id = '00000000-0000-0000-0000-00000000000a') <> 'Renamed' then
    raise exception 'setup: the old trigger already blocked a rename';
  end if;
end $$;
update public.users set username = 'JordynDaniel' where id = '00000000-0000-0000-0000-00000000000a';

\i /app/supabase/migrations/20261111120000_lock_users_username.sql
-- Applying it twice must also work (or replace)
\i /app/supabase/migrations/20261111120000_lock_users_username.sql

-- 1. An authenticated user changing their own username: refused with the trigger's message
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    update public.users set username = 'SomeoneElse' where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'an authenticated user changed their username';
  exception when raise_exception then
    if sqlerrm not like 'username cannot be changed directly%' then raise; end if;
  end;
end $$;

-- 2. Their other own profile fields still update, including with username set to the same value
update public.users set email = 'a2@test', pi_wallet_address = 'GABC', scheduled_deletion_at = now()
  where id = '00000000-0000-0000-0000-00000000000a';
update public.users set username = 'JordynDaniel', email = 'a3@test' where id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  if (select email from public.users where id = '00000000-0000-0000-0000-00000000000a') <> 'a3@test' then
    raise exception 'an own profile field did not update';
  end if;
end $$;

-- 3. pi_uid and subscription are still refused
do $$ begin
  begin
    update public.users set pi_uid = 'pi-other' where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'an authenticated user changed their pi_uid';
  exception when raise_exception then
    if sqlerrm <> 'pi_uid cannot be changed directly' then raise; end if;
  end;
  begin
    update public.users set subscription = 'organization' where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'an authenticated user changed their subscription';
  exception when raise_exception then
    if sqlerrm not like 'subscription cannot be changed directly%' then raise; end if;
  end;
end $$;

-- 4. A SECURITY DEFINER function owned by postgres may still set it, called by that user
select public.set_username_as_server('00000000-0000-0000-0000-00000000000a', 'ViaDefiner');
reset role;
do $$ begin
  if (select username from public.users where id = '00000000-0000-0000-0000-00000000000a') <> 'ViaDefiner' then
    raise exception 'the security definer path could not set username';
  end if;
end $$;

-- 5. The service role may set it
set role service_role;
update public.users set username = 'ViaServiceRole' where id = '00000000-0000-0000-0000-00000000000a';
reset role;
do $$ begin
  if (select username from public.users where id = '00000000-0000-0000-0000-00000000000a') <> 'ViaServiceRole' then
    raise exception 'the service role could not set username';
  end if;
end $$;

-- 6. No rows touched by the migration and no unique constraint: the shared username stays shared
do $$ begin
  if (select username from public.users where id = '00000000-0000-0000-0000-00000000000b') <> 'JordynDaniel' then
    raise exception 'the other account changed';
  end if;
  if exists (
    select 1 from pg_constraint where conrelid = 'public.users'::regclass and contype = 'u'
  ) or exists (
    select 1 from pg_indexes where tablename = 'users' and indexdef ilike '%unique%' and indexdef ilike '%username%'
  ) then
    raise exception 'a unique constraint was added';
  end if;
end $$;
update public.users set username = 'JordynDaniel' where id = '00000000-0000-0000-0000-00000000000a';

\echo 'all checks passed'
