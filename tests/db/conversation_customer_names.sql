-- Tests get_conversation_customer_names (20261107120000_conversation_customer_names.sql) on a
-- throwaway Postgres, with Supabase's auth.uid() / auth.role() stubbed from a setting. Nothing here
-- touches the real project.
--
-- Run from the repo root:
--   docker run -d --name ccn-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec ccn-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/conversation_customer_names.sql
--   docker rm -f ccn-pg
-- It stops at the first failed check; "all checks passed" at the end means everything held.

\set ON_ERROR_STOP on

-- Just enough of the live schema: roles, auth.uid()/auth.role(), the tables and is_business_owner
create role anon;
create role authenticated;
create role service_role;
create schema auth;
grant usage on schema auth to anon, authenticated;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated')
$$;
create table public.users (id uuid primary key, username text not null, email text, pi_uid text, wallet_address text);
create table public.businesses (id integer primary key, owner_id uuid not null);
create table public.conversations (id uuid primary key, business_id integer not null, customer_id uuid not null);
-- As in 20261023090000_harden_is_business_owner.sql
create function public.is_business_owner(_user_id uuid, _business_id integer)
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select coalesce(
    (_user_id = auth.uid() or auth.role() = 'service_role')
      and exists (select 1 from public.businesses where id = _business_id and owner_id = _user_id),
    false)
$f$;

-- owner (bob) owns business 1; alice and carol are customers; dave owns nothing; erin has no users row
insert into public.users values
  ('00000000-0000-0000-0000-00000000000b', 'bob', 'bob@example.com', 'pi-bob', 'GBOB'),
  ('00000000-0000-0000-0000-00000000000a', 'alice', 'alice@example.com', 'pi-alice', 'GALICE'),
  ('00000000-0000-0000-0000-00000000000c', 'carol', 'carol@example.com', 'pi-carol', 'GCAROL'),
  ('00000000-0000-0000-0000-00000000000d', 'dave', 'dave@example.com', 'pi-dave', 'GDAVE');
insert into public.businesses values (1, '00000000-0000-0000-0000-00000000000b'), (2, '00000000-0000-0000-0000-00000000000d');
insert into public.conversations values
  ('11111111-1111-4111-8111-000000000001', 1, '00000000-0000-0000-0000-00000000000a'),  -- alice → bob's business
  ('11111111-1111-4111-8111-000000000002', 1, '00000000-0000-0000-0000-00000000000c'),  -- carol → bob's business
  ('11111111-1111-4111-8111-000000000003', 2, '00000000-0000-0000-0000-00000000000a'),  -- alice → dave's business
  ('11111111-1111-4111-8111-000000000004', 1, '00000000-0000-0000-0000-00000000000e');  -- erin (no users row) → bob's

\i /app/supabase/migrations/20261107120000_conversation_customer_names.sql
-- Applying it twice is harmless
\i /app/supabase/migrations/20261107120000_conversation_customer_names.sql

create temp table all_ids as select array_agg(id order by id) as ids from public.conversations;
grant select on all_ids to authenticated, anon;

-- 1. The owner of a conversation's business gets its customer's username (and only for theirs)
set role authenticated;
set test.uid = '00000000-0000-0000-0000-00000000000b';
do $$ begin
  assert (select count(*) from public.get_conversation_customer_names((select ids from all_ids))) = 2,
    'bob gets the two conversations on his business that have a users row';
  assert (select username from public.get_conversation_customer_names((select ids from all_ids))
          where conversation_id = '11111111-1111-4111-8111-000000000001') = 'alice', 'alice by name';
  assert (select username from public.get_conversation_customer_names((select ids from all_ids))
          where conversation_id = '11111111-1111-4111-8111-000000000002') = 'carol', 'carol by name';
  assert not exists (select 1 from public.get_conversation_customer_names((select ids from all_ids))
          where conversation_id = '11111111-1111-4111-8111-000000000003'), 'not the one on dave''s business';
  assert not exists (select 1 from public.get_conversation_customer_names((select ids from all_ids))
          where conversation_id = '11111111-1111-4111-8111-000000000004'), 'no row for a customer without a users row';
end $$;

-- 2. A different user gets nothing for bob's conversations
set test.uid = '00000000-0000-0000-0000-00000000000d';
do $$ begin
  assert (select count(*) from public.get_conversation_customer_names(array[
    '11111111-1111-4111-8111-000000000001', '11111111-1111-4111-8111-000000000002']::uuid[])) = 0,
    'dave gets nothing for bob''s business';
end $$;

-- 3. The customer gets nothing for a conversation they're only the customer on
set test.uid = '00000000-0000-0000-0000-00000000000a';
do $$ begin
  assert (select count(*) from public.get_conversation_customer_names((select ids from all_ids))) = 0,
    'alice gets nothing as the customer';
end $$;

-- 4. Signed out (no uid): nothing
reset test.uid;
do $$ begin
  assert (select count(*) from public.get_conversation_customer_names((select ids from all_ids))) = 0, 'no uid, no rows';
end $$;

-- 5. At most the first 200 ids are looked at
set test.uid = '00000000-0000-0000-0000-00000000000b';
do $$
declare
  padded uuid[] := array(select gen_random_uuid() from generate_series(1, 200)) || '11111111-1111-4111-8111-000000000001'::uuid;
begin
  assert (select count(*) from public.get_conversation_customer_names(padded)) = 0, 'the 201st id is ignored';
  assert (select count(*) from public.get_conversation_customer_names(padded[2:201])) = 1, 'the same id within 200 is answered';
end $$;
reset role;

-- 6. anon can't execute it; authenticated can; only conversation_id and username come back
do $$ begin
  assert not has_function_privilege('anon', 'public.get_conversation_customer_names(uuid[])', 'execute'), 'anon cannot execute';
  assert has_function_privilege('authenticated', 'public.get_conversation_customer_names(uuid[])', 'execute'), 'authenticated can';
  assert pg_get_function_result('public.get_conversation_customer_names(uuid[])'::regprocedure)
    = 'TABLE(conversation_id uuid, username text)', 'only conversation_id and username';
end $$;
set role anon;
do $$ begin
  begin
    perform public.get_conversation_customer_names(array['11111111-1111-4111-8111-000000000001']::uuid[]);
    raise exception 'anon was able to call it';
  exception when insufficient_privilege then
    null; -- expected
  end;
end $$;
reset role;

\echo 'all checks passed'
