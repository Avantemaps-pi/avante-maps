/**
 * Daily plan reminders and plan expiry (run by the plan-reminders-daily cron job at 06:10 UTC).
 *
 * Ending soon: a paid plan whose end_date is within 3 days, still the user's latest, while they're
 * still on a paid tier: a plan_ending notification, and an email to their confirmed contact email
 * (the newest active business that has one; none, no email).
 *
 * Ended: a user on a paid tier with no subscription still running (end_date in the future, or
 * none): users.subscription goes to 'individual', which fires handle_subscription_downgrade (the
 * businesses beyond the Individual limit are deactivated, the most recent stays listed). Then a
 * plan_ended notification, a listing_deactivated one for each business that was switched off, and
 * the same email. Users on a paid tier with no subscription rows at all are left alone: there's no
 * telling when (or whether) their plan ended.
 *
 * Each reminder is claimed in plan_reminder_log (subscription, kind) before anything is sent, so a
 * second run sends nothing new. One user's failure is logged and the rest carry on. Logs carry ids
 * only, never email addresses.
 *
 * subscriptions.end_date is a timestamp without time zone, written in UTC.
 */
import {
  createClient,
  type SupabaseClient,
} from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyCronRequest } from '../_shared/cronAuth.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const brevoApiKey = Deno.env.get('BREVO_API_KEY')!;

// The Pi Browser app link, as in contact-otp; read per email so it can change without a redeploy
const DEFAULT_APP_LINK_BASE = 'https://avantemapsaebbcf9516.pinet.com';
const appLinkBase = () =>
  Deno.env.get('PI_APP_LINK_BASE') ?? DEFAULT_APP_LINK_BASE;

const PAID_TIERS = ['small-business', 'organization'];
const PLAN_NAMES: Record<string, string> = {
  individual: 'Individual',
  'small-business': 'Small Business',
  organization: 'Organization',
};
const planName = (tier: string | null | undefined) =>
  tier ? (PLAN_NAMES[tier] ?? tier) : 'paid';
const REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

interface Subscription {
  id: number;
  user_id: string;
  plan: string | null;
  end_date: string | null;
}

interface Business {
  id: number;
  business_name: string | null;
  is_active: boolean;
  created_at: string | null;
  contact_info: unknown;
  contact_email_verified_for: string | null;
}

type Outcome = 'sent' | 'skipped' | 'failed';

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ fn: 'plan-reminders', ...fields }));

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

// end_date as written (UTC, no zone) → a Date
const parseEndDate = (value: string) =>
  new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
// A Date as end_date compares in PostgREST: UTC, no zone
const asTimestamp = (date: Date) => date.toISOString().replace('Z', '');
export const dayMonth = (date: Date) =>
  `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;

const isConflict = (error: { code?: string } | null) => error?.code === '23505';

// The newest active business with a confirmed contact email (as verify-business counts it)
function confirmedEmail(businesses: Business[]): string | null {
  const newestFirst = [...businesses].sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  );
  for (const business of newestFirst) {
    if (!business.is_active) continue;
    const info =
      typeof business.contact_info === 'object' &&
      business.contact_info !== null
        ? (business.contact_info as Record<string, unknown>)
        : {};
    const email =
      typeof info.email === 'string' ? info.email.trim().toLowerCase() : '';
    if (email && business.contact_email_verified_for === email) return email;
  }
  return null;
}

export function reminderEmailHtml(
  text: string,
  extra: string[],
  link: string,
): string {
  const lines = extra
    .map(
      (line) =>
        `<p style="color: #1a1a1a; font-size: 15px; margin: 0 0 12px;">${escapeHtml(line)}</p>`,
    )
    .join('');
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #ffffff;">
      <p style="color: #1a1a1a; font-size: 16px; margin: 0 0 16px;">${escapeHtml(text)}</p>
      ${lines}
      <div style="text-align: center; margin: 12px 0 24px;">
        <a href="${escapeHtml(link)}" style="display: inline-block; background: #2563EB; color: #ffffff; border-radius: 8px; padding: 14px 24px; font-size: 16px; font-weight: bold; text-decoration: none;">Renew in Avante Maps</a>
      </div>
      <p style="color: #6b7280; font-size: 12px; margin: 0;">You're getting this because it's the confirmed contact email for your business on Avante Maps.</p>
    </div>
  `;
}

const pricingLink = () => new URL('/pricing', appLinkBase()).toString();

async function sendEmail(
  to: string,
  subject: string,
  htmlContent: string,
): Promise<boolean> {
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': brevoApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Avante Maps', email: 'support@avantemaps.com' },
        to: [{ email: to }],
        subject,
        htmlContent,
      }),
    });
    // The error body isn't logged: it can echo the recipient
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function notify(
  supabase: SupabaseClient,
  userId: string,
  type: string,
  kind: string,
  content: string,
  metadata: Record<string, unknown>,
) {
  const { error } = await supabase.rpc('create_notification', {
    p_user_id: userId,
    p_type: type,
    p_kind: kind,
    p_content: content,
    p_metadata: metadata,
    p_click_url: '/pricing',
    p_priority: 'high',
  });
  if (error) throw error;
}

async function claim(
  supabase: SupabaseClient,
  subscriptionId: number,
  kind: 'ending' | 'ended',
): Promise<boolean> {
  const { error } = await supabase
    .from('plan_reminder_log')
    .insert({ subscription_id: subscriptionId, kind });
  if (isConflict(error)) return false;
  if (error) throw error;
  return true;
}

const release = (
  supabase: SupabaseClient,
  subscriptionId: number,
  kind: 'ending' | 'ended',
) =>
  supabase
    .from('plan_reminder_log')
    .delete()
    .eq('subscription_id', subscriptionId)
    .eq('kind', kind);

async function loadBusinesses(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<Business[]> {
  const { data, error } = await supabase
    .from('businesses')
    .select(
      'id, business_name, is_active, created_at, contact_info, contact_email_verified_for',
    )
    .eq('owner_id', ownerId);
  if (error) throw error;
  return (data ?? []) as Business[];
}

async function loadSubscriptions(
  supabase: SupabaseClient,
  userId: string,
): Promise<Subscription[]> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, user_id, plan, end_date')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []) as Subscription[];
}

// ---- Ending soon

async function remindEnding(
  supabase: SupabaseClient,
  sub: Subscription,
): Promise<Outcome> {
  const ids = { kind: 'ending', subscription_id: sub.id, user_id: sub.user_id };
  const skip = (reason: string): Outcome => {
    log({ ...ids, outcome: 'skipped', reason });
    return 'skipped';
  };
  const endsAt = parseEndDate(sub.end_date!);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, subscription')
    .eq('id', sub.user_id)
    .maybeSingle();
  if (userError) throw userError;
  // Already off the paid tier: nothing changes when this ends
  if (!user || !PAID_TIERS.includes(user.subscription))
    return skip('not_on_paid_plan');

  // Renewed: a later subscription keeps them on a plan
  const subs = await loadSubscriptions(supabase, sub.user_id);
  if (
    subs.some(
      (s) =>
        s.id !== sub.id &&
        (s.end_date === null || parseEndDate(s.end_date) > endsAt),
    )
  )
    return skip('renewed');

  if (!(await claim(supabase, sub.id, 'ending'))) return skip('already_sent');
  try {
    const name = planName(sub.plan);
    const text = `Your ${name} plan ends on ${dayMonth(endsAt)}. After that, only 1 business stays listed.`;
    const to = confirmedEmail(await loadBusinesses(supabase, sub.user_id));
    const emailed = to
      ? await sendEmail(
          to,
          `Your ${name} plan ends on ${dayMonth(endsAt)}`,
          reminderEmailHtml(text, [], pricingLink()),
        )
      : false;
    await notify(supabase, sub.user_id, 'payment', 'plan_ending', text, {
      plan: sub.plan,
      endsAt: endsAt.toISOString(),
      actionLabel: 'Renew plan',
      emailed,
    });
    log({
      ...ids,
      outcome: 'sent',
      emailed,
      reason: to ? undefined : 'no_confirmed_email',
    });
    return 'sent';
  } catch (err) {
    // Not sent: free the claim so tomorrow's run tries again
    await release(supabase, sub.id, 'ending');
    throw err;
  }
}

// ---- Ended

async function endPlan(
  supabase: SupabaseClient,
  user: { id: string; subscription: string },
  now: Date,
): Promise<Outcome> {
  const ids = { kind: 'ended', user_id: user.id };
  const skip = (
    reason: string,
    extra: Record<string, unknown> = {},
  ): Outcome => {
    log({ ...ids, ...extra, outcome: 'skipped', reason });
    return 'skipped';
  };

  const subs = await loadSubscriptions(supabase, user.id);
  if (subs.length === 0) return skip('no_subscription_rows');
  if (subs.some((s) => s.end_date === null || parseEndDate(s.end_date) > now))
    return skip('still_active');
  const latest = [...subs].sort(
    (a, b) =>
      parseEndDate(b.end_date!).getTime() -
        parseEndDate(a.end_date!).getTime() || b.id - a.id,
  )[0]!;
  const subIds = { subscription_id: latest.id };

  if (!(await claim(supabase, latest.id, 'ended')))
    return skip('already_sent', subIds);

  let downgraded = false;
  try {
    const before = await loadBusinesses(supabase, user.id);
    // Only while they're still on that tier: a renewal in between wins
    const { data: changed, error: updateError } = await supabase
      .from('users')
      .update({ subscription: 'individual' })
      .eq('id', user.id)
      .eq('subscription', user.subscription)
      .select('id');
    if (updateError) throw updateError;
    if (!changed || changed.length === 0) {
      await release(supabase, latest.id, 'ended');
      return skip('changed_meanwhile', subIds);
    }
    downgraded = true;

    // handle_subscription_downgrade has run: what was listed before and isn't now
    const after = await loadBusinesses(supabase, user.id);
    const wasActive = new Set(
      before.filter((b) => b.is_active).map((b) => b.id),
    );
    const switchedOff = after.filter(
      (b) => !b.is_active && wasActive.has(b.id),
    );

    const name = planName(user.subscription);
    const text = `Your ${name} plan ended. You're on the Individual plan now.`;
    const to = confirmedEmail(after);
    const emailed = to
      ? await sendEmail(
          to,
          `Your ${name} plan has ended`,
          reminderEmailHtml(
            text,
            switchedOff.map(
              (b) =>
                `${b.business_name ?? 'A business'} is no longer listed. Renew to list it again.`,
            ),
            pricingLink(),
          ),
        )
      : false;
    await notify(supabase, user.id, 'payment', 'plan_ended', text, {
      plan: user.subscription,
      endedAt: parseEndDate(latest.end_date!).toISOString(),
      actionLabel: 'Renew plan',
      emailed,
    });
    for (const business of switchedOff) {
      const businessName = business.business_name ?? 'Your business';
      await notify(
        supabase,
        user.id,
        'business',
        'listing_deactivated',
        `${businessName} is no longer listed because your plan ended. Renew to list it again.`,
        { businessId: business.id, businessName, actionLabel: 'Renew plan' },
      );
    }
    log({
      ...ids,
      ...subIds,
      outcome: 'sent',
      emailed,
      deactivated: switchedOff.map((b) => b.id),
    });
    return 'sent';
  } catch (err) {
    // Before the downgrade: free the claim so tomorrow's run tries again. After it, keep it: the
    // plan has been changed, and running it again would tell them twice
    if (!downgraded) await release(supabase, latest.id, 'ended');
    throw err;
  }
}

// ---- The run

const errorCode = (err: unknown) =>
  typeof err === 'object' && err !== null && 'code' in err
    ? String(err.code)
    : 'unknown';

Deno.serve(async (req) => {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (!(await verifyCronRequest(req, supabase))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const now = new Date();
  const tally = () => ({ sent: 0, skipped: 0, failed: 0 });
  const summary = { ending: tally(), ended: tally() };

  try {
    const { data: ending, error: endingError } = await supabase
      .from('subscriptions')
      .select('id, user_id, plan, end_date')
      .in('plan', PAID_TIERS)
      .gt('end_date', asTimestamp(now))
      .lte(
        'end_date',
        asTimestamp(new Date(now.getTime() + REMINDER_WINDOW_MS)),
      );
    if (endingError) throw endingError;
    for (const sub of (ending ?? []) as Subscription[]) {
      try {
        summary.ending[await remindEnding(supabase, sub)] += 1;
      } catch (err) {
        summary.ending.failed += 1;
        log({
          kind: 'ending',
          subscription_id: sub.id,
          user_id: sub.user_id,
          outcome: 'failed',
          code: errorCode(err),
        });
      }
    }

    const { data: paidUsers, error: usersError } = await supabase
      .from('users')
      .select('id, subscription')
      .in('subscription', PAID_TIERS);
    if (usersError) throw usersError;
    for (const user of (paidUsers ?? []) as Array<{
      id: string;
      subscription: string;
    }>) {
      try {
        summary.ended[await endPlan(supabase, user, now)] += 1;
      } catch (err) {
        summary.ended.failed += 1;
        log({
          kind: 'ended',
          user_id: user.id,
          outcome: 'failed',
          code: errorCode(err),
        });
      }
    }
  } catch (err) {
    log({ outcome: 'failed', code: errorCode(err) });
    return json({ error: 'Internal error', ...summary }, 500);
  }

  log({ outcome: 'done', ...summary });
  return json(summary);
});
