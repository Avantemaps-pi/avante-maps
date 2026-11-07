-- Tests the notification events migration (20261107180000_notification_events.sql) on a throwaway
-- Postgres, with pg_net and Vault stubbed. Nothing here touches the real project.
--
-- Run from the repo root:
--   docker run -d --name ne-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec ne-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/notification_events.sql
--   docker rm -f ne-pg
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

\i /app/supabase/migrations/20261107180000_notification_events.sql
-- Applying it twice is harmless
\i /app/supabase/migrations/20261107180000_notification_events.sql

-- 1. A changed payout wallet: the notification, and the email request to the email confirmed before
update public.businesses set pi_wallet_address = 'GNEWWALLETADDRESS1234567890XYZ9QR7' where id = 1;
do $$
declare n public.notifications;
begin
  select * into n from public.notifications;
  assert (select count(*) from public.notifications) = 1, 'one notification';
  assert n.user_id = '00000000-0000-0000-0000-00000000000b', 'to the owner';
  assert n.type = 'business' and n.metadata->>'kind' = 'payout_wallet_changed', 'business / payout_wallet_changed';
  assert n.priority = 'high', 'high priority';
  assert n.content = 'The payout wallet for Harbour Light Coffee changed to GNEW…9QR7. Wasn''t you? Check your business now.', n.content;
  assert n.click_url = '/update-registration/1?field=piWalletAddress', n.click_url;
  assert n.metadata->>'actionLabel' = 'Check payout wallet', 'action label';
  assert (n.metadata->>'businessId')::int = 1 and n.metadata->>'businessName' = 'Harbour Light Coffee', 'business in metadata';
  assert n.delivery_status = 'delivered' and n.delivered_at is not null and n.read = false, 'delivered, unread';
  assert (select count(*) from net.calls) = 1, 'one email request';
  assert (select url from net.calls) = 'https://xvpwbocwasbtzrzrxyvu.supabase.co/functions/v1/notify-account-event', 'to notify-account-event';
  assert (select body from net.calls) = '{"kind": "payout_wallet_changed", "business_id": 1, "old_confirmed_email": "hello@harbour.example"}'::jsonb,
    (select body::text from net.calls);
  assert (select headers->>'X-Cron-Secret' from net.calls) = 's3cret', 'with the cron secret';
end $$;
delete from public.notifications; delete from net.calls;

-- 2. Wallet and email changed together (the confirmation is cleared in the same save): the email
--    request still names the email confirmed BEFORE the save
update public.businesses
  set pi_wallet_address = 'GTHIEFWALLET0000000000000000000000', contact_info = '{"email": "thief@example.com"}', contact_email_verified_for = null
  where id = 1;
do $$ begin
  assert (select body->>'old_confirmed_email' from net.calls) = 'hello@harbour.example', 'the old confirmed email';
  assert (select count(*) from public.notifications where metadata->>'kind' = 'payout_wallet_changed') = 1, 'the wallet notification';
  assert (select count(*) from public.notifications where metadata->>'kind' = 'contact_email_changed') = 1, 'and the email one';
end $$;
delete from public.notifications; delete from net.calls;

-- 3. A changed contact email on its own
update public.businesses set contact_info = '{"email": "orders@deli.example"}' where id = 2;
do $$
declare n public.notifications;
begin
  select * into n from public.notifications;
  assert (select count(*) from public.notifications) = 1, 'one notification';
  assert n.type = 'business' and n.metadata->>'kind' = 'contact_email_changed', 'business / contact_email_changed';
  assert n.content = 'The contact email for Dock Road Deli changed. Verification is paused until you confirm the new email.', n.content;
  assert n.click_url = '/communicon?confirm=1', n.click_url;
  assert n.metadata->>'actionLabel' = 'Confirm email', 'action label';
  assert (select count(*) from net.calls) = 0, 'no email request for an email change';
end $$;
delete from public.notifications;

-- 4. Nothing for unchanged fields: the same values saved again, a case/space-only email change,
--    another column, or a first wallet (no old one)
update public.businesses set pi_wallet_address = pi_wallet_address, contact_info = contact_info where id = 1;
update public.businesses set contact_info = '{"email": " ORDERS@deli.example "}' where id = 2;
update public.businesses set business_name = 'Dock Road Deli & Grill' where id = 2;
update public.businesses set pi_wallet_address = 'GFIRSTWALLET000000000000000000000' where id = 2;
do $$ begin
  assert (select count(*) from public.notifications) = 0, 'no notifications';
  assert (select count(*) from net.calls) = 0, 'no email requests';
end $$;

-- 5. A failing http_post doesn't block the save (the notification still goes in)
insert into net.fail values (true);
update public.businesses set pi_wallet_address = 'GAFTERFAILURE00000000000000000000' where id = 2;
do $$ begin
  assert (select pi_wallet_address from public.businesses where id = 2) = 'GAFTERFAILURE00000000000000000000', 'saved';
  assert (select count(*) from public.notifications where metadata->>'kind' = 'payout_wallet_changed') = 1, 'notified';
end $$;
delete from net.fail; delete from public.notifications;

-- 6. Nor does a failing notification
alter table public.notifications rename to notifications_away;
update public.businesses set pi_wallet_address = 'GNONOTIFICATION00000000000000000' where id = 2;
alter table public.notifications_away rename to notifications;
do $$ begin
  assert (select pi_wallet_address from public.businesses where id = 2) = 'GNONOTIFICATION00000000000000000', 'saved without the notifications table';
end $$;
delete from net.calls;

-- 7. A new review notifies the owner, with the rating and the start of the text
insert into public.reviews (business_id, user_id, rating, content)
values (1, '00000000-0000-0000-0000-00000000000a', 5, repeat('Lovely coffee. ', 10));
do $$
declare n public.notifications;
begin
  select * into n from public.notifications;
  assert (select count(*) from public.notifications) = 1, 'one notification';
  assert n.user_id = '00000000-0000-0000-0000-00000000000b', 'to the owner';
  assert n.type = 'review' and n.metadata->>'kind' = 'new_review', 'review / new_review';
  assert n.content = 'New review for Harbour Light Coffee: 5★ “' || rtrim(left(repeat('Lovely coffee. ', 10), 120)) || '…”', n.content;
  assert (n.metadata->>'rating')::int = 5, 'rating';
  assert n.metadata->>'actionLabel' = 'Reply to review', 'action label';
  assert n.click_url = '/review/1', n.click_url;
end $$;
delete from public.notifications;

-- A short review is quoted whole; a review without text has no quote
insert into public.reviews (business_id, user_id, rating, content) values (1, '00000000-0000-0000-0000-00000000000a', 4, '  Quick and friendly ');
insert into public.reviews (business_id, user_id, rating, content) values (1, '00000000-0000-0000-0000-00000000000c', 3, null);
do $$ begin
  assert exists (select 1 from public.notifications where content = 'New review for Harbour Light Coffee: 4★ “Quick and friendly”'), 'short review quoted';
  assert exists (select 1 from public.notifications where content = 'New review for Harbour Light Coffee: 3★'), 'no text, no quote';
end $$;
delete from public.notifications;

-- The owner reviewing their own business: nothing
insert into public.reviews (business_id, user_id, rating, content) values (1, '00000000-0000-0000-0000-00000000000b', 5, 'Mine');
do $$ begin
  assert (select count(*) from public.notifications) = 0, 'no notification for the owner''s own review';
end $$;

-- 8. Verified and certified: the same content as before, now with the kind, action and link
update public.businesses set is_verified = true where id = 1;
update public.businesses set is_certified = true where id = 1;
do $$ begin
  assert exists (select 1 from public.notifications where type = 'verification' and metadata->>'kind' = 'verified'
    and click_url = '/registered-business' and metadata->>'actionLabel' = 'View verification' and priority = 'high'
    and content = 'Congratulations! Your business "Harbour Light Coffee" has been verified. You now have a verified badge.'), 'verified';
  assert exists (select 1 from public.notifications where type = 'certification' and metadata->>'kind' = 'certified'
    and click_url = '/registered-business' and metadata->>'actionLabel' = 'View verification'
    and content = 'Amazing! Your business "Harbour Light Coffee" has been certified. You now have a certified badge!'), 'certified';
  assert (select count(*) from public.notifications) = 2, 'one each';
end $$;
update public.businesses set is_verified = true where id = 1;
do $$ begin
  assert (select count(*) from public.notifications) = 2, 'staying verified notifies nothing';
end $$;

-- 9. create_notification is the service role's only
do $$ begin
  assert not has_function_privilege('authenticated', 'public.create_notification(uuid, text, text, text, jsonb, text, text)', 'execute'), 'not authenticated';
  assert not has_function_privilege('anon', 'public.create_notification(uuid, text, text, text, jsonb, text, text)', 'execute'), 'not anon';
  assert has_function_privilege('service_role', 'public.create_notification(uuid, text, text, text, jsonb, text, text)', 'execute'), 'service_role';
end $$;
do $$
declare v_id uuid;
begin
  v_id := public.create_notification('00000000-0000-0000-0000-00000000000b', 'system', 'business_registered', 'Hi', '{"kind": "spoofed", "a": 1}', null);
  assert (select metadata->>'kind' from public.notifications where id = v_id) = 'business_registered', 'p_kind wins over a kind in p_metadata';
  assert (select (metadata->>'a')::int from public.notifications where id = v_id) = 1, 'the rest of p_metadata kept';
  assert (select priority from public.notifications where id = v_id) = 'medium', 'medium by default';
end $$;
set role authenticated;
do $$ begin
  begin
    perform public.create_notification('00000000-0000-0000-0000-00000000000b', 'system', 'x', 'y', '{}', null);
    raise exception 'authenticated was able to call it';
  exception when insufficient_privilege then
    null; -- expected
  end;
end $$;
reset role;

\echo 'all checks passed'
