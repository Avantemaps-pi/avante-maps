-- Tests the home location migration (20261112090000_users_home_location.sql) on a throwaway
-- Postgres, with the users table, update policy and trigger as they are live. Nothing here
-- touches the real project.
--
-- Run from the repo root:
--   docker run -d --name hl-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec hl-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/home_location.sql
--   docker rm -f hl-pg
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
insert into public.users (id, username, subscription) values
  ('00000000-0000-0000-0000-00000000000a', 'Owner', 'individual'),
  ('00000000-0000-0000-0000-00000000000b', 'Other', 'individual');

-- The live trigger and update policy, then this migration (twice: it must re-run cleanly)
\i /app/supabase/migrations/20260824231800_fca1eacf-a7aa-4f1e-a8b6-dc7deb87d6a1.sql
\i /app/supabase/migrations/20261111120000_lock_users_username.sql
\i /app/supabase/migrations/20261112090000_users_home_location.sql
\i /app/supabase/migrations/20261112090000_users_home_location.sql

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';

-- 1. A user saves their own home location
update public.users set home_lat = -33.9249, home_lng = 18.4241, home_set_at = now()
  where id = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  if (select home_lat from public.users where id = '00000000-0000-0000-0000-00000000000a') <> -33.9249 then
    raise exception 'own home location not saved';
  end if;
end $$;

-- 2. Skip: home_set_at with no position
update public.users set home_lat = null, home_lng = null, home_set_at = now()
  where id = '00000000-0000-0000-0000-00000000000a';

-- 3. Only one of the two, or out of range: refused
do $$ begin
  begin
    update public.users set home_lat = 10, home_lng = null where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'half a location was saved';
  exception when check_violation then null;
  end;
  begin
    update public.users set home_lat = 91, home_lng = 0 where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'latitude 91 was saved';
  exception when check_violation then null;
  end;
  begin
    update public.users set home_lat = 0, home_lng = -180.5 where id = '00000000-0000-0000-0000-00000000000a';
    raise exception 'longitude -180.5 was saved';
  exception when check_violation then null;
  end;
end $$;
update public.users set home_lat = -90, home_lng = 180 where id = '00000000-0000-0000-0000-00000000000a';

-- 4. Another user's row: the policy makes it a no-op
update public.users set home_lat = 1, home_lng = 1, home_set_at = now()
  where id = '00000000-0000-0000-0000-00000000000b';
reset role;
do $$ begin
  if (select home_set_at from public.users where id = '00000000-0000-0000-0000-00000000000b') is not null then
    raise exception 'changed another user''s home location';
  end if;
end $$;

\echo 'all checks passed'
