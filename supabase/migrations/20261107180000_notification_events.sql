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
