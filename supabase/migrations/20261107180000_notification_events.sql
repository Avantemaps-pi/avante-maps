-- In-app notifications for what a business owner needs to hear about: payout wallet and contact
-- email changes, new reviews, and verification / certification (messages and payments are
-- notified by their edge functions).
--
-- Every new notification follows the metadata contract the Notifications page reads:
-- metadata.kind, businessId, businessName, actionLabel (and emailed when an email went too), with
-- click_url the action's in-app path. content stays a full plain-text sentence for older clients.
--
-- create_notification: the one way these triggers insert, service role only (RLS lets only the
-- service role insert notifications; the trigger functions run as their owner).
--
-- Nothing here can block the save that fires it: each notification, and the payout email request,
-- is wrapped so a failure is only raised as a warning.

-- 1. The helper

create or replace function public.create_notification(
  p_user_id uuid,
  p_type text,
  p_kind text,
  p_content text,
  p_metadata jsonb,
  p_click_url text,
  p_priority text default 'medium'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_id uuid;
begin
  insert into public.notifications (user_id, type, content, metadata, priority, read, delivery_status, delivered_at, click_url)
  values (
    p_user_id,
    p_type,
    p_content,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('kind', p_kind),
    coalesce(p_priority, 'medium'),
    false,
    'delivered',
    now(),
    p_click_url
  )
  returning id into v_id;
  return v_id;
end
$f$;

revoke all on function public.create_notification(uuid, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.create_notification(uuid, text, text, text, jsonb, text, text) to service_role;

-- 2. Payout wallet and contact email changes
--
-- A changed payout wallet is notified in the app and emailed (notify-account-event) to the contact
-- email that was confirmed BEFORE this save: someone who changes the wallet and the email together
-- can't send the warning to themselves. A changed contact email pauses verification until it's
-- confirmed again (verify-business compares it with contact_email_verified_for).

create or replace function public.notify_business_account_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_new_wallet text := nullif(trim(coalesce(new.pi_wallet_address, '')), '');
  v_short text;
begin
  if old.pi_wallet_address is not null and new.pi_wallet_address is distinct from old.pi_wallet_address then
    begin
      v_short := case
        when v_new_wallet is null then null
        when length(v_new_wallet) <= 10 then v_new_wallet
        else left(v_new_wallet, 4) || '…' || right(v_new_wallet, 4)
      end;
      perform public.create_notification(
        new.owner_id,
        'business',
        'payout_wallet_changed',
        case
          when v_short is null then 'The payout wallet for ' || new.business_name || ' was removed. Wasn''t you? Check your business now.'
          else 'The payout wallet for ' || new.business_name || ' changed to ' || v_short || '. Wasn''t you? Check your business now.'
        end,
        jsonb_build_object('businessId', new.id, 'businessName', new.business_name, 'actionLabel', 'Check payout wallet',
          'emailed', old.contact_email_verified_for is not null),
        '/update-registration/' || new.id || '?field=piWalletAddress',
        'high'
      );
    exception when others then
      raise warning 'notify_business_account_change: wallet notification for business % failed: %', new.id, sqlerrm;
    end;

    begin
      perform net.http_post(
        url := 'https://xvpwbocwasbtzrzrxyvu.supabase.co/functions/v1/notify-account-event',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret' limit 1)
        ),
        body := jsonb_build_object(
          'kind', 'payout_wallet_changed',
          'business_id', new.id,
          'old_confirmed_email', old.contact_email_verified_for
        )
      );
    exception when others then
      raise warning 'notify_business_account_change: could not queue the wallet email for business %: %', new.id, sqlerrm;
    end;
  end if;

  if lower(trim(coalesce(new.contact_info->>'email', ''))) is distinct from lower(trim(coalesce(old.contact_info->>'email', ''))) then
    begin
      perform public.create_notification(
        new.owner_id,
        'business',
        'contact_email_changed',
        'The contact email for ' || new.business_name || ' changed. Verification is paused until you confirm the new email.',
        jsonb_build_object('businessId', new.id, 'businessName', new.business_name, 'actionLabel', 'Confirm email'),
        '/communicon?confirm=1',
        'medium'
      );
    exception when others then
      raise warning 'notify_business_account_change: email notification for business % failed: %', new.id, sqlerrm;
    end;
  end if;

  return new;
end
$f$;

revoke all on function public.notify_business_account_change() from public, anon, authenticated;

drop trigger if exists trg_notify_business_account_change on public.businesses;
create trigger trg_notify_business_account_change
  after update of pi_wallet_address, contact_info on public.businesses
  for each row execute function public.notify_business_account_change();
