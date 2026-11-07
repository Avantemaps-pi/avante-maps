/**
 * Unit tests for notify-new-message with Supabase, the cron secret check and Brevo mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 test --allow-env --allow-net --allow-read supabase/functions/notify-new-message/index.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  installFakeSupabase,
  loadHandler,
  setFunctionEnv,
  type Row,
} from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
Deno.env.delete('PI_APP_LINK_BASE');
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const SECRET = 'test-cron-secret';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-0000-0000-0000000000b1';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';
const EMAIL = 'hello@harbour.example';
const MSG = (n: number) =>
  `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60 * 1000).toISOString();

// supabase-js starts auth refresh timers for each client the function creates, which Deno's
// op/resource sanitizers would report as leaks
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

interface Options {
  brevoOk?: boolean;
  business?: Row;
  businessUnread?: number;
  log?: Row[];
  messages?: Row[];
}

function setup(options: Options = {}) {
  const sent: { to: string; subject: string; html: string }[] = [];
  const business: Row = {
    id: 7,
    owner_id: OWNER,
    business_name: 'Harbour <Light> & Co',
    contact_info: { email: ' Hello@Harbour.example' },
    contact_email_verified_for: EMAIL,
    notify_new_message_email: true,
    is_active: true,
    ...options.business,
  };
  const conversation: Row = {
    id: CONVERSATION,
    business_id: 7,
    customer_id: CUSTOMER,
    business_unread: options.businessUnread ?? 1,
  };
  const messages: Row[] = options.messages ?? [
    {
      id: MSG(1),
      conversation_id: CONVERSATION,
      sender_role: 'customer',
      body: 'Are you open on Sunday?',
    },
  ];
  const fake = installFakeSupabase({
    tables: {
      businesses: [business],
      conversations: [conversation],
      messages,
      users: [{ id: CUSTOMER, username: 'pi_<pioneer>' }],
      message_email_log: options.log ?? [],
      notifications: [],
    },
    users: {},
    primaryKeys: { message_email_log: 'conversation_id' },
    rpc: (name, args) => {
      if (name !== 'verify_cron_secret')
        throw new Error(`unexpected rpc ${name}`);
      return Response.json(args.provided === SECRET);
    },
    external: async (url, init) => {
      if (url.host !== 'api.brevo.com') return undefined;
      const body = JSON.parse(String(init?.body));
      sent.push({
        to: body.to[0].email,
        subject: body.subject,
        html: body.htmlContent,
      });
      return options.brevoOk === false
        ? new Response(`quota exceeded for ${EMAIL}`, { status: 402 })
        : Response.json({ messageId: 'm1' });
    },
  });
  return {
    fake,
    sent,
    business,
    conversation,
    messages,
    notifications: () => fake.tables.notifications!,
  };
}

// Everything the function logs, to check no email address or message text leaks into it
const logged: string[] = [];
const capture = (...args: unknown[]) =>
  logged.push(
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
  );
console.log = capture;
console.error = capture;
console.warn = capture;

const call = async (messageId: string, secret: string | null = SECRET) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret !== null) headers['X-Cron-Secret'] = secret;
  const res = await handler(
    new Request('http://fn/notify-new-message', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message_id: messageId }),
    }),
  );
  return { status: res.status, body: await res.json() };
};

const run = async (
  options: Options,
  fn: (ctx: ReturnType<typeof setup>) => Promise<void>,
) => {
  const ctx = setup(options);
  try {
    await fn(ctx);
  } finally {
    ctx.fake.restore();
  }
};

test('a missing or wrong secret is refused with 401, and nothing is sent', () =>
  run({}, async ({ sent, fake }) => {
    assertEquals((await call(MSG(1), null)).status, 401);
    assertEquals((await call(MSG(1), 'wrong')).status, 401);
    assertEquals(sent, []);
    assertEquals(fake.tables.message_email_log, []);
  }));

test('a body without a uuid message_id is a 400', () =>
  run({}, async ({ sent }) => {
    assertEquals((await call('not-a-uuid')).status, 400);
    assertEquals(sent, []);
  }));

test("a business's message is not emailed", () =>
  run(
    {
      messages: [
        {
          id: MSG(1),
          conversation_id: CONVERSATION,
          sender_role: 'business',
          body: 'Yes we are',
        },
      ],
    },
    async ({ sent }) => {
      const res = await call(MSG(1));
      assertEquals(res.status, 200);
      assertEquals(res.body, {
        sent: false,
        notified: false,
        reason: 'not_customer_message',
      });
      assertEquals(sent, []);
    },
  ));

test('a customer message with a confirmed email: one email with the subject, the escaped first line and the reply link', async () => {
  const long = `Hi <b>there</b> & "friends" ${'x'.repeat(200)}`;
  await run(
    {
      messages: [
        {
          id: MSG(1),
          conversation_id: CONVERSATION,
          sender_role: 'customer',
          body: `\n  ${long}\nSecond line stays out`,
        },
      ],
    },
    async ({ sent, fake, notifications }) => {
      logged.length = 0;
      const res = await call(MSG(1));
      assertEquals(res.status, 200);
      assertEquals(res.body, { sent: true, notified: true });
      assertEquals(sent.length, 1);
      const email = sent[0]!;
      assertEquals(email.to, EMAIL);
      assertEquals(email.subject, 'New message for Harbour <Light> & Co');

      // First line only, cut to 120 characters with "…", then escaped
      const cut = `${Array.from(long).slice(0, 120).join('')}…`;
      assertStringIncludes(
        email.html,
        cut
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;'),
      );
      assert(!email.html.includes('<b>there</b>'));
      assert(!email.html.includes('Second line'));
      assert(!email.html.includes('x'.repeat(121)));
      assertStringIncludes(
        email.html,
        'pi_&lt;pioneer&gt; sent Harbour &lt;Light&gt; &amp; Co a message on CommuniCon:',
      );
      assertStringIncludes(
        email.html,
        `href="https://avantemapsaebbcf9516.pinet.com/communicon?conversation=${CONVERSATION}"`,
      );
      assertStringIncludes(email.html, 'Reply in Avante Maps');
      assertStringIncludes(email.html, 'background: #2563EB; color: #ffffff');
      assertStringIncludes(
        email.html,
        "You're getting this because you own Harbour &lt;Light&gt; &amp; Co on Avante Maps.",
      );

      // And the in-app notification, marked as emailed
      assertEquals(notifications().length, 1);
      const n = notifications()[0]!;
      assertEquals(n.user_id, OWNER);
      assertEquals(n.type, 'message');
      assertEquals(n.click_url, `/communicon?conversation=${CONVERSATION}`);
      assertEquals(
        n.content,
        `pi_<pioneer> messaged Harbour <Light> & Co: “${cut}”`,
      );
      assertEquals(n.metadata, {
        kind: 'new_message',
        businessId: 7,
        businessName: 'Harbour <Light> & Co',
        conversationId: CONVERSATION,
        messageId: MSG(1),
        actionLabel: 'Reply',
        emailed: true,
        userName: 'pi_<pioneer>',
      });
      assertEquals(
        [n.read, n.priority, n.delivery_status],
        [false, 'medium', 'delivered'],
      );

      // The send is claimed in the log
      assertEquals(fake.tables.message_email_log!.length, 1);
      assertEquals(fake.tables.message_email_log![0]!.last_message_id, MSG(1));

      // Logs: ids and the outcome, never the address or the text
      const output = logged.join('\n');
      assertStringIncludes(output, '"sent":true');
      assertStringIncludes(output, CONVERSATION);
      assert(!output.toLowerCase().includes('harbour.example'), output);
      assert(!output.includes('friends'), output);
    },
  );
});

test("a second unread customer message isn't emailed (the owner hasn't read the first)", () =>
  run({ businessUnread: 2, log: [] }, async ({ sent, notifications }) => {
    const res = await call(MSG(1));
    assertEquals(res.body, {
      sent: false,
      notified: false,
      reason: 'earlier_message_unread',
    });
    assertEquals(sent, []);
    assertEquals(notifications(), []);
  }));

test('after the owner has read the conversation, a new message is emailed', () =>
  // Emailed 30 minutes ago; the owner has since opened it (business_unread back to 0), and this
  // new message made it 1
  run(
    {
      businessUnread: 1,
      log: [
        {
          conversation_id: CONVERSATION,
          last_emailed_at: minutesAgo(30),
          last_message_id: MSG(0),
        },
      ],
    },
    async ({ sent, fake, notifications }) => {
      const res = await call(MSG(1));
      assertEquals(res.body, { sent: true, notified: true });
      assertEquals(sent.length, 1);
      assertEquals(notifications().length, 1);
      assertEquals(fake.tables.message_email_log![0]!.last_message_id, MSG(1));
    },
  ));

test('within 10 minutes of the last email, nothing is sent', () =>
  run(
    {
      businessUnread: 1,
      log: [
        {
          conversation_id: CONVERSATION,
          last_emailed_at: minutesAgo(5),
          last_message_id: MSG(0),
        },
      ],
    },
    async ({ sent, fake, notifications }) => {
      const res = await call(MSG(1));
      assertEquals(res.body, {
        sent: false,
        notified: false,
        reason: 'recently_emailed',
      });
      assertEquals(sent, []);
      assertEquals(notifications(), []);
      assertEquals(fake.tables.message_email_log![0]!.last_message_id, MSG(0));
    },
  ));

test('opted out, inactive, unconfirmed or changed email: no email, but the in-app notification still goes', async () => {
  const cases: Array<[Row, string]> = [
    [{ notify_new_message_email: false }, 'opted_out'],
    [{ is_active: false }, 'business_inactive'],
    [{ contact_email_verified_for: null }, 'email_not_confirmed'],
    [{ contact_info: { email: 'new@harbour.example' } }, 'email_not_confirmed'],
    [{ contact_info: {} }, 'email_not_confirmed'],
  ];
  for (const [business, reason] of cases) {
    await run({ business }, async ({ sent, fake, notifications }) => {
      const res = await call(MSG(1));
      assertEquals(
        res.body,
        { sent: false, notified: true, reason },
        JSON.stringify(business),
      );
      assertEquals(sent, []);
      assertEquals(notifications().length, 1, JSON.stringify(business));
      assertEquals(
        (notifications()[0]!.metadata as Row).emailed,
        false,
        JSON.stringify(business),
      );
      // Claimed all the same, so the next message within 10 minutes adds nothing
      assertEquals(fake.tables.message_email_log!.length, 1);
    });
  }
});

test('opted out: not twice within 10 minutes', () =>
  run(
    {
      business: { notify_new_message_email: false },
      messages: [
        {
          id: MSG(1),
          conversation_id: CONVERSATION,
          sender_role: 'customer',
          body: 'First',
        },
        {
          id: MSG(2),
          conversation_id: CONVERSATION,
          sender_role: 'customer',
          body: 'Second',
        },
      ],
    },
    async ({ conversation, notifications }) => {
      assertEquals((await call(MSG(1))).body.notified, true);
      // The owner read it, so the next message is the first unread again, but within 10 minutes
      conversation.business_unread = 1;
      const again = await call(MSG(2));
      assertEquals(again.body, {
        sent: false,
        notified: false,
        reason: 'recently_emailed',
      });
      assertEquals(notifications().length, 1);
    },
  ));

test('a Brevo failure is a 502 and releases the claim, so a later message can try again', () =>
  run({ brevoOk: false }, async ({ sent, fake, notifications }) => {
    logged.length = 0;
    const res = await call(MSG(1));
    assertEquals(res.status, 502);
    assertEquals(res.body, {
      sent: false,
      notified: true,
      reason: 'email_failed',
    });
    assertEquals(sent.length, 1);
    assertEquals(fake.tables.message_email_log, []);
    // The in-app one went, not marked as emailed
    assertEquals(notifications().length, 1);
    assertEquals((notifications()[0]!.metadata as Row).emailed, false);
    // A repeat of the same message tries the email again, but adds no second notification
    const retry = await call(MSG(1));
    assertEquals(retry.body.notified, false);
    assertEquals(sent.length, 2);
    assertEquals(notifications().length, 1);
    // Brevo's error body (which can echo the address) isn't logged
    assert(!logged.join('\n').toLowerCase().includes('harbour.example'));
  }));

test('a Brevo failure after a takeover releases it too', () =>
  run(
    {
      brevoOk: false,
      log: [
        {
          conversation_id: CONVERSATION,
          last_emailed_at: minutesAgo(30),
          last_message_id: MSG(0),
        },
      ],
    },
    async ({ fake }) => {
      assertEquals((await call(MSG(1))).status, 502);
      assertEquals(fake.tables.message_email_log, []);
    },
  ));

test('two concurrent calls send one email', () =>
  run({}, async ({ sent, fake, notifications }) => {
    const results = await Promise.all([call(MSG(1)), call(MSG(1))]);
    assertEquals(sent.length, 1);
    assertEquals(notifications().length, 1);
    assertEquals(results.map((r) => r.body.sent).sort(), [false, true]);
    assertEquals(
      results.find((r) => !r.body.sent)!.body.reason,
      'recently_emailed',
    );
    assertEquals(fake.tables.message_email_log!.length, 1);
  }));

test('an unknown message id sends nothing', () =>
  run({}, async ({ sent }) => {
    const res = await call(MSG(9));
    assertEquals(res.body, {
      sent: false,
      notified: false,
      reason: 'message_not_found',
    });
    assertEquals(sent, []);
  }));
