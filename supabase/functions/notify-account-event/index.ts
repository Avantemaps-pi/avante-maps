/**
 * Emails a business owner about a change to their account that they need to know about even if
 * they didn't make it. Today: a changed payout wallet.
 *
 * Called by the trg_notify_business_account_change trigger on businesses (pg_net, with the
 * X-Cron-Secret header from Vault), never by the browser. Deploy with verify_jwt off: the trigger
 * sends no JWT.
 *
 * The email goes to the contact email that was confirmed BEFORE the change (old_confirmed_email,
 * from the trigger), so someone who changes the wallet and the email together can't send the
 * warning to themselves. No confirmed email before: nothing is sent (the in-app notification,
 * added by the trigger, still shows). This function changes nothing.
 *
 * Logs carry ids and the outcome only: never the email address.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { verifyCronRequest } from '../_shared/cronAuth.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const brevoApiKey = Deno.env.get('BREVO_API_KEY')!;

// The Pi Browser app link, as in contact-otp; read per email so it can change without a redeploy
const DEFAULT_APP_LINK_BASE = 'https://avantemapsaebbcf9516.pinet.com';
const appLinkBase = () =>
  Deno.env.get('PI_APP_LINK_BASE') ?? DEFAULT_APP_LINK_BASE;

const bodySchema = z.object({
  kind: z.literal('payout_wallet_changed'),
  business_id: z.number().int().positive(),
  old_confirmed_email: z.string().nullable().optional(),
});

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ fn: 'notify-account-event', ...fields }));

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

// GD7Q…K2LM: enough to recognise the address, as in the in-app notification
export function shortAddress(
  address: string | null | undefined,
): string | null {
  const trimmed = (address ?? '').trim();
  if (!trimmed) return null;
  return trimmed.length <= 10
    ? trimmed
    : `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

const emailLooksValid = (email: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function walletLink(businessId: number): string {
  const url = new URL(`/update-registration/${businessId}`, appLinkBase());
  url.search = new URLSearchParams({ field: 'piWalletAddress' }).toString();
  return url.toString();
}

export function walletEmailHtml(
  businessName: string,
  newAddress: string | null,
  when: Date,
  link: string,
): string {
  const name = escapeHtml(businessName);
  const changed = newAddress
    ? `The payout wallet for <strong>${name}</strong> was changed to <strong>${escapeHtml(newAddress)}</strong>`
    : `The payout wallet for <strong>${name}</strong> was removed`;
  const at = when.toUTCString().replace('GMT', 'UTC');
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #ffffff;">
      <p style="color: #1a1a1a; font-size: 16px; margin: 0 0 12px;">${changed} on ${escapeHtml(at)}.</p>
      <p style="color: #1a1a1a; font-size: 16px; margin: 0 0 24px;">If this wasn't you, open Avante Maps and change it back.</p>
      <div style="text-align: center; margin: 0 0 24px;">
        <a href="${escapeHtml(link)}" style="display: inline-block; background: #2563EB; color: #ffffff; border-radius: 8px; padding: 14px 24px; font-size: 16px; font-weight: bold; text-decoration: none;">Check payout wallet</a>
      </div>
      <p style="color: #6b7280; font-size: 12px; margin: 0;">You're getting this because this is the confirmed contact email for ${name} on Avante Maps.</p>
    </div>
  `;
}

async function sendEmail(
  to: string,
  subject: string,
  htmlContent: string,
): Promise<number | null> {
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
    return response.ok ? null : response.status;
  } catch {
    return 0;
  }
}

Deno.serve(async (req) => {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (!(await verifyCronRequest(req, supabase))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) return json({ error: 'Invalid body' }, 400);
    body = parsed.data;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const ids = { kind: body.kind, business_id: body.business_id };
  try {
    const to = (body.old_confirmed_email ?? '').trim().toLowerCase();
    if (!to || !emailLooksValid(to)) {
      log({ ...ids, sent: false, reason: 'no_confirmed_email' });
      return json({ sent: false, reason: 'no_confirmed_email' });
    }

    const { data: business, error } = await supabase
      .from('businesses')
      .select('id, business_name, pi_wallet_address')
      .eq('id', body.business_id)
      .maybeSingle();
    if (error) throw error;
    if (!business) {
      log({ ...ids, sent: false, reason: 'business_not_found' });
      return json({ sent: false, reason: 'business_not_found' });
    }

    const businessName = business.business_name?.trim() || 'your business';
    const failedStatus = await sendEmail(
      to,
      `Payout wallet changed for ${businessName}`,
      walletEmailHtml(
        businessName,
        shortAddress(business.pi_wallet_address),
        new Date(),
        walletLink(business.id),
      ),
    );
    if (failedStatus !== null) {
      log({
        ...ids,
        sent: false,
        reason: 'email_failed',
        brevo_status: failedStatus,
      });
      return json({ sent: false, reason: 'email_failed' }, 502);
    }
    log({ ...ids, sent: true });
    return json({ sent: true });
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String(err.code)
        : 'unknown';
    log({ ...ids, sent: false, reason: 'error', code });
    return json({ error: 'Internal error' }, 500);
  }
});
