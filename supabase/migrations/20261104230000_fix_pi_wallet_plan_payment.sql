-- Fixes paying a plan with the Pi Wallet, which charged the user and granted no plan.
--
-- enforce_subscription_payment looked for status->>'developer_completed' or 'transaction_verified',
-- but complete-payment writes 'completed' and 'verified', so no Pi payment could ever pass it. It
-- now accepts those keys too. Nothing else in the function changes; the debit from the balance
-- added in 20261104210000 stays.
--
-- "Users can create their own payments" and "Users can update their own payments" let anyone write
-- a row with any status and metadata, so with the trigger fixed they could forge a completed
-- payment. The app never writes payments from the browser (the edge functions do, with the service
-- role), so they go. The SELECT policies stay.
--
-- payments.approved_amount_pi is the Pi amount approve-payment checked against the plan price.
-- complete-payment checks against it instead of re-reading pi_price, so a price move after approval
-- can't refuse a payment the user has already signed.

begin;

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
          and (p.status->>'completed' = 'true'
               or p.status->>'verified' = 'true'
               or p.status->>'developer_completed' = 'true'
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

drop policy if exists "Users can create their own payments" on public.payments;
drop policy if exists "Users can update their own payments" on public.payments;

alter table public.payments add column if not exists approved_amount_pi numeric null;

comment on column public.payments.approved_amount_pi is
  'The Pi amount approve-payment checked against the plan price. Only the service role writes it: users have no INSERT or UPDATE policy on this table.';

commit;
