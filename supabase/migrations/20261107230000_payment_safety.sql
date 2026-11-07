-- Payment safety: credits and plans can't be granted twice.
--
-- credit_wallet_balance checked for an existing ledger row and then inserted, so two concurrent
-- calls for one payment made the second raise 23505 (wallet_ledger.payment_id is unique), and
-- complete-payment reported "wallet credit failed" for a payment that had been credited. It now
-- inserts with on conflict do nothing and returns the balance either way.
--
-- handle_subscription_after_payment didn't know which payment it was granting for, so two
-- completions of one payment (or the recovery path racing the normal one) granted twice: an extra
-- subscriptions row and a second "plan paid" notification. It now takes the payment id, stores it
-- on the subscription (unique), and returns false when that payment already granted one. The
-- 5-argument version is dropped so there's one function; pay_plan_from_balance's 5-argument call
-- resolves to it (p_payment_id defaults to null: today's behaviour, under its own ledger check and
-- per-user lock).
--
-- All three stay service role only.

-- 1. credit_wallet_balance: race-safe, same signature

create or replace function public.credit_wallet_balance(
  p_user_id uuid,
  p_amount_pi numeric,
  p_payment_id text,
  p_transaction_type text default 'deposit'
)
returns numeric
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_amount_pi <= 0 then
    raise exception 'credit_wallet_balance: amount must be positive';
  end if;

  -- A second call for the same payment (a retry, or a racing duplicate) credits nothing more
  insert into public.wallet_ledger (user_id, amount_pi, transaction_type, payment_id)
  values (p_user_id, p_amount_pi, p_transaction_type, p_payment_id)
  on conflict (payment_id) do nothing;

  return coalesce((select sum(amount_pi) from public.wallet_ledger where user_id = p_user_id), 0);
end;
$function$;

revoke all on function public.credit_wallet_balance(uuid, numeric, text, text) from public, anon, authenticated;
grant execute on function public.credit_wallet_balance(uuid, numeric, text, text) to service_role;

-- 2. One plan per payment

alter table public.subscriptions add column if not exists payment_id text;
create unique index if not exists subscriptions_payment_id_uidx
  on public.subscriptions (payment_id) where payment_id is not null;

create or replace function public.handle_subscription_after_payment(
  p_user_id uuid,
  p_username text,
  p_email text,
  p_subscription_tier text,
  p_frequency text default 'monthly',
  p_payment_id text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_subscription_start timestamp;
  v_subscription_end timestamp;
begin
  if p_payment_id is not null then
    -- The per-user lock pay_plan_from_balance and debit_wallet_balance take: a second call for this
    -- payment waits for the first, then finds its subscription
    perform pg_advisory_xact_lock(hashtext(p_user_id::text));
    if exists (select 1 from public.subscriptions where payment_id = p_payment_id) then
      return false;
    end if;
  end if;

  v_subscription_start := now();
  v_subscription_end := now() + case when p_frequency = 'annual' then interval '1 year' else interval '1 month' end;

  -- Never changes an existing user's username or email
  insert into public.users (id, username, email, subscription, created_at)
  values (p_user_id, coalesce(p_username, 'user_' || left(p_user_id::text, 8)), p_email, p_subscription_tier, now())
  on conflict (id)
  do update set subscription = excluded.subscription;

  -- End any existing active subscriptions for this user
  update public.subscriptions
  set end_date = now()
  where user_id = p_user_id
    and end_date > now();

  insert into public.subscriptions (user_id, plan, start_date, end_date, payment_id)
  values (p_user_id, p_subscription_tier, v_subscription_start, v_subscription_end, p_payment_id);

  raise log 'Subscription created for user % with plan % from % to %',
    p_user_id, p_subscription_tier, v_subscription_start, v_subscription_end;
  return true;
end;
$function$;

drop function if exists public.handle_subscription_after_payment(uuid, text, text, text, text);

revoke all on function public.handle_subscription_after_payment(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.handle_subscription_after_payment(uuid, text, text, text, text, text) to service_role;
