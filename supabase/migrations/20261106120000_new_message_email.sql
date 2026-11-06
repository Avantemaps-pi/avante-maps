-- Email a business owner when a customer messages their business in CommuniCon.
--
-- After a customer's message is inserted, trg_notify_new_message asks the notify-new-message edge
-- function to email the owner (net.http_post with the X-Cron-Secret header from Vault, as the cron
-- jobs do). The function decides whether to send: the business is active and hasn't opted out,
-- its contact email is confirmed, the owner has read the earlier messages (business_unread = 1),
-- and no email went out for this conversation in the last 10 minutes.
--
-- pg_net is asynchronous: the request is queued with the insert and sent after it commits, so
-- sending a message never waits for the function. A failure to queue it is caught and raised as
-- a warning, so it can never block a message either. If the function isn't deployed yet, the
-- request 404s and nothing else happens.
--
-- businesses.notify_new_message_email: the owner's on/off switch (Update business > Contact).
-- Owners change it on their own row through the existing businesses RLS.
--
-- message_email_log: one row per conversation, the last time an owner was emailed about it. The
-- edge function claims a send by inserting the row, or taking over one older than 10 minutes,
-- before calling Brevo, so concurrent calls send once.

alter table public.businesses
  add column if not exists notify_new_message_email boolean not null default true;

create table if not exists public.message_email_log (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  last_emailed_at timestamptz not null,
  last_message_id uuid not null
);

-- RLS on with no policies: only the service role (notify-new-message) reads or writes it. Nobody
-- else has a reason to, and it shouldn't reveal when owners were emailed.
alter table public.message_email_log enable row level security;
revoke all on table public.message_email_log from anon, authenticated;

comment on table public.message_email_log is
  'When the owner was last emailed about each conversation (notify-new-message). Service role only: RLS on, no policies.';

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $f$
begin
  begin
    perform net.http_post(
      url := 'https://xvpwbocwasbtzrzrxyvu.supabase.co/functions/v1/notify-new-message',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_shared_secret' limit 1)
      ),
      body := jsonb_build_object('message_id', new.id)
    );
  exception when others then
    raise warning 'notify_new_message: could not queue the email request for message %: %', new.id, sqlerrm;
  end;
  return new;
end
$f$;

revoke all on function public.notify_new_message() from public, anon, authenticated;

drop trigger if exists trg_notify_new_message on public.messages;
create trigger trg_notify_new_message
  after insert on public.messages
  for each row
  when (new.sender_role = 'customer')
  execute function public.notify_new_message();
