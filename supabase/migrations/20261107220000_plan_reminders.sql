-- Plan reminders and plan expiry.
--
-- Plans don't renew, and nothing acted when subscriptions.end_date passed: users.subscription
-- stayed on the paid tier, so extra businesses were never switched off and the owner was never
-- told. The plan-reminders edge function, run daily by the cron job below, now:
--   - reminds an owner 3 days before their paid plan ends (in the app, and by email to their
--     confirmed contact email when they have one)
--   - when it has ended, moves users.subscription to 'individual' (which fires the existing
--     handle_subscription_downgrade trigger: businesses beyond the new limit are deactivated,
--     the most recent stay listed) and tells them, including which businesses are no longer listed
--
-- plan_reminder_log: one row per subscription and kind ('ending', 'ended'), so each is sent once.
-- The function claims a row before sending. RLS on with no policies: service role only.

create table if not exists public.plan_reminder_log (
  subscription_id integer not null,
  kind text not null check (kind in ('ending', 'ended')),
  sent_at timestamptz not null default now(),
  primary key (subscription_id, kind)
);

alter table public.plan_reminder_log enable row level security;
revoke all on table public.plan_reminder_log from anon, authenticated;

comment on table public.plan_reminder_log is
  'Plan reminders already sent, per subscription and kind (plan-reminders). Service role only: RLS on, no policies.';

-- The daily run, at 06:10 UTC, authenticated like the other cron jobs (X-Cron-Secret from Vault).
-- Unscheduled first if it exists, so applying this twice leaves one job.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'plan-reminders-daily') then
    perform cron.unschedule('plan-reminders-daily');
  end if;
end
$$;

select cron.schedule(
  'plan-reminders-daily',
  '10 6 * * *',
  $$
  select net.http_post(
    url := 'https://xvpwbocwasbtzrzrxyvu.supabase.co/functions/v1/plan-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret' limit 1)
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);

-- New review notifications: owners can't reply to reviews, so the action is "See review", and the
-- link opens the business's View Reviews tab. The same function as in
-- 20261107180000_notification_events.sql apart from those two values.

create or replace function public.notify_new_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $f$
declare
  v_owner uuid;
  v_name text;
  v_text text := nullif(trim(coalesce(new.content, '')), '');
begin
  begin
    select owner_id, business_name into v_owner, v_name from public.businesses where id = new.business_id;
    if v_owner is null or v_owner = new.user_id then
      return new;
    end if;
    perform public.create_notification(
      v_owner,
      'review',
      'new_review',
      'New review for ' || v_name || ': ' || new.rating || '★'
        || case
             when v_text is null then ''
             when length(v_text) > 120 then ' “' || rtrim(left(v_text, 120)) || '…”'
             else ' “' || v_text || '”'
           end,
      jsonb_build_object('businessId', new.business_id, 'businessName', v_name, 'rating', new.rating,
        'reviewId', new.id, 'actionLabel', 'See review'),
      '/review/' || new.business_id || '?tab=reviews',
      'medium'
    );
  exception when others then
    raise warning 'notify_new_review: notification for review % failed: %', new.id, sqlerrm;
  end;
  return new;
end
$f$;

revoke all on function public.notify_new_review() from public, anon, authenticated;

-- The new_review notifications already sent get the same action and link
update public.notifications
  set click_url = '/review/' || (metadata->>'businessId') || '?tab=reviews',
      metadata = metadata || '{"actionLabel": "See review"}'::jsonb
  where metadata->>'kind' = 'new_review'
    and metadata->>'businessId' is not null;
