/**
 * Emails a business owner when a customer messages their business in CommuniCon.
 *
 * Called by the trg_notify_new_message trigger on messages (pg_net, with the X-Cron-Secret header
 * from Vault), never by the browser. Deploy with verify_jwt off: the trigger sends no JWT.
 *
 * One email per conversation until the owner reads it: sent only while this message is the only
 * one the owner hasn't read (conversations.business_unread = 1, counted by
 * bump_conversation_on_message and zeroed when the owner opens the conversation), and at most once
 * every 10 minutes per conversation (message_email_log), so bursts and repeated calls send once.
 *
 * Logs carry ids and the outcome only: never the email address or the message text.
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

const RESEND_WINDOW_MS = 10 * 60 * 1000;
const PREVIEW_MAX_CHARS = 120;

const bodySchema = z.object({ message_id: z.string().uuid() });

type SkipReason =
  | 'message_not_found'
  | 'not_customer_message'
  | 'business_inactive'
  | 'opted_out'
  | 'email_not_confirmed'
  | 'earlier_message_unread'
  | 'recently_emailed';

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const log = (fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ fn: 'notify-new-message', ...fields }));

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

// The first non-empty line, cut to 120 characters (whole code points) with "…" when cut
export function firstLine(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const chars = Array.from(line);
  return chars.length > PREVIEW_MAX_CHARS
    ? `${chars.slice(0, PREVIEW_MAX_CHARS).join('').trimEnd()}…`
    : line;
}

// The confirmed contact email (as in verify-business): contact_email_verified_for must equal the
// current contact_info email, lower-cased and trimmed
function confirmedEmail(business: {
  contact_info: unknown;
  contact_email_verified_for: string | null;
}): string | null {
  const info =
    typeof business.contact_info === 'object' && business.contact_info !== null
      ? (business.contact_info as Record<string, unknown>)
      : {};
  const email =
    typeof info.email === 'string' ? info.email.trim().toLowerCase() : '';
  return email && business.contact_email_verified_for === email ? email : null;
}

function replyLink(conversationId: string): string {
  const url = new URL('/communicon', appLinkBase());
  url.search = new URLSearchParams({ conversation: conversationId }).toString();
  return url.toString();
}

export function emailHtml(
  username: string,
  businessName: string,
  preview: string,
  link: string,
): string {
  const name = escapeHtml(businessName);
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; background: #ffffff;">
      <p style="color: #1a1a1a; font-size: 16px; margin: 0 0 12px;">${escapeHtml(username)} sent ${name} a message on CommuniCon:</p>
      <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; margin: 0 0 24px; color: #1a1a1a; font-size: 15px; line-height: 1.5; word-wrap: break-word;">${escapeHtml(preview)}</div>
      <div style="text-align: center; margin: 0 0 24px;">
        <a href="${escapeHtml(link)}" style="display: inline-block; background: #2563EB; color: #ffffff; border-radius: 8px; padding: 14px 24px; font-size: 16px; font-weight: bold; text-decoration: none;">Reply in Avante Maps</a>
      </div>
      <p style="color: #6b7280; font-size: 12px; margin: 0;">You're getting this because you own ${name} on Avante Maps. You can turn these emails off on the business's Update business page.</p>
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

  let messageId: string;
  try {
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success)
      return json({ error: 'message_id must be a uuid' }, 400);
    messageId = parsed.data.message_id;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  try {
    const skip = (reason: SkipReason, ids: Record<string, unknown> = {}) => {
      log({ message_id: messageId, ...ids, sent: false, reason });
      return json({ sent: false, reason });
    };

    const { data: message, error: messageError } = await supabase
      .from('messages')
      .select('id, conversation_id, sender_role, body')
      .eq('id', messageId)
      .maybeSingle();
    if (messageError) throw messageError;
    if (!message) return skip('message_not_found');
    if (message.sender_role !== 'customer')
      return skip('not_customer_message', {
        conversation_id: message.conversation_id,
      });

    const { data: conversation, error: conversationError } = await supabase
      .from('conversations')
      .select('id, business_id, customer_id, business_unread')
      .eq('id', message.conversation_id)
      .maybeSingle();
    if (conversationError) throw conversationError;
    if (!conversation)
      return skip('message_not_found', {
        conversation_id: message.conversation_id,
      });
    const ids = {
      business_id: conversation.business_id,
      conversation_id: conversation.id,
    };

    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select(
        'business_name, contact_info, contact_email_verified_for, notify_new_message_email, is_active',
      )
      .eq('id', conversation.business_id)
      .maybeSingle();
    if (businessError) throw businessError;
    if (!business || !business.is_active) return skip('business_inactive', ids);
    if (business.notify_new_message_email === false)
      return skip('opted_out', ids);
    const to = confirmedEmail(business);
    if (!to) return skip('email_not_confirmed', ids);

    // The owner hasn't read an earlier message yet: they were emailed about that one
    if ((conversation.business_unread ?? 0) > 1)
      return skip('earlier_message_unread', ids);

    // Claim the send before calling Brevo, so concurrent calls send once: insert the log row, or
    // take over one older than 10 minutes. Either is a single statement, atomic in Postgres
    const now = new Date();
    const claim = {
      conversation_id: conversation.id,
      last_emailed_at: now.toISOString(),
      last_message_id: message.id,
    };
    const { error: insertError } = await supabase
      .from('message_email_log')
      .insert(claim);
    if (insertError) {
      if (insertError.code !== '23505') throw insertError;
      const { data: takenOver, error: updateError } = await supabase
        .from('message_email_log')
        .update(claim)
        .eq('conversation_id', conversation.id)
        .lt(
          'last_emailed_at',
          new Date(now.getTime() - RESEND_WINDOW_MS).toISOString(),
        )
        .select('conversation_id');
      if (updateError) throw updateError;
      if (!takenOver || takenOver.length === 0)
        return skip('recently_emailed', ids);
    }

    const { data: customer } = await supabase
      .from('users')
      .select('username')
      .eq('id', conversation.customer_id)
      .maybeSingle();
    const username = customer?.username?.trim() || 'A customer';
    const businessName = business.business_name?.trim() || 'your business';

    const failedStatus = await sendEmail(
      to,
      `New message for ${businessName}`,
      emailHtml(
        username,
        businessName,
        firstLine(message.body ?? ''),
        replyLink(conversation.id),
      ),
    );
    if (failedStatus !== null) {
      // Release the claim so a later message can try again
      await supabase
        .from('message_email_log')
        .delete()
        .eq('conversation_id', conversation.id)
        .eq('last_message_id', message.id);
      log({
        message_id: messageId,
        ...ids,
        sent: false,
        reason: 'email_failed',
        brevo_status: failedStatus,
      });
      return json({ sent: false, reason: 'email_failed' }, 502);
    }

    log({ message_id: messageId, ...ids, sent: true });
    return json({ sent: true });
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String(err.code)
        : 'unknown';
    log({ message_id: messageId, sent: false, reason: 'error', code });
    return json({ error: 'Internal error' }, 500);
  }
});
