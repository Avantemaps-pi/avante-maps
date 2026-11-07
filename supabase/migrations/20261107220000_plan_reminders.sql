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
