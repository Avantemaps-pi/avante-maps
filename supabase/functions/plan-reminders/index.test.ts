/**
 * Unit tests for plan-reminders with Supabase, the cron secret check and Brevo mocked. The
 * handle_subscription_downgrade trigger is stood in for by the fake's afterUpdate hook.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 test --no-lock --allow-env --allow-net --allow-read supabase/functions/plan-reminders/index.test.ts
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
const { dayMonth } = await import(new URL('./index.ts', import.meta.url).href);

const SECRET = 'test-cron-secret';
const ALICE = '00000000-0000-0000-0000-0000000000a1';
const BOB = '00000000-0000-0000-0000-0000000000b2';
const DAY = 24 * 60 * 60 * 1000;
// end_date is a timestamp without time zone, in UTC
const at = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * DAY).toISOString().replace('Z', '');

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const business = (
  id: number,
  owner: string,
  name: string,
  createdDaysAgo: number,
  email?: string,
): Row => ({
  id,
  owner_id: owner,
  business_name: name,
  is_active: true,
  created_at: new Date(Date.now() - createdDaysAgo * DAY).toISOString(),
  contact_info: email ? { email: ` ${email.toUpperCase()}` } : {},
  contact_email_verified_for: email ?? null,
});

interface Options {
  users: Row[];
  subscriptions: Row[];
  businesses?: Row[];
  log?: Row[];
  failNotificationsFor?: string[];
}

function setup(options: Options) {
  const sent: { to: string; subject: string; html: string }[] = [];
  const tables = {
    users: options.users,
    subscriptions: options.subscriptions,
    businesses: options.businesses ?? [],
    notifications: [] as Row[],
    plan_reminder_log: options.log ?? [],
  };
  const fake = installFakeSupabase({
    tables,
    users: {},
    primaryKeys: { plan_reminder_log: ['subscription_id', 'kind'] },
    rpc: (name, args) => {
      if (name === 'verify_cron_secret')
        return Response.json(args.provided === SECRET);
      if (name === 'create_notification') {
        if (options.failNotificationsFor?.includes(String(args.p_user_id))) {
          return Response.json(
            { code: 'P0001', message: 'insert failed' },
            { status: 400 },
          );
        }
        tables.notifications.push({
          user_id: args.p_user_id,
          type: args.p_type,
          content: args.p_content,
          metadata: { ...(args.p_metadata as Row), kind: args.p_kind },
          click_url: args.p_click_url,
          priority: args.p_priority,
        });
        return Response.json(crypto.randomUUID());
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    // handle_subscription_downgrade: on a move to individual, all but the newest business go
    afterUpdate: (table, rows) => {
      if (table !== 'users') return;
      for (const user of rows) {
        if (user.subscription !== 'individual') continue;
        const owned = tables.businesses
          .filter((b) => b.owner_id === user.id)
          .sort((a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)),
          );
        owned.forEach((b, i) => (b.is_active = i < 1));
      }
    },
    external: async (url, init) => {
      if (url.host !== 'api.brevo.com') return undefined;
      const body = JSON.parse(String(init?.body));
      sent.push({
        to: body.to[0].email,
        subject: body.subject,
        html: body.htmlContent,
      });
      return Response.json({ messageId: 'm1' });
    },
  });
  return { fake, sent, tables };
}

const logged: string[] = [];
const capture = (...args: unknown[]) =>
  logged.push(
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
  );
console.log = capture;
console.error = capture;
console.warn = capture;

const call = async (secret: string | null = SECRET) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret !== null) headers['X-Cron-Secret'] = secret;
  const res = await handler(
    new Request('http://fn/plan-reminders', {
      method: 'POST',
      headers,
      body: '{}',
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

test('a missing or wrong secret is refused with 401, and nothing happens', () =>
  run(
    {
      users: [{ id: ALICE, subscription: 'small-business' }],
      subscriptions: [
        { id: 1, user_id: ALICE, plan: 'small-business', end_date: at(2) },
      ],
    },
    async ({ sent, tables }) => {
      assertEquals((await call(null)).status, 401);
      assertEquals((await call('wrong')).status, 401);
      assertEquals(sent, []);
      assertEquals(tables.notifications, []);
      assertEquals(tables.plan_reminder_log, []);
    },
  ));

const IN_TWO_DAYS = at(2);

test('ending in 2 days: one notification, one email, logged; a second run sends nothing', () =>
  run(
    {
      users: [{ id: ALICE, subscription: 'small-business' }],
      subscriptions: [
        {
          id: 1,
          user_id: ALICE,
          plan: 'small-business',
          end_date: IN_TWO_DAYS,
        },
      ],
      businesses: [
        business(11, ALICE, 'Harbour <Light>', 30, 'hello@harbour.example'),
        business(12, ALICE, 'Old Shop', 90, 'old@shop.example'),
      ],
    },
    async ({ sent, tables }) => {
      logged.length = 0;
      const first = await call();
      assertEquals(first.status, 200);
      assertEquals(first.body.ending, { sent: 1, skipped: 0, failed: 0 });

      const endsOn = dayMonth(new Date(`${IN_TWO_DAYS}Z`));
      assertEquals(tables.notifications.length, 1);
      const n = tables.notifications[0]!;
      assertEquals(n.user_id, ALICE);
      assertEquals(n.type, 'payment');
      assertEquals(n.priority, 'high');
      assertEquals(n.click_url, '/pricing');
      assertEquals(
        n.content,
        `Your Small Business plan ends on ${endsOn}. After that, only 1 business stays listed.`,
      );
      const meta = n.metadata as Row;
      assertEquals(
        [meta.kind, meta.actionLabel, meta.emailed, meta.plan],
        ['plan_ending', 'Renew plan', true, 'small-business'],
      );
      assertEquals(meta.endsAt, new Date(`${IN_TWO_DAYS}Z`).toISOString());

      // To the newest active business's confirmed email
      assertEquals(sent.length, 1);
      assertEquals(sent[0]!.to, 'hello@harbour.example');
      assertEquals(
        sent[0]!.subject,
        `Your Small Business plan ends on ${endsOn}`,
      );
      assertStringIncludes(
        sent[0]!.html,
        `Your Small Business plan ends on ${endsOn}. After that, only 1 business stays listed.`,
      );
      assertStringIncludes(
        sent[0]!.html,
        'href="https://avantemapsaebbcf9516.pinet.com/pricing"',
      );
      assertStringIncludes(sent[0]!.html, 'Renew in Avante Maps');
      assertStringIncludes(
        sent[0]!.html,
        'background: #2563EB; color: #ffffff',
      );

      assertEquals(
        tables.plan_reminder_log.map((l) => [l.subscription_id, l.kind]),
        [[1, 'ending']],
      );
      assert(
        !logged.join('\n').includes('harbour.example'),
        'no email address in the logs',
      );

      // Again the same day: nothing new
      const second = await call();
      assertEquals(second.body.ending, { sent: 0, skipped: 1, failed: 0 });
      assertEquals(tables.notifications.length, 1);
      assertEquals(sent.length, 1);
      // And the user wasn't touched
      assertEquals(tables.users[0]!.subscription, 'small-business');
    },
  ));

test('ending in 5 days, already renewed, or already off the paid tier: nothing', () =>
  run(
    {
      users: [
        { id: ALICE, subscription: 'organization' },
        { id: BOB, subscription: 'individual' },
        { id: 'carol', subscription: 'small-business' },
      ],
      subscriptions: [
        { id: 1, user_id: ALICE, plan: 'organization', end_date: at(5) },
        { id: 2, user_id: BOB, plan: 'small-business', end_date: at(2) },
        { id: 3, user_id: 'carol', plan: 'small-business', end_date: at(1) },
        { id: 4, user_id: 'carol', plan: 'small-business', end_date: at(31) },
      ],
    },
    async ({ sent, tables }) => {
      const res = await call();
      assertEquals(res.body.ending.sent, 0);
      assertEquals(tables.notifications, []);
      assertEquals(sent, []);
      assertEquals(tables.plan_reminder_log, []);
      // Nobody's plan has ended either
      assertEquals(
        tables.users.map((u) => u.subscription),
        ['organization', 'individual', 'small-business'],
      );
    },
  ));

test('ended: moved to Individual, plan_ended and a listing_deactivated per business switched off, emailed, logged', () =>
  run(
    {
      users: [{ id: ALICE, subscription: 'small-business' }],
      subscriptions: [
        { id: 1, user_id: ALICE, plan: 'small-business', end_date: at(-40) },
        { id: 2, user_id: ALICE, plan: 'small-business', end_date: at(-1) },
      ],
      businesses: [
        business(11, ALICE, 'Harbour Light', 5, 'hello@harbour.example'),
        business(12, ALICE, 'Dock <Deli>', 20),
        business(13, ALICE, 'Neo Finance', 60),
        { ...business(14, ALICE, 'Already Off', 90), is_active: false },
      ],
    },
    async ({ sent, tables }) => {
      logged.length = 0;
      const res = await call();
      assertEquals(res.status, 200);
      assertEquals(res.body.ended, { sent: 1, skipped: 0, failed: 0 });
      assertEquals(tables.users[0]!.subscription, 'individual');
      assertEquals(
        tables.businesses.map((b) => [b.id, b.is_active]),
        [
          [11, true],
          [12, false],
          [13, false],
          [14, false],
        ],
      );

      const kinds = tables.notifications.map((n) => (n.metadata as Row).kind);
      assertEquals(kinds, [
        'plan_ended',
        'listing_deactivated',
        'listing_deactivated',
      ]);
      const ended = tables.notifications[0]!;
      assertEquals(
        ended.content,
        "Your Small Business plan ended. You're on the Individual plan now.",
      );
      assertEquals(
        [ended.type, ended.click_url, ended.priority],
        ['payment', '/pricing', 'high'],
      );
      assertEquals((ended.metadata as Row).actionLabel, 'Renew plan');
      assertEquals((ended.metadata as Row).emailed, true);
      // Only the ones this switched off (not one that was already off)
      const deactivated = tables.notifications.slice(1);
      assertEquals(
        deactivated.map((n) => (n.metadata as Row).businessId),
        [12, 13],
      );
      assertEquals(
        deactivated[0]!.content,
        'Dock <Deli> is no longer listed because your plan ended. Renew to list it again.',
      );
      assertEquals(
        [deactivated[0]!.type, deactivated[0]!.click_url],
        ['business', '/pricing'],
      );
      assertEquals((deactivated[0]!.metadata as Row).actionLabel, 'Renew plan');

      assertEquals(sent.length, 1);
      assertEquals(sent[0]!.to, 'hello@harbour.example');
      assertEquals(sent[0]!.subject, 'Your Small Business plan has ended');
      // Escaped like all the text in the email
      assertStringIncludes(
        sent[0]!.html,
        'Your Small Business plan ended. You&#39;re on the Individual plan now.',
      );
      assertStringIncludes(
        sent[0]!.html,
        'Dock &lt;Deli&gt; is no longer listed. Renew to list it again.',
      );
      assertStringIncludes(
        sent[0]!.html,
        'href="https://avantemapsaebbcf9516.pinet.com/pricing"',
      );

      // Logged against the latest subscription
      assertEquals(
        tables.plan_reminder_log.map((l) => [l.subscription_id, l.kind]),
        [[2, 'ended']],
      );
      assert(
        !logged.join('\n').includes('harbour.example'),
        'no email address in the logs',
      );

      // Again: nothing new
      const second = await call();
      assertEquals(second.body.ended, { sent: 0, skipped: 0, failed: 0 });
      assertEquals(tables.notifications.length, 3);
      assertEquals(sent.length, 1);
    },
  ));

test('no confirmed contact email: the notifications go, with no email', () =>
  run(
    {
      users: [
        { id: ALICE, subscription: 'organization' },
        { id: BOB, subscription: 'small-business' },
      ],
      subscriptions: [
        { id: 1, user_id: ALICE, plan: 'organization', end_date: at(-1) },
        { id: 2, user_id: BOB, plan: 'small-business', end_date: at(1) },
      ],
      businesses: [
        business(11, ALICE, 'Harbour Light', 5),
        // Changed since it was confirmed: not confirmed now
        {
          ...business(21, BOB, 'Dock Deli', 5, 'old@deli.example'),
          contact_info: { email: 'new@deli.example' },
        },
      ],
    },
    async ({ sent, tables }) => {
      const res = await call();
      assertEquals(res.body.ending.sent, 1);
      assertEquals(res.body.ended.sent, 1);
      assertEquals(sent, []);
      const byKind = Object.fromEntries(
        tables.notifications.map((n) => [(n.metadata as Row).kind, n]),
      );
      assertEquals((byKind.plan_ended!.metadata as Row).emailed, false);
      assertEquals((byKind.plan_ending!.metadata as Row).emailed, false);
      assertEquals(
        byKind.plan_ended!.content,
        "Your Organization plan ended. You're on the Individual plan now.",
      );
    },
  ));

test('a paid tier with no subscription rows, or a subscription still running: left alone', () =>
  run(
    {
      users: [
        { id: ALICE, subscription: 'small-business' },
        { id: BOB, subscription: 'organization' },
      ],
      subscriptions: [
        { id: 1, user_id: BOB, plan: 'organization', end_date: at(-30) },
        { id: 2, user_id: BOB, plan: 'organization', end_date: null },
      ],
    },
    async ({ sent, tables }) => {
      const res = await call();
      assertEquals(res.body.ended, { sent: 0, skipped: 2, failed: 0 });
      assertEquals(
        tables.users.map((u) => u.subscription),
        ['small-business', 'organization'],
      );
      assertEquals(tables.notifications, []);
      assertEquals(sent, []);
    },
  ));

test("one user's failure doesn't stop the next, and a failed reminder is tried again tomorrow", () =>
  run(
    {
      users: [
        { id: ALICE, subscription: 'small-business' },
        { id: BOB, subscription: 'small-business' },
      ],
      subscriptions: [
        { id: 1, user_id: ALICE, plan: 'small-business', end_date: at(1) },
        { id: 2, user_id: BOB, plan: 'small-business', end_date: at(2) },
      ],
      failNotificationsFor: [ALICE],
    },
    async ({ tables }) => {
      const res = await call();
      assertEquals(res.status, 200);
      assertEquals(res.body.ending, { sent: 1, skipped: 0, failed: 1 });
      assertEquals(
        tables.notifications.map((n) => n.user_id),
        [BOB],
      );
      // Alice's claim was freed, Bob's kept
      assertEquals(
        tables.plan_reminder_log.map((l) => l.subscription_id),
        [2],
      );
    },
  ));

test('an ended plan that fails after the downgrade keeps its claim (no second downgrade or notice)', () =>
  run(
    {
      users: [
        { id: ALICE, subscription: 'small-business' },
        { id: BOB, subscription: 'small-business' },
      ],
      subscriptions: [
        { id: 1, user_id: ALICE, plan: 'small-business', end_date: at(-1) },
        { id: 2, user_id: BOB, plan: 'small-business', end_date: at(-2) },
      ],
      failNotificationsFor: [ALICE],
    },
    async ({ tables }) => {
      const res = await call();
      assertEquals(res.body.ended, { sent: 1, skipped: 0, failed: 1 });
      assertEquals(
        tables.users.map((u) => u.subscription),
        ['individual', 'individual'],
      );
      assertEquals(
        tables.notifications.map((n) => [n.user_id, (n.metadata as Row).kind]),
        [[BOB, 'plan_ended']],
      );
      assertEquals(
        tables.plan_reminder_log.map((l) => l.subscription_id).sort(),
        [1, 2],
      );
    },
  ));
