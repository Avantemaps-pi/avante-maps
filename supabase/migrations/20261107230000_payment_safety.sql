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
