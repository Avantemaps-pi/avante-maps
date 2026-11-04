-- Lets a plan be paid from the Avante Maps balance, and fixes how plans are recorded.
--
-- handle_subscription_after_payment had two bugs. It always ended the plan after 1 month, annual
-- too. And on conflict it overwrote users.username and users.email with what complete-payment
-- passed, which for today's client is a made-up user_<id> and <username>@pi.app. It now takes
-- p_frequency, and on conflict only sets subscription. The default on p_frequency keeps the
-- deployed complete-payment's 4-argument call working until it's redeployed.
--
-- pay_plan_from_balance debits the balance and grants the plan in one transaction, so a failure in
-- either keeps nothing. It's idempotent on the ledger reference plan:{tier}:{frequency}:{request_id},
-- and the unique index below means a race can't debit twice.
--
-- enforce_subscription_payment refused any plan without a completed row in payments, which a
-- balance payment doesn't have, so every balance payment would have rolled back. A debit from the
-- balance for that plan now counts as well. Nothing else in the function changes.

begin;

drop function if exists public.handle_subscription_after_payment(uuid, text, text, text);

create function public.handle_subscription_after_payment(
  p_user_id uuid,
  p_username text,
  p_email text,
  p_subscription_tier text,
  p_frequency text default 'monthly'
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_subscription_start timestamp;
  v_subscription_end timestamp;
begin
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

  insert into public.subscriptions (user_id, plan, start_date, end_date)
  values (p_user_id, p_subscription_tier, v_subscription_start, v_subscription_end);

  raise log 'Subscription created for user % with plan % from % to %',
    p_user_id, p_subscription_tier, v_subscription_start, v_subscription_end;
end;
$function$;

revoke execute on function public.handle_subscription_after_payment(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.handle_subscription_after_payment(uuid, text, text, text, text) to service_role;

create or replace function public.enforce_subscription_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  is_service_role boolean;
  has_completed_payment boolean;
begin
  is_service_role := (current_setting('request.jwt.claim.role', true) = 'service_role')
                     or (current_user = 'service_role')
                     or (current_user = 'postgres')
                     or (current_user = 'supabase_admin');

  if not is_service_role then
    raise exception 'subscriptions can only be modified by the server after payment validation';
  end if;

  -- Require at least one completed payment by this user that references a
  -- subscription plan in its metadata, or a debit from their balance for the plan.
  -- Skip for downgrade-to-individual rows (free tier) and for end_date-only
  -- updates (cancellations/expirations).
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.plan is distinct from old.plan and new.plan <> 'individual') then
    if new.plan is not null and new.plan <> 'individual' then
      select exists (
        select 1
        from public.payments p
        where p.user_id = new.user_id
          and (p.status->>'developer_completed' = 'true'
               or p.status->>'transaction_verified' = 'true')
          and (p.metadata->>'plan' = new.plan
               or p.metadata->>'subscriptionTier' = new.plan
               or p.metadata->>'tier' = new.plan)
      ) or exists (
        select 1
        from public.wallet_ledger l
        where l.user_id = new.user_id
          and l.transaction_type = 'subscription'
          and l.amount_pi < 0
          and l.reference_id like 'plan:' || new.plan || ':%'
      ) into has_completed_payment;

      if not has_completed_payment then
        raise exception 'No completed payment found for user % and plan %', new.user_id, new.plan;
      end if;
    end if;
  end if;

  return new;
end;
$function$;

create unique index if not exists wallet_ledger_reference_id_key
  on public.wallet_ledger (reference_id)
  where reference_id is not null;

create function public.pay_plan_from_balance(
  p_user_id uuid,
  p_tier text,
  p_frequency text,
  p_amount_pi numeric,
  p_request_id text
)
returns numeric
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_reference text;
begin
  -- Not the default P0001, which is what an insufficient balance raises
  if p_tier is null or p_tier not in ('small-business', 'organization') then
    raise exception 'pay_plan_from_balance: invalid tier' using errcode = '22023';
  end if;
  if p_frequency is null or p_frequency not in ('monthly', 'annual') then
    raise exception 'pay_plan_from_balance: invalid frequency' using errcode = '22023';
  end if;
  if p_amount_pi is null or p_amount_pi <= 0 then
    raise exception 'pay_plan_from_balance: amount must be positive' using errcode = '22023';
  end if;
  if coalesce(btrim(p_request_id), '') = '' then
    raise exception 'pay_plan_from_balance: request id is required' using errcode = '22023';
  end if;

  v_reference := 'plan:' || p_tier || ':' || p_frequency || ':' || p_request_id;

  -- The same per-user lock debit_wallet_balance takes, so a retry racing the first attempt waits
  -- and then finds its ledger row, rather than failing on the unique index
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  if exists (select 1 from public.wallet_ledger where user_id = p_user_id and reference_id = v_reference) then
    return (select coalesce(sum(amount_pi), 0) from public.wallet_ledger where user_id = p_user_id);
  end if;

  perform public.debit_wallet_balance(p_user_id, p_amount_pi, 'subscription', v_reference);
  perform public.handle_subscription_after_payment(p_user_id, null, null, p_tier, p_frequency);

  return (select coalesce(sum(amount_pi), 0) from public.wallet_ledger where user_id = p_user_id);
end;
$function$;

revoke execute on function public.pay_plan_from_balance(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.pay_plan_from_balance(uuid, text, text, numeric, text) to service_role;

commit;
