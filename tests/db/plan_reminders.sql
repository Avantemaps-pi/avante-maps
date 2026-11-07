-- Tests the plan reminders migration (20261107220000_plan_reminders.sql) on a throwaway Postgres,
-- with pg_net, pg_cron and Vault stubbed. Nothing here touches the real project.
--
-- Run from the repo root:
--   docker run -d --name pr-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec pr-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/plan_reminders.sql
--   docker rm -f pr-pg
-- It stops at the first failed check; "all checks passed" at the end means everything held.

\set ON_ERROR_STOP on

-- Just enough of the live schema: roles, Vault, pg_net (stubbed), the tables and the existing
-- verification trigger (the migration replaces its function)
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
create table public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid, type text, content text, read boolean default false,
  metadata jsonb, created_at timestamptz default now(), priority text default 'medium' check (priority in ('low', 'medium', 'high')),
  delivered_at timestamptz, read_at timestamptz, clicked_at timestamptz, delivery_status text default 'pending', click_url text
);
create table public.businesses (
  id integer primary key, owner_id uuid not null, business_name text not null, contact_info jsonb,
  pi_wallet_address text, contact_email_verified_for text, is_verified boolean default false, is_certified boolean default false
);
create table public.reviews (
  id uuid primary key default gen_random_uuid(), business_id integer not null, user_id uuid not null,
  rating integer not null, content text, created_at timestamptz default now()
);
create function public.notify_business_status_change() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger trigger_business_status_notification after update of is_verified, is_certified on public.businesses
  for each row execute function public.notify_business_status_change();

insert into public.businesses values
  (1, '00000000-0000-0000-0000-00000000000b', 'Harbour Light Coffee', '{"email": "Hello@Harbour.example"}',
   'GD7QABCDEFGHIJKLMNOPQRSTUVWXYZK2LM', 'hello@harbour.example', false, false),
  (2, '00000000-0000-0000-0000-00000000000b', 'Dock Road Deli', '{"email": "deli@harbour.example"}', null, null, false, false);

-- pg_cron, stubbed: like the real one it has cron.job, schedule and unschedule. Here a second
-- schedule with the same name adds a second row, so a missing guard would show
create schema cron;
create table cron.job (jobid serial primary key, jobname text, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid
$$;
create function cron.unschedule(job_name text) returns boolean language sql as $$
  delete from cron.job where jobname = job_name returning true
$$;

-- What #164 put live, which this migration builds on
\i /app/supabase/migrations/20261107180000_notification_events.sql

-- new_review notifications sent before this migration (one from a broken row without businessId)
insert into public.notifications (user_id, type, content, metadata, click_url) values
  ('00000000-0000-0000-0000-00000000000b', 'review', 'New review for Harbour Light Coffee: 5★',
   '{"kind": "new_review", "businessId": 1, "businessName": "Harbour Light Coffee", "actionLabel": "Reply to review", "rating": 5}', '/review/1'),
  ('00000000-0000-0000-0000-00000000000b', 'review', 'Broken', '{"kind": "new_review", "actionLabel": "Reply to review"}', '/review/1'),
  ('00000000-0000-0000-0000-00000000000b', 'business', 'Other', '{"kind": "verified", "businessId": 1, "actionLabel": "View verification"}', '/registered-business');

\i /app/supabase/migrations/20261107220000_plan_reminders.sql
-- Applying it twice is harmless: still one cron job
\i /app/supabase/migrations/20261107220000_plan_reminders.sql

-- 1. The cron job: one, daily at 06:10 UTC, calling plan-reminders with the cron secret from Vault
do $$ begin
  assert (select count(*) from cron.job where jobname = 'plan-reminders-daily') = 1, 'one plan-reminders-daily job after two applies';
  assert (select schedule from cron.job where jobname = 'plan-reminders-daily') = '10 6 * * *', '06:10 every day';
  assert (select command from cron.job where jobname = 'plan-reminders-daily') like '%functions/v1/plan-reminders%', 'calls plan-reminders';
  assert (select command from cron.job where jobname = 'plan-reminders-daily') like '%X-Cron-Secret%cron_shared_secret%', 'with the cron secret from Vault';
end $$;

-- 2. plan_reminder_log: service role only
do $$ begin
  assert (select relrowsecurity from pg_class where relname = 'plan_reminder_log'), 'RLS on';
  assert (select count(*) from pg_policies where tablename = 'plan_reminder_log') = 0, 'no policies';
  assert not has_table_privilege('authenticated', 'public.plan_reminder_log', 'select'), 'authenticated cannot read it';
  assert not has_table_privilege('anon', 'public.plan_reminder_log', 'select'), 'nor anon';
end $$;
insert into public.plan_reminder_log (subscription_id, kind) values (1, 'ending');
do $$ begin
  begin
    insert into public.plan_reminder_log (subscription_id, kind) values (1, 'ending');
    raise exception 'a second (1, ending) went in';
  exception when unique_violation then null;
  end;
  begin
    insert into public.plan_reminder_log (subscription_id, kind) values (1, 'later');
    raise exception 'an unknown kind went in';
  exception when check_violation then null;
  end;
end $$;
set role authenticated;
do $$ begin
  begin
    perform 1 from public.plan_reminder_log;
    raise exception 'authenticated read plan_reminder_log';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 3. Existing new_review notifications now say "See review" and open View Reviews
do $$ begin
  assert (select click_url from public.notifications where content = 'New review for Harbour Light Coffee: 5★') = '/review/1?tab=reviews', 'link updated';
  assert (select metadata->>'actionLabel' from public.notifications where content = 'New review for Harbour Light Coffee: 5★') = 'See review', 'label updated';
  assert (select (metadata->>'rating')::int from public.notifications where content = 'New review for Harbour Light Coffee: 5★') = 5, 'the rest of the metadata kept';
  assert (select click_url from public.notifications where content = 'Broken') = '/review/1', 'a row without businessId keeps its link';
  assert (select metadata->>'actionLabel' from public.notifications where content = 'Other') = 'View verification', 'other kinds untouched';
end $$;
delete from public.notifications;

-- 4. A new review: "See review", to the View Reviews tab
insert into public.reviews (business_id, user_id, rating, content) values (1, '00000000-0000-0000-0000-00000000000a', 4, 'Quick and friendly');
do $$
declare n public.notifications;
begin
  select * into n from public.notifications;
  assert (select count(*) from public.notifications) = 1, 'one notification';
  assert n.metadata->>'actionLabel' = 'See review', n.metadata::text;
  assert n.click_url = '/review/1?tab=reviews', n.click_url;
  assert n.content = 'New review for Harbour Light Coffee: 4★ “Quick and friendly”', n.content;
  assert n.metadata->>'kind' = 'new_review' and n.user_id = '00000000-0000-0000-0000-00000000000b', 'kind and owner';
end $$;
delete from public.notifications;

-- The owner reviewing their own business still creates nothing
insert into public.reviews (business_id, user_id, rating, content) values (1, '00000000-0000-0000-0000-00000000000b', 5, 'Mine');
do $$ begin
  assert (select count(*) from public.notifications) = 0, 'nothing for the owner''s own review';
end $$;

\echo 'all checks passed'
