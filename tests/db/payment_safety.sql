-- Tests the payment safety migration (20261107230000_payment_safety.sql) on a throwaway Postgres.
-- Concurrent calls run on two dblink connections, the first holding its transaction open while the
-- second makes the same call. Nothing here touches the real project.
--
-- Run from the repo root:
--   docker run -d --name ps-pg -e POSTGRES_PASSWORD=x -v "$PWD:/app" postgres:16
--   docker exec ps-pg psql -U postgres -v ON_ERROR_STOP=1 -f /app/tests/db/payment_safety.sql
--   docker rm -f ps-pg
-- It stops at the first failed check; "all checks passed" at the end means everything held.

\set ON_ERROR_STOP on

create extension dblink;
create role anon;
create role authenticated;
create role service_role;

-- The tables and the live functions as they are before the migration (7 Nov)
create table public.users (id uuid primary key, username text, email text, subscription text, created_at timestamp);
create table public.subscriptions (
  id serial primary key, user_id uuid not null references public.users(id) on delete cascade,
  plan text check (plan in ('individual', 'small-business', 'organization')),
  start_date timestamp default now(), end_date timestamp
);
create table public.wallet_ledger (
  id bigserial primary key, user_id uuid not null, amount_pi numeric not null, transaction_type text not null,
  payment_id text unique, reference_id text, created_at timestamptz not null default now()
);
create unique index wallet_ledger_reference_id_key on public.wallet_ledger (reference_id) where reference_id is not null;

create function public.credit_wallet_balance(p_user_id uuid, p_amount_pi numeric, p_payment_id text, p_transaction_type text default 'deposit')
returns numeric language plpgsql security definer set search_path to 'public' as $function$
declare v_existing_id bigint; v_balance numeric;
begin
  if p_amount_pi <= 0 then raise exception 'credit_wallet_balance: amount must be positive'; end if;
  select id into v_existing_id from public.wallet_ledger where payment_id = p_payment_id;
  if v_existing_id is not null then
    return coalesce((select sum(amount_pi) from public.wallet_ledger where user_id = p_user_id), 0);
  end if;
  insert into public.wallet_ledger (user_id, amount_pi, transaction_type, payment_id) values (p_user_id, p_amount_pi, p_transaction_type, p_payment_id);
  select sum(amount_pi) into v_balance from public.wallet_ledger where user_id = p_user_id;
  return v_balance;
end; $function$;

create function public.handle_subscription_after_payment(p_user_id uuid, p_username text, p_email text, p_subscription_tier text, p_frequency text default 'monthly')
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  insert into public.users (id, username, email, subscription, created_at)
  values (p_user_id, coalesce(p_username, 'user_' || left(p_user_id::text, 8)), p_email, p_subscription_tier, now())
  on conflict (id) do update set subscription = excluded.subscription;
  update public.subscriptions set end_date = now() where user_id = p_user_id and end_date > now();
  insert into public.subscriptions (user_id, plan, start_date, end_date)
  values (p_user_id, p_subscription_tier, now(), now() + case when p_frequency = 'annual' then interval '1 year' else interval '1 month' end);
end; $function$;

create function public.debit_wallet_balance(p_user_id uuid, p_amount_pi numeric, p_transaction_type text, p_reference_id text default null)
returns numeric language plpgsql security definer set search_path to 'public' as $function$
declare v_balance numeric;
begin
  if p_amount_pi <= 0 then raise exception 'debit_wallet_balance: amount must be positive'; end if;
  if p_transaction_type = 'deposit' then raise exception 'debit_wallet_balance: transaction_type cannot be deposit'; end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select coalesce(sum(amount_pi), 0) into v_balance from public.wallet_ledger where user_id = p_user_id;
  if v_balance < p_amount_pi then
    raise exception 'debit_wallet_balance: insufficient balance (have %, need %)', v_balance, p_amount_pi using errcode = 'P0001';
  end if;
  insert into public.wallet_ledger (user_id, amount_pi, transaction_type, reference_id) values (p_user_id, -p_amount_pi, p_transaction_type, p_reference_id);
  return v_balance - p_amount_pi;
end; $function$;

create function public.pay_plan_from_balance(p_user_id uuid, p_tier text, p_frequency text, p_amount_pi numeric, p_request_id text)
returns numeric language plpgsql security definer set search_path to 'public' as $function$
declare v_reference text;
begin
  if p_tier is null or p_tier not in ('small-business', 'organization') then raise exception 'pay_plan_from_balance: invalid tier' using errcode = '22023'; end if;
  if p_frequency is null or p_frequency not in ('monthly', 'annual') then raise exception 'pay_plan_from_balance: invalid frequency' using errcode = '22023'; end if;
  if p_amount_pi is null or p_amount_pi <= 0 then raise exception 'pay_plan_from_balance: amount must be positive' using errcode = '22023'; end if;
  if coalesce(btrim(p_request_id), '') = '' then raise exception 'pay_plan_from_balance: request id is required' using errcode = '22023'; end if;
  v_reference := 'plan:' || p_tier || ':' || p_frequency || ':' || p_request_id;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  if exists (select 1 from public.wallet_ledger where user_id = p_user_id and reference_id = v_reference) then
    return (select coalesce(sum(amount_pi), 0) from public.wallet_ledger where user_id = p_user_id);
  end if;
  perform public.debit_wallet_balance(p_user_id, p_amount_pi, 'subscription', v_reference);
  perform public.handle_subscription_after_payment(p_user_id, null, null, p_tier, p_frequency);
  return (select coalesce(sum(amount_pi), 0) from public.wallet_ledger where user_id = p_user_id);
end; $function$;

revoke all on function public.credit_wallet_balance(uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.handle_subscription_after_payment(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.debit_wallet_balance(uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.pay_plan_from_balance(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.credit_wallet_balance(uuid, numeric, text, text) to service_role;
grant execute on function public.handle_subscription_after_payment(uuid, text, text, text, text) to service_role;
grant execute on function public.debit_wallet_balance(uuid, numeric, text, text) to service_role;
grant execute on function public.pay_plan_from_balance(uuid, text, text, numeric, text) to service_role;

insert into public.users values
  ('00000000-0000-0000-0000-00000000000a', 'alice', null, 'individual', now()),
  ('00000000-0000-0000-0000-00000000000b', 'bob', null, 'individual', now()),
  ('00000000-0000-0000-0000-00000000000c', 'carol', null, 'individual', now());

\i /app/supabase/migrations/20261107230000_payment_safety.sql
-- Applying it twice is harmless
\i /app/supabase/migrations/20261107230000_payment_safety.sql

create table public.race_results (who text, granted boolean);
create table public.credit_results (who text, balance numeric);
select dblink_connect('first', 'dbname=postgres user=postgres');
select dblink_connect('second', 'dbname=postgres user=postgres');

-- 1. Two concurrent grants for one payment: one subscription, and one of them returns false
select dblink_send_query('first', $q$
  with g as (select public.handle_subscription_after_payment('00000000-0000-0000-0000-00000000000a', null, null, 'small-business', 'monthly', 'pay-1') as granted)
  insert into public.race_results select 'first', granted from g, lateral (select pg_sleep(1.5) where g.granted is not null) hold
$q$);
select pg_sleep(0.4);
select dblink_send_query('second', $q$
  insert into public.race_results select 'second', public.handle_subscription_after_payment('00000000-0000-0000-0000-00000000000a', null, null, 'small-business', 'monthly', 'pay-1')
$q$);
select * from dblink_get_result('first') as t(status text);
select * from dblink_get_result('second') as t(status text);
-- dblink needs one more call per query, which returns an empty set, before a connection is reused
select * from dblink_get_result('first') as t(status text);
select * from dblink_get_result('second') as t(status text);
do $$ begin
  assert (select count(*) from public.race_results) = 2, 'both calls finished, neither raised';
  assert (select granted from public.race_results where who = 'first'), 'the first granted';
  assert (select not granted from public.race_results where who = 'second'), 'the second returned false';
  assert (select count(*) from public.subscriptions where payment_id = 'pay-1') = 1, 'one subscription for the payment';
  assert (select count(*) from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000a') = 1, 'and no other';
  assert (select subscription from public.users where id = '00000000-0000-0000-0000-00000000000a') = 'small-business', 'the plan is set';
end $$;

-- Again later, the same payment: false, nothing new
do $$ begin
  assert not public.handle_subscription_after_payment('00000000-0000-0000-0000-00000000000a', null, null, 'small-business', 'monthly', 'pay-1'), 'false again';
  assert (select count(*) from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000a') = 1, 'still one';
end $$;

-- 2. Without a payment id: today's behaviour, granted each time
do $$ begin
  assert public.handle_subscription_after_payment('00000000-0000-0000-0000-00000000000b', null, null, 'organization', 'annual'), 'granted';
  assert (select count(*) from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000b' and payment_id is null) = 1, 'one row, no payment id';
  assert (select end_date::date from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000b') = (now() + interval '1 year')::date, 'annual';
end $$;

-- 3. pay_plan_from_balance still works (its 5-argument call resolves to the new function)
do $$
declare v_left numeric;
begin
  perform public.credit_wallet_balance('00000000-0000-0000-0000-00000000000c', 100, 'topup-c', 'deposit');
  v_left := public.pay_plan_from_balance('00000000-0000-0000-0000-00000000000c', 'small-business', 'monthly', 65.19, 'req-1');
  assert v_left = 34.81, 'balance after the plan: ' || v_left;
  assert (select subscription from public.users where id = '00000000-0000-0000-0000-00000000000c') = 'small-business', 'plan set';
  assert (select count(*) from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000c') = 1, 'one subscription';
  -- A retry with the same request id: nothing more
  v_left := public.pay_plan_from_balance('00000000-0000-0000-0000-00000000000c', 'small-business', 'monthly', 65.19, 'req-1');
  assert v_left = 34.81, 'idempotent';
  assert (select count(*) from public.subscriptions where user_id = '00000000-0000-0000-0000-00000000000c') = 1, 'still one';
end $$;

-- 4. Two concurrent credits for one payment: one ledger row, and neither raises
select dblink_send_query('first', $q$
  with c as (select public.credit_wallet_balance('00000000-0000-0000-0000-00000000000b', 10, 'pay-c', 'deposit') as balance)
  insert into public.credit_results select 'first', balance from c, lateral (select pg_sleep(1.5) where c.balance is not null) hold
$q$);
select pg_sleep(0.4);
select dblink_send_query('second', $q$
  insert into public.credit_results select 'second', public.credit_wallet_balance('00000000-0000-0000-0000-00000000000b', 10, 'pay-c', 'deposit')
$q$);
select * from dblink_get_result('first') as t(status text);
select * from dblink_get_result('second') as t(status text);
-- dblink needs one more call per query, which returns an empty set, before a connection is reused
select * from dblink_get_result('first') as t(status text);
select * from dblink_get_result('second') as t(status text);
do $$ begin
  assert (select count(*) from public.credit_results) = 2, 'both calls finished, neither raised';
  assert (select count(*) from public.wallet_ledger where payment_id = 'pay-c') = 1, 'credited once';
  assert (select balance from public.credit_results where who = 'second') = 10, 'the second returns the balance';
  assert public.credit_wallet_balance('00000000-0000-0000-0000-00000000000b', 10, 'pay-c', 'deposit') = 10, 'a later retry: the balance, no new row';
  assert (select count(*) from public.wallet_ledger where payment_id = 'pay-c') = 1, 'still once';
end $$;
select dblink_disconnect('first');
select dblink_disconnect('second');

-- Still refuses nothing-amounts
do $$ begin
  begin
    perform public.credit_wallet_balance('00000000-0000-0000-0000-00000000000b', 0, 'pay-zero', 'deposit');
    raise exception 'a zero credit went in';
  exception when raise_exception then
    if sqlerrm not like 'credit_wallet_balance: amount must be positive%' then raise; end if;
  end;
end $$;

-- 5. One handle_subscription_after_payment, and none of the three is executable by anon or authenticated
do $$ begin
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'handle_subscription_after_payment') = 1, 'one function';
  assert pg_get_function_result('public.handle_subscription_after_payment(uuid, text, text, text, text, text)'::regprocedure) = 'boolean', 'returns boolean';
  assert not has_function_privilege('authenticated', 'public.handle_subscription_after_payment(uuid, text, text, text, text, text)', 'execute'), 'grant fn: not authenticated';
  assert not has_function_privilege('anon', 'public.handle_subscription_after_payment(uuid, text, text, text, text, text)', 'execute'), 'grant fn: not anon';
  assert not has_function_privilege('authenticated', 'public.credit_wallet_balance(uuid, numeric, text, text)', 'execute'), 'credit: not authenticated';
  assert not has_function_privilege('anon', 'public.credit_wallet_balance(uuid, numeric, text, text)', 'execute'), 'credit: not anon';
  assert not has_function_privilege('authenticated', 'public.pay_plan_from_balance(uuid, text, text, numeric, text)', 'execute'), 'pay_plan: not authenticated';
  assert has_function_privilege('service_role', 'public.handle_subscription_after_payment(uuid, text, text, text, text, text)', 'execute'), 'service_role: grant fn';
  assert has_function_privilege('service_role', 'public.credit_wallet_balance(uuid, numeric, text, text)', 'execute'), 'service_role: credit';
end $$;
set role authenticated;
do $$ begin
  begin
    perform public.credit_wallet_balance('00000000-0000-0000-0000-00000000000b', 5, 'pay-x', 'deposit');
    raise exception 'authenticated credited a wallet';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- 6. The unique index backs it up: a second subscription for one payment is refused outright
do $$ begin
  begin
    insert into public.subscriptions (user_id, plan, payment_id) values ('00000000-0000-0000-0000-00000000000a', 'small-business', 'pay-1');
    raise exception 'a second subscription for pay-1 went in';
  exception when unique_violation then null;
  end;
end $$;

\echo 'all checks passed'
