-- Tests the new-message email migration (20261106120000_new_message_email.sql) on a throwaway
-- Postgres, with pg_net and Vault stubbed. Nothing here touches the real project.
--
-- Run from the repo root:
--   docker run -d --name nme-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec nme-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/new_message_email_trigger.sql
--   docker rm -f nme-pg
-- It stops at the first failed check; "all checks passed" at the end means everything held.

\set ON_ERROR_STOP on

-- Just enough of the live schema for the migration: roles, Vault, pg_net (stubbed) and the tables
create role anon;
create role authenticated;
create role service_role;
create schema vault;
create table vault.decrypted_secrets (name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('cron_shared_secret', 's3cret');
create schema net;
create table net.calls (url text, headers jsonb, body jsonb);
create table net.fail (on_ boolean);
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$
begin
  if exists (select 1 from net.fail) then raise exception 'pg_net is down'; end if;
  insert into net.calls values (url, headers, body);
  return 1;
end $$;
create table public.businesses (id bigint primary key, business_name text, contact_info jsonb);
create table public.conversations (id uuid primary key, business_id bigint, customer_id uuid, business_unread int not null default 0);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references public.conversations(id) on delete cascade,
  sender_id uuid, sender_role text, body text, read_at timestamptz, created_at timestamptz default now()
);
insert into public.businesses values (7, 'Harbour', '{}');
insert into public.conversations values ('11111111-1111-4111-8111-111111111111', 7, gen_random_uuid());

\i /app/supabase/migrations/20261106120000_new_message_email.sql
-- Applying it twice is harmless
\i /app/supabase/migrations/20261106120000_new_message_email.sql

-- 1. A customer message queues one request with its id and the secret header
insert into public.messages (id, conversation_id, sender_role, body)
values ('22222222-2222-4222-8222-000000000001', '11111111-1111-4111-8111-111111111111', 'customer', 'Hi');
do $$ begin
  assert (select count(*) from net.calls) = 1, 'a customer message queues one request';
  assert (select url from net.calls) = 'https://xvpwbocwasbtzrzrxyvu.supabase.co/functions/v1/notify-new-message', 'to notify-new-message';
  assert (select body from net.calls) = '{"message_id": "22222222-2222-4222-8222-000000000001"}'::jsonb, 'with the message id';
  assert (select headers->>'X-Cron-Secret' from net.calls) = 's3cret', 'with the cron secret from Vault';
  assert (select headers->>'Content-Type' from net.calls) = 'application/json', 'as JSON';
end $$;

-- 2. A business message queues nothing
insert into public.messages (conversation_id, sender_role, body) values ('11111111-1111-4111-8111-111111111111', 'business', 'Yes');
do $$ begin
  assert (select count(*) from net.calls) = 1, 'a business message queues nothing';
end $$;

-- 3. A failing http_post doesn't block the insert (it's raised as a warning)
insert into net.fail values (true);
insert into public.messages (id, conversation_id, sender_role, body)
values ('22222222-2222-4222-8222-000000000003', '11111111-1111-4111-8111-111111111111', 'customer', 'Still sends');
do $$ begin
  assert exists (select 1 from public.messages where id = '22222222-2222-4222-8222-000000000003'), 'the message is inserted anyway';
  assert (select count(*) from net.calls) = 1, 'and nothing was queued';
end $$;

-- 4. The column, the log table's RLS and grants, and the cascade
insert into public.message_email_log values ('11111111-1111-4111-8111-111111111111', now(), '22222222-2222-4222-8222-000000000001');
do $$ begin
  assert (select column_default from information_schema.columns where table_name = 'businesses' and column_name = 'notify_new_message_email') = 'true', 'defaults to true';
  assert (select is_nullable from information_schema.columns where table_name = 'businesses' and column_name = 'notify_new_message_email') = 'NO', 'not null';
  assert (select notify_new_message_email from public.businesses where id = 7), 'existing businesses get true';
  assert (select relrowsecurity from pg_class where relname = 'message_email_log'), 'message_email_log has RLS on';
  assert (select count(*) from pg_policies where tablename = 'message_email_log') = 0, 'and no policies';
  assert not has_table_privilege('authenticated', 'public.message_email_log', 'select'), 'authenticated has no access to it';
  assert not has_table_privilege('anon', 'public.message_email_log', 'select'), 'nor anon';
  assert not has_function_privilege('authenticated', 'public.notify_new_message()', 'execute'), 'nobody calls the trigger function directly';
end $$;
delete from public.conversations;
do $$ begin
  assert (select count(*) from public.message_email_log) = 0, 'log rows go with their conversation';
end $$;

\echo 'all checks passed'
