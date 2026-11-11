/**
 * Unit tests for complete-payment with Supabase, Pi's API and auth mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 deno test --no-lock --allow-env --allow-net --allow-read supabase/functions/complete-payment/index.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { installFakeSupabase, loadHandler, setFunctionEnv, type Row } from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
Deno.env.set('PI_API_KEY', 'test-pi-key');
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const OWNER = '00000000-0000-0000-0000-0000000000a1';
// The owner's uid in this Pi app: what Pi reports as the payment's user_uid and from /me
const OWNER_PI_UID = 'pi-uid-owner-0001';
const OWNER_USERNAME = 'JordynDaniel';
const PI_TOKEN = 'pi-access-token-0001';
const PAYMENT_ID = 'pay_1';
const MAINNET_KEY = 'test-pi-mainnet-key';
const TXID = 'abc123';

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const PLAN = { subscriptionTier: 'small-business', frequency: 'monthly' };
const APPROVED = { approved: true, verified: false, completed: false, cancelled: false };
const approvedRow = (extra: Row = {}): Row => ({
  payment_id: PAYMENT_ID,
  user_id: OWNER,
  amount: 65.19,
  metadata: PLAN,
  status: APPROVED,
  approved_amount_pi: 65.19,
  ...extra,
});

interface SetupOptions {
  rows?: Row[];
  piAmount?: number;
  priceUsd?: number;
  rpcError?: string;
  piAlreadyCompleted?: boolean;
  /** Pi's body when it says already completed (default: a message field) */
  piAlreadyCompletedBody?: object;
  /** Who Pi says paid (default: the owner's Pi account) */
  piUserUid?: string | null;
  /** What Pi's /me answers (default: the owner, in this app) */
  me?: { uid?: string; username?: string };
  /** How many of Pi's /me calls fail with a 401 first */
  meFailures?: number;
  /** users.pi_uid for the signed-in user */
  ownerPiUid?: string | null;
  /** users.username for the signed-in user */
  ownerUsername?: string | null;
  /** How many of Pi's GET /payments/{id} calls fail first */
  piGetFailures?: number;
  /** How many credit_wallet_balance calls fail first */
  creditFailures?: number;
  /** How many message_fees writes fail first */
  feeFailures?: number;
  /** With both apps' keys set: the app that has the payment (the other key gets 404 payment_not_found) */
  piApp?: 'testnet' | 'mainnet';
}

function setup(options: SetupOptions = {}) {
  const rpcCalls: Row[] = [];
  const credits: Row[] = [];
  const meAuth: (string | null)[] = [];
  const piCompletes: string[] = [];
  // Every Pi payments call as "action:app", the app being the one whose key made it
  const piByApp: string[] = [];
  let meFailures = options.meFailures ?? 0;
  let piGetFailures = options.piGetFailures ?? 0;
  let creditFailures = options.creditFailures ?? 0;
  let feeFailures = options.feeFailures ?? 0;
  // handle_subscription_after_payment: one grant per payment, as the database does now
  const grantedPayments = new Set<string>();
  const fake = installFakeSupabase({
    tables: {
      pi_price: [{ id: 1, price_usd: options.priceUsd ?? 0.0767 }],
      payments: options.rows ?? [approvedRow()],
      notifications: [],
      users: [{
        id: OWNER,
        pi_uid: options.ownerPiUid === undefined ? OWNER_PI_UID : options.ownerPiUid,
        username: options.ownerUsername === undefined ? OWNER_USERNAME : options.ownerUsername,
      }],
      wallet_ledger: [],
      message_fees: [],
    },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      if (url.pathname === '/v2/me') {
        meAuth.push(new Headers(init?.headers).get('authorization'));
        if (meFailures > 0) {
          meFailures -= 1;
          return new Response('expired', { status: 401 });
        }
        return Response.json(options.me ?? { uid: OWNER_PI_UID, username: OWNER_USERNAME });
      }
      const key = (
        new Headers(init?.headers).get('authorization') ?? ''
      ).replace('Key ', '');
      const keyApp =
        key === 'test-pi-key'
          ? 'testnet'
          : key === MAINNET_KEY
            ? 'mainnet'
            : 'unknown key';
      const action = url.pathname.split('/').pop();
      piByApp.push(`${action === PAYMENT_ID ? 'get' : action}:${keyApp}`);
      if (options.piApp && keyApp !== options.piApp) {
        return Response.json(
          { error: 'payment_not_found', error_message: 'Payment not found' },
          { status: 404 },
        );
      }
      if (url.pathname.endsWith('/complete')) piCompletes.push(url.pathname);
      if (url.pathname.endsWith('/complete') && options.piAlreadyCompleted) {
        const body = options.piAlreadyCompletedBody ?? {
          error: 'already_completed',
          message: 'This payment was already completed',
        };
        return Response.json(body, { status: 400 });
      }
      if (init?.method === 'GET' && piGetFailures > 0) {
        piGetFailures -= 1;
        return new Response('unavailable', { status: 503 });
      }
      return Response.json({
        identifier: PAYMENT_ID,
        amount: options.piAmount ?? 65.19,
        user_uid: options.piUserUid === undefined ? OWNER_PI_UID : options.piUserUid,
      });
    },
    rpc: (name, args) => {
      if (name === 'credit_wallet_balance') {
        credits.push(args);
        if (creditFailures > 0) {
          creditFailures -= 1;
          return Response.json({ code: 'XX000', message: 'credit failed' }, { status: 500 });
        }
        // As the database does: once per payment, the balance either way
        const ledger = fake.tables['wallet_ledger']!;
        if (!ledger.some((l) => l['payment_id'] === args['p_payment_id'])) {
          ledger.push({ id: ledger.length + 1, user_id: args['p_user_id'], amount_pi: args['p_amount_pi'], payment_id: args['p_payment_id'] });
        }
        return Response.json(ledger.reduce((n, l) => n + Number(l['amount_pi']), 0));
      }
      assertEquals(name, 'handle_subscription_after_payment');
      rpcCalls.push(args);
      if (options.rpcError) return Response.json({ code: 'P0001', message: options.rpcError }, { status: 400 });
      const paymentId = String(args['p_payment_id']);
      if (grantedPayments.has(paymentId)) return Response.json(false);
      grantedPayments.add(paymentId);
      return Response.json(true);
    },
    failInserts: [],
  });
  // message_fees writes can fail first (the fake's failInserts is all or nothing)
  if (feeFailures > 0) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = (input instanceof Request ? input.method : init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/rest/v1/message_fees' && method === 'POST' && feeFailures > 0) {
        feeFailures -= 1;
        return Promise.resolve(Response.json({ code: 'XX000', message: 'fee insert failed' }, { status: 500 }));
      }
      return realFetch(input, init);
    };
    const restore = fake.restore;
    fake.restore = () => {
      globalThis.fetch = realFetch;
      restore();
    };
  }
  return {
    fake,
    rpcCalls,
    credits,
    meAuth,
    piCompletes,
    piByApp,
    row: () => fake.tables['payments']![0],
    notifications: () => fake.tables['notifications']!,
    ledger: () => fake.tables['wallet_ledger']!,
    fees: () => fake.tables['message_fees']!,
  };
}

const call = async (metadata: Record<string, unknown> = PLAN) => {
  const res = await handler(
    new Request('http://fn/complete-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: PAYMENT_ID, txid: TXID, userId: OWNER, amount: 65.19, memo: 'Small Business plan (monthly)', metadata, piAccessToken: PI_TOKEN }),
    }),
  );
  return { status: res.status, json: await res.json() };
};

test('with approved_amount_pi: passes even if pi_price has moved a lot', async () => {
  const { fake, rpcCalls, notifications } = setup({ priceUsd: 0.01 }); // The plan now "costs" 500 π
  const { status, json } = await call();
  assertEquals([status, json.success, json.subscriptionCreated], [200, true, true]);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0]!['p_frequency'], 'monthly');
  assertEquals(notifications().length, 1);
  // The same text as before, now with the kind, action and link
  const n = notifications()[0]!;
  assertEquals(n['content'], 'Payment of 65.19 Pi received. Your Small Business plan is now active.');
  assertEquals(n['click_url'], '/pricing');
  assertEquals(n['type'], 'payment');
  assertEquals((n['metadata'] as Row)['kind'], 'plan_paid');
  assertEquals((n['metadata'] as Row)['actionLabel'], 'View plan');
  assertEquals((n['metadata'] as Row)['tier'], 'small-business');
  fake.restore();
});

test('with approved_amount_pi: an amount below it is refused', async () => {
  const { fake, rpcCalls } = setup({ piAmount: 10 });
  const { status } = await call();
  assertEquals(status, 400);
  assertEquals(rpcCalls.length, 0);
  fake.restore();
});

for (const metadata of [
  { subscriptionTier: 'organization', frequency: 'monthly' },
  { subscriptionTier: 'small-business', frequency: 'annual' },
]) {
  test(`an approval for a cheap plan cannot complete as ${metadata.subscriptionTier} ${metadata.frequency}`, async () => {
    const { fake, rpcCalls } = setup();
    assertEquals((await call(metadata)).status, 400);
    assertEquals(rpcCalls.length, 0);
    fake.restore();
  });
}

test('without approved_amount_pi: falls back to the price check, which passes at the price', async () => {
  const { fake, rpcCalls } = setup({ rows: [approvedRow({ approved_amount_pi: null })] });
  const { status } = await call();
  assertEquals(status, 200);
  assertEquals(rpcCalls.length, 1);
  fake.restore();
});

test('without approved_amount_pi: the price check refuses an amount below the price', async () => {
  const { fake, rpcCalls } = setup({ rows: [approvedRow({ approved_amount_pi: null })], piAmount: 5 });
  const { status } = await call();
  assertEquals(status, 400);
  assertEquals(rpcCalls.length, 0);
  fake.restore();
});

test('annual is recorded as annual', async () => {
  const annual = { subscriptionTier: 'small-business', frequency: 'annual' };
  const { fake, rpcCalls } = setup({ rows: [approvedRow({ metadata: annual, approved_amount_pi: 625.82 })], piAmount: 625.82 });
  assertEquals((await call(annual)).status, 200);
  assertEquals(rpcCalls[0]!['p_frequency'], 'annual');
  fake.restore();
});

test('the plan fails to activate: 500 plan_not_activated, no success, and one plan_not_activated notification', async () => {
  const { fake, row, notifications } = setup({ rpcError: 'No completed payment found' });
  const { status, json } = await call();
  assertEquals(status, 500);
  assertEquals(json.success, false);
  assertEquals(json.error_code, 'plan_not_activated');
  assertEquals(json.message, 'Payment received, but your plan could not be activated. Please contact support.');
  assert(!JSON.stringify(json).includes('No completed payment'));
  assertEquals(notifications().length, 1);
  const n = notifications()[0]!;
  assertEquals(n['user_id'], OWNER);
  assertEquals(n['type'], 'payment');
  assertEquals(n['priority'], 'high');
  assertEquals(n['content'], "Payment received for the Small Business plan, but your plan isn't active yet. Contact support and we'll sort it out.");
  assertEquals(n['click_url'], '/contact');
  assertEquals((n['metadata'] as Row)['kind'], 'plan_not_activated');
  assertEquals((n['metadata'] as Row)['actionLabel'], 'Contact support');
  assert(!String(n['content']).includes('No completed payment'), 'not the database error');
  // Not cancelled: the Pi has moved
  assertEquals(row()!['status'], { approved: true, verified: true, completed: true, cancelled: false, error: 'plan_not_activated' });
  fake.restore();
});

test('a retry after that does not report success', async () => {
  const { fake, rpcCalls, notifications } = setup({ rpcError: 'boom' });
  assertEquals((await call()).status, 500);
  const retry = await call();
  assertEquals([retry.status, retry.json.success, retry.json.error_code], [500, false, 'plan_not_activated']);
  assertEquals(rpcCalls.length, 1);
  // Told once, when it happened: the retry adds nothing
  assertEquals(notifications().length, 1);
  assertEquals((notifications()[0]!['metadata'] as Row)['kind'], 'plan_not_activated');
  fake.restore();
});

test('a retry after a success still reports success, without granting twice', async () => {
  const { fake, rpcCalls } = setup();
  assertEquals((await call()).status, 200);
  const retry = await call();
  assertEquals([retry.status, retry.json.success], [200, true]);
  assertEquals(rpcCalls.length, 1);
  fake.restore();
});

test('a top-up: unchanged, credited with no plan, and a topup_received notification', async () => {
  const fake = installFakeSupabase({
    tables: {
      payments: [approvedRow({ metadata: { kind: 'wallet_topup' }, approved_amount_pi: null })],
      notifications: [],
      users: [{ id: OWNER, pi_uid: OWNER_PI_UID, username: OWNER_USERNAME }],
    },
    users: { 'owner-token': OWNER },
    external: (url) => url.pathname === '/v2/me'
      ? Response.json({ uid: OWNER_PI_UID, username: OWNER_USERNAME })
      : Response.json({ identifier: PAYMENT_ID, amount: 3, user_uid: OWNER_PI_UID }),
    rpc: (name, args) => {
      assertEquals(name, 'credit_wallet_balance');
      assertEquals(args['p_amount_pi'], 3);
      return Response.json(3);
    },
  });
  const { status, json } = await call({ kind: 'wallet_topup' });
  assertEquals([status, json.success, json.newBalance], [200, true, 3]);
  const notes = fake.tables['notifications']!;
  assertEquals(notes.length, 1);
  assertEquals(notes[0]!['content'], 'Payment of 3 Pi received successfully!');
  assertEquals(notes[0]!['click_url'], '/wallet');
  assertEquals((notes[0]!['metadata'] as Row)['kind'], 'topup_received');
  assertEquals((notes[0]!['metadata'] as Row)['actionLabel'], 'Open wallet');
  fake.restore();
});

// ---- "Already completed" must not mean success without the plan

const COMPLETED = { approved: true, verified: true, completed: true, cancelled: false };
const MISMATCH_MESSAGE = "Payment received, but it doesn't match the price. Please contact support.";

test('a fresh payment writes plan_activated', async () => {
  const { fake, row } = setup();
  assertEquals((await call()).status, 200);
  assertEquals(row()!['status'], { ...COMPLETED, plan_activated: true });
  fake.restore();
});

test('Pi says already completed, approved plan row: amount checked, plan granted once, recorded', async () => {
  const { fake, rpcCalls, row, notifications } = setup({ piAlreadyCompleted: true });
  const { status, json } = await call();
  assertEquals([status, json.success], [200, true]);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0]!['p_subscription_tier'], 'small-business');
  assertEquals(row()!['status'], { ...COMPLETED, plan_activated: true });
  assertEquals(row()!['txid'], TXID);
  assertEquals(notifications().length, 1);
  // A retry doesn't grant again
  assertEquals((await call()).status, 200);
  assertEquals(rpcCalls.length, 1);
  fake.restore();
});

test('Pi says already completed, and the amount is below what was approved: refused and marked', async () => {
  const { fake, rpcCalls, row } = setup({ piAlreadyCompleted: true, piAmount: 5 });
  const { status, json } = await call();
  assertEquals([status, json.error_code], [400, 'amount_mismatch_after_completion']);
  assertEquals(rpcCalls.length, 0);
  assertEquals((row()!['status'] as Row)['error'], 'amount_mismatch_after_completion');
  fake.restore();
});

test('Pi says already completed, plan_activated already true: no second grant, success, flag kept', async () => {
  const { fake, rpcCalls, row, notifications } = setup({
    piAlreadyCompleted: true,
    rows: [approvedRow({ status: { ...APPROVED, plan_activated: true } })],
  });
  const { status, json } = await call();
  assertEquals([status, json.success], [200, true]);
  assertEquals(rpcCalls.length, 0);
  assertEquals(notifications().length, 0);
  assertEquals((row()!['status'] as Row)['plan_activated'], true);
  fake.restore();
});

test('Pi says already completed, old row with no approved_amount_pi: no grant, success as today', async () => {
  const { fake, rpcCalls, notifications } = setup({
    piAlreadyCompleted: true,
    rows: [approvedRow({ approved_amount_pi: null })],
  });
  const { status, json } = await call();
  assertEquals([status, json.success], [200, true]);
  assertEquals(rpcCalls.length, 0);
  assertEquals(notifications().length, 0);
  fake.restore();
});

test('Pi says already completed, top up: credited (idempotent there), success', async () => {
  const topUp = { kind: 'wallet_topup' };
  const { fake, credits, row } = setup({
    piAlreadyCompleted: true,
    piAmount: 3,
    rows: [approvedRow({ metadata: topUp, approved_amount_pi: null })],
  });
  const { status, json } = await call(topUp);
  assertEquals([status, json.success], [200, true]);
  assertEquals(credits.length, 1);
  assertEquals(credits[0]!['p_amount_pi'], 3);
  assertEquals(credits[0]!['p_payment_id'], PAYMENT_ID);
  assertEquals((row()!['status'] as Row)['completed'], true);
  fake.restore();
});

test('Pi says already completed with no row at all: nothing credited for a stranger\'s payment', async () => {
  const { fake, credits, rpcCalls } = setup({ piAlreadyCompleted: true, rows: [] });
  const { status } = await call({ kind: 'wallet_topup' });
  assertEquals(status, 200);
  assertEquals(credits.length, 0);
  assertEquals(rpcCalls.length, 0);
  fake.restore();
});

test('Pi says already completed: a row of another kind cannot be claimed as a top up', async () => {
  const { fake, credits } = setup({ piAlreadyCompleted: true, rows: [approvedRow({ approved_amount_pi: null })] });
  assertEquals((await call({ kind: 'wallet_topup' })).status, 200);
  assertEquals(credits.length, 0);
  fake.restore();
});

for (const piAlreadyCompleted of [false, true]) {
  test(`an approved plan can't be completed as a top up as well (Pi already completed: ${piAlreadyCompleted})`, async () => {
    const { fake, credits, rpcCalls } = setup({ piAlreadyCompleted });
    assertEquals((await call({ kind: 'wallet_topup' })).status, 400);
    assertEquals(credits.length, 0);
    // A retry grants the plan that was paid for, and nothing is credited
    assertEquals((await call()).status, 200);
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0]!['p_subscription_tier'], 'small-business');
    assertEquals(credits.length, 0);
    fake.restore();
  });
}

test('the amount check failing after completion: 400, marked, and a retry gets the same failure', async () => {
  const { fake, rpcCalls, row, notifications } = setup({ piAmount: 10 });
  const first = await call();
  assertEquals([first.status, first.json.success, first.json.error_code, first.json.message], [400, false, 'amount_mismatch_after_completion', MISMATCH_MESSAGE]);
  assertEquals(row()!['status'], { ...COMPLETED, error: 'amount_mismatch_after_completion' });
  const retry = await call();
  assertEquals([retry.status, retry.json.success, retry.json.error_code, retry.json.message], [400, false, 'amount_mismatch_after_completion', MISMATCH_MESSAGE]);
  assertEquals(rpcCalls.length, 0);
  assertEquals(notifications().length, 0);
  fake.restore();
});

test('the same for an older row, checked against the price', async () => {
  const { fake, row } = setup({ rows: [approvedRow({ approved_amount_pi: null })], piAmount: 5 });
  assertEquals((await call()).json.error_code, 'amount_mismatch_after_completion');
  assertEquals((row()!['status'] as Row)['error'], 'amount_mismatch_after_completion');
  assertEquals((await call()).json.error_code, 'amount_mismatch_after_completion');
  fake.restore();
});

test('the same for a message fee', async () => {
  const fee = { kind: 'message_fee', feePi: 0.5 };
  const { fake, row } = setup({ rows: [approvedRow({ metadata: fee, approved_amount_pi: null })], piAmount: 0.1 });
  assertEquals((await call(fee)).json.error_code, 'amount_mismatch_after_completion');
  assertEquals((row()!['status'] as Row)['error'], 'amount_mismatch_after_completion');
  assertEquals((await call(fee)).json.error_code, 'amount_mismatch_after_completion');
  fake.restore();
});

test('a completed plan row with no plan_activated and no error: granted once, from the row', async () => {
  const annual = { subscriptionTier: 'small-business', frequency: 'annual' };
  const { fake, rpcCalls, row, notifications } = setup({
    rows: [approvedRow({ metadata: annual, approved_amount_pi: 625.82, status: COMPLETED, txid: TXID })],
  });
  // Whatever the request claims, the row says what was paid for
  const { status, json } = await call({ subscriptionTier: 'organization', frequency: 'annual' });
  assertEquals([status, json.success], [200, true]);
  assertEquals(rpcCalls.length, 1);
  assertEquals(rpcCalls[0]!['p_subscription_tier'], 'small-business');
  assertEquals(rpcCalls[0]!['p_frequency'], 'annual');
  assertEquals(row()!['status'], { ...COMPLETED, plan_activated: true });
  assertEquals(notifications().length, 1);
  assert(String(notifications()[0]!['content']).includes('625.82'));
  assertEquals((await call()).status, 200);
  assertEquals(rpcCalls.length, 1);
  assertEquals(notifications().length, 1);
  fake.restore();
});

test('the same, if the grant fails: plan_not_activated, and a retry gets it too', async () => {
  const { fake, rpcCalls, row, notifications } = setup({ rpcError: 'boom', rows: [approvedRow({ status: COMPLETED, txid: TXID })] });
  assertEquals((await call()).json.error_code, 'plan_not_activated');
  assertEquals((row()!['status'] as Row)['error'], 'plan_not_activated');
  assertEquals((await call()).json.error_code, 'plan_not_activated');
  assertEquals(rpcCalls.length, 1);
  assertEquals(notifications().map((n) => (n['metadata'] as Row)['kind']), ['plan_not_activated']);
  fake.restore();
});

test('an old completed row (like 25 March) never gets a plan again', async () => {
  const { fake, rpcCalls, notifications } = setup({
    rows: [approvedRow({ approved_amount_pi: null, status: COMPLETED, txid: TXID })],
  });
  const { status, json } = await call();
  assertEquals([status, json.success], [200, true]);
  assertEquals(rpcCalls.length, 0);
  assertEquals(notifications().length, 0);
  fake.restore();
});

// ---- Who paid: the Pi account must be the signed-in user's

const TOPUP = { kind: 'wallet_topup' };
const FEE = { kind: 'message_fee', conversationId: '11111111-1111-4111-8111-111111111111', businessId: 7, feePi: 0.5 };
const MISMATCH = "This payment was started from a different Pi account. Sign in with the account you're paying from.";

for (const [kind, metadata, amount, row] of [
  ['top up', TOPUP, 3, approvedRow({ metadata: TOPUP, approved_amount_pi: null })],
  ['message fee', FEE, 0.5, approvedRow({ metadata: FEE, approved_amount_pi: null })],
  ['plan', PLAN, 65.19, approvedRow()],
] as const) {
  test(`paid from another Pi account (${kind}): 403, nothing credited, recorded or granted, row marked; a retry gets the same`, async () => {
    const { fake, credits, rpcCalls, row: current, notifications, fees } = setup({ piAmount: amount, piUserUid: 'pi-uid-someone-else', rows: [row] });
    const first = await call(metadata);
    assertEquals(first.status, 403);
    assertEquals([first.json.success, first.json.error_code, first.json.message], [false, 'payment_user_mismatch', MISMATCH]);
    assertEquals(credits.length, 0);
    assertEquals(rpcCalls.length, 0);
    assertEquals(fees().length, 0);
    assertEquals(notifications().length, 0);
    // The Pi has moved: completed, and marked
    assertEquals(current()!['status'], { approved: true, verified: true, completed: true, cancelled: false, error: 'payment_user_mismatch' });
    const retry = await call(metadata);
    assertEquals([retry.status, retry.json.error_code], [403, 'payment_user_mismatch']);
    assertEquals(credits.length + rpcCalls.length + fees().length, 0);
    fake.restore();
  });
}

const topUpRow = () => approvedRow({ metadata: TOPUP, approved_amount_pi: null });

// The owner's case: signed in through the Mainnet app, paying in the Testnet app
test("users.pi_uid is another app's uid, and /me matches the payment: credited", async () => {
  const { fake, credits, meAuth } = setup({ piAmount: 3, ownerPiUid: 'pi-uid-from-the-other-app', rows: [topUpRow()] });
  const { status, json } = await call(TOPUP);
  assertEquals([status, json.success], [200, true]);
  assertEquals(credits.length, 1);
  assertEquals(meAuth, [`Bearer ${PI_TOKEN}`]); // The user's token, once, never the API key
  fake.restore();
});

test('the signed-in user has no pi_uid: not needed any more, credited', async () => {
  const { fake, credits } = setup({ piAmount: 3, ownerPiUid: null, rows: [topUpRow()] });
  assertEquals((await call(TOPUP)).status, 200);
  assertEquals(credits.length, 1);
  fake.restore();
});

test('the username matches in a different case: credited', async () => {
  const { fake, credits } = setup({ piAmount: 3, me: { uid: OWNER_PI_UID, username: 'JORDYNdaniel' }, rows: [topUpRow()] });
  assertEquals((await call(TOPUP)).status, 200);
  assertEquals(credits.length, 1);
  fake.restore();
});

for (const [name, options] of [
  ["the token holder isn't the payer in this app", { me: { uid: 'pi-uid-someone-else', username: OWNER_USERNAME } }],
  ["the payer's username isn't this account's", { me: { uid: OWNER_PI_UID, username: 'SomeoneElse' } }],
  ['the signed-in user has no username', { ownerUsername: null }],
] as const) {
  test(`${name}: 403, nothing credited, row marked; a retry gets the same`, async () => {
    const { fake, credits, row: current } = setup({ piAmount: 3, ...options, rows: [topUpRow()] });
    const first = await call(TOPUP);
    assertEquals([first.status, first.json.error_code, first.json.message], [403, 'payment_user_mismatch', MISMATCH]);
    assertEquals(credits.length, 0);
    assertEquals(current()!['status'], { approved: true, verified: true, completed: true, cancelled: false, error: 'payment_user_mismatch' });
    const retry = await call(TOPUP);
    assertEquals([retry.status, retry.json.error_code], [403, 'payment_user_mismatch']);
    assertEquals(credits.length, 0);
    fake.restore();
  });
}

const TOKEN_INVALID_MESSAGE = 'Your Pi sign-in has expired. Close and reopen Avante Maps, then try again.';

test("/me says 401: 401 pi_token_invalid, Pi not told to complete, row untouched, and a retry works", async () => {
  const { fake, credits, piCompletes, row: current } = setup({ piAmount: 3, meFailures: 1, rows: [topUpRow()] });
  const first = await call(TOPUP);
  assertEquals([first.status, first.json.error_code, first.json.message], [401, 'pi_token_invalid', TOKEN_INVALID_MESSAGE]);
  assertEquals(piCompletes.length, 0);
  assertEquals(credits.length, 0);
  assertEquals(current()!['status'], APPROVED);
  const retry = await call(TOPUP);
  assertEquals([retry.status, retry.json.success], [200, true]);
  assertEquals(piCompletes.length, 1);
  assertEquals(credits.length, 1);
  fake.restore();
});

test('/me says 401 on the recovery of a completed row: 401, nothing marked, and a retry credits it', async () => {
  const { fake, credits, row: current } = setup({
    piAmount: 3,
    meFailures: 1,
    rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null, txid: TXID, status: COMPLETED })],
  });
  const first = await call(TOPUP);
  assertEquals([first.status, first.json.error_code], [401, 'pi_token_invalid']);
  assertEquals(credits.length, 0);
  assertEquals(current()!['status'], COMPLETED);
  assertEquals((await call(TOPUP)).status, 200);
  assertEquals(credits.length, 1);
  fake.restore();
});

test('no piAccessToken (an old client): 400 pi_token_missing, Pi not called, row untouched', async () => {
  const { fake, meAuth, piCompletes, row: current } = setup({ piAmount: 3, rows: [topUpRow()] });
  const res = await handler(
    new Request('http://fn/complete-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: PAYMENT_ID, txid: TXID, userId: OWNER, amount: 3, memo: 'Top up', metadata: TOPUP }),
    }),
  );
  const json = await res.json();
  assertEquals([res.status, json.error_code], [400, 'pi_token_missing']);
  assertEquals([meAuth, piCompletes], [[], []]);
  assertEquals(current()!['status'], APPROVED);
  fake.restore();
});

test('logs never hold a whole Pi uid', async () => {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    const { fake } = setup({ piAmount: 3, piUserUid: 'pi-uid-someone-else', rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })] });
    await call(TOPUP);
    fake.restore();
  } finally {
    Object.assign(console, original);
  }
  const output = lines.join('\n');
  assert(!output.includes('pi-uid-someone-else'), output);
  assert(!output.includes(OWNER_PI_UID), output);
  assert(!output.includes(OWNER_USERNAME), output);
  assert(!output.includes(PI_TOKEN), output);
});

// ---- Top ups and message fees can't be lost on a retry

test('a top up whose credit failed: a retry credits it once and returns newBalance; another retry credits nothing', async () => {
  const { fake, credits, row, ledger, notifications } = setup({
    piAmount: 3,
    creditFailures: 1,
    rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })],
  });
  const first = await call(TOPUP);
  assertEquals(first.status, 500);
  assertEquals(ledger().length, 0);
  assertEquals(row()!['status'], { approved: true, verified: true, completed: true, cancelled: false });

  // The retry finds the row completed but not credited, and finishes the job from the row
  const retry = await call({ kind: 'wallet_topup' });
  assertEquals([retry.status, retry.json.success, retry.json.newBalance], [200, true, 3]);
  assertEquals(ledger().length, 1);
  assertEquals(ledger()[0]!['amount_pi'], 3);
  assertEquals((row()!['status'] as Row)['credited'], true);
  assertEquals(notifications().map((n) => (n['metadata'] as Row)['kind']), ['topup_received']);

  const again = await call(TOPUP);
  assertEquals([again.status, again.json.message], [200, 'Payment was already completed']);
  assertEquals(ledger().length, 1);
  assertEquals(credits.length, 2);
  assertEquals(notifications().length, 1);
  fake.restore();
});

test("a top up whose Pi amount couldn't be read: 502, then a retry credits it from Pi's amount", async () => {
  const { fake, ledger, row } = setup({ piAmount: 4.5, piGetFailures: 1, rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })] });
  assertEquals((await call(TOPUP)).status, 502);
  assertEquals(ledger().length, 0);
  assertEquals((row()!['status'] as Row)['completed'], true);
  const retry = await call(TOPUP);
  assertEquals([retry.status, retry.json.newBalance], [200, 4.5]);
  assertEquals((row()!['status'] as Row)['credited'], true);
  fake.restore();
});

test("the retry uses the row's metadata, not the request's", async () => {
  const { fake, ledger, rpcCalls } = setup({ piAmount: 3, piGetFailures: 1, rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })] });
  assertEquals((await call(TOPUP)).status, 502);
  // The retry claims a plan: the row says top up
  const retry = await call(PLAN);
  assertEquals([retry.status, retry.json.newBalance], [200, 3]);
  assertEquals(ledger().length, 1);
  assertEquals(rpcCalls.length, 0);
  fake.restore();
});

test("Pi unreachable on the retry: 502, and it stays retryable", async () => {
  const { fake, ledger, row } = setup({ piAmount: 3, piGetFailures: 2, rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })] });
  assertEquals((await call(TOPUP)).status, 502);
  assertEquals((await call(TOPUP)).status, 502);
  assertEquals(row()!['status'], { approved: true, verified: true, completed: true, cancelled: false });
  assertEquals((await call(TOPUP)).json.newBalance, 3);
  assertEquals(ledger().length, 1);
  fake.restore();
});

test('a top up credited before this change (no flag): the retry marks it and credits nothing more, with no second notice', async () => {
  const { fake, ledger, row, notifications } = setup({
    piAmount: 3,
    rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null, status: { approved: true, verified: true, completed: true, cancelled: false }, txid: TXID })],
  });
  fake.tables['wallet_ledger']!.push({ id: 1, user_id: OWNER, amount_pi: 3, payment_id: PAYMENT_ID });
  const { status, json } = await call(TOPUP);
  assertEquals([status, json.newBalance], [200, 3]);
  assertEquals(ledger().length, 1);
  assertEquals((row()!['status'] as Row)['credited'], true);
  assertEquals(notifications().length, 0);
  fake.restore();
});

test("a message fee whose amount couldn't be read: a retry records it once, at the platform fee; another retry records nothing", async () => {
  const { fake, fees, row, notifications } = setup({ piAmount: 0.5, piGetFailures: 1, rows: [approvedRow({ metadata: FEE, approved_amount_pi: null })] });
  assertEquals((await call(FEE)).status, 502);
  assertEquals(fees().length, 0);
  const retry = await call({ kind: 'message_fee', conversationId: FEE.conversationId, businessId: 7, feePi: 99 });
  assertEquals([retry.status, retry.json.success], [200, true]);
  assertEquals(fees().length, 1);
  assertEquals(fees()[0]!['fee_pi'], 0.5);
  assertEquals(fees()[0]!['conversation_id'], FEE.conversationId);
  assertEquals((row()!['status'] as Row)['fee_recorded'], true);
  assertEquals(notifications().length, 1);
  const again = await call(FEE);
  assertEquals([again.status, again.json.message], [200, 'Payment was already completed']);
  assertEquals(fees().length, 1);
  assertEquals(notifications().length, 1);
  fake.restore();
});

test('a message fee whose row failed to write: 500 (not success), and a retry records it', async () => {
  const { fake, fees, row } = setup({ piAmount: 0.5, feeFailures: 1, rows: [approvedRow({ metadata: FEE, approved_amount_pi: null })] });
  const first = await call(FEE);
  assertEquals([first.status, first.json.success], [500, false]);
  assertEquals((row()!['status'] as Row)['fee_recorded'], undefined);
  const retry = await call(FEE);
  assertEquals(retry.status, 200);
  assertEquals(fees().length, 1);
  assertEquals((row()!['status'] as Row)['fee_recorded'], true);
  fake.restore();
});

test('a message fee below the platform fee on the retry: refused and marked, nothing recorded', async () => {
  const { fake, fees, row } = setup({ piAmount: 0.1, piGetFailures: 1, rows: [approvedRow({ metadata: FEE, approved_amount_pi: null })] });
  assertEquals((await call(FEE)).status, 502);
  const retry = await call(FEE);
  assertEquals([retry.status, retry.json.error_code], [400, 'amount_mismatch_after_completion']);
  assertEquals(fees().length, 0);
  assertEquals((row()!['status'] as Row)['error'], 'amount_mismatch_after_completion');
  fake.restore();
});

test('a fresh top up and a fresh fee set their flags', async () => {
  const topUp = setup({ piAmount: 3, rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })] });
  assertEquals((await call(TOPUP)).status, 200);
  assertEquals((topUp.row()!['status'] as Row)['credited'], true);
  topUp.fake.restore();
  const fee = setup({ piAmount: 0.5, rows: [approvedRow({ metadata: FEE, approved_amount_pi: null })] });
  assertEquals((await call(FEE)).status, 200);
  assertEquals((fee.row()!['status'] as Row)['fee_recorded'], true);
  fee.fake.restore();
});

test('Pi says already completed, top up with no flag: reaches the credit and sets it', async () => {
  const { fake, ledger, row } = setup({ piAlreadyCompleted: true, piAmount: 3, rows: [approvedRow({ metadata: TOPUP, approved_amount_pi: null })] });
  const { status, json } = await call(TOPUP);
  assertEquals([status, json.newBalance], [200, 3]);
  assertEquals(ledger().length, 1);
  assertEquals((row()!['status'] as Row)['credited'], true);
  fake.restore();
});

// ---- A plan is granted once per payment

test('the plan granted twice in a row for one payment (the database says false the second time): one notification', async () => {
  const { fake, rpcCalls, row, notifications } = setup();
  assertEquals((await call()).status, 200);
  assertEquals(rpcCalls[0]!['p_payment_id'], PAYMENT_ID);
  // The recovery path runs again (as if it raced the first): the database refuses a second grant
  (row()!['status'] as Row)['plan_activated'] = false;
  delete (row()!['status'] as Row)['plan_activated'];
  const again = await call();
  assertEquals([again.status, again.json.success], [200, true]);
  assertEquals(rpcCalls.length, 2);
  assertEquals((row()!['status'] as Row)['plan_activated'], true);
  assertEquals(notifications().map((n) => (n['metadata'] as Row)['kind']), ['plan_paid']);
  fake.restore();
});

// ---- Both Pi apps: each key sees only its own app's payments (Pi says 404 payment_not_found)

// Runs fn with PI_MAINNET_API_KEY set, collecting the function's log lines
async function withMainnetKey<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string }> {
  Deno.env.set('PI_MAINNET_API_KEY', MAINNET_KEY);
  const lines: string[] = [];
  const real = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };
  const keep = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  Object.assign(console, { log: keep, warn: keep, error: keep, info: keep });
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    Object.assign(console, real);
    Deno.env.delete('PI_MAINNET_API_KEY');
  }
}

test('a plan only the mainnet key can see: found, completed and re-read with the mainnet key, granted once', async () => {
  const { fake, piByApp, rpcCalls, row } = setup({ piApp: 'mainnet' });
  const { result, logs } = await withMainnetKey(() => call(PLAN));
  assertEquals([result.status, result.json.success], [200, true]);
  assertEquals(piByApp, [
    'get:testnet',
    'get:mainnet',
    'complete:mainnet',
    'get:mainnet',
  ]);
  assertEquals(rpcCalls.length, 1);
  assertEquals((row()!['status'] as Row)['completed'], true);
  assert(logs.includes('"pi_app":"mainnet"'));
  assert(!logs.includes(MAINNET_KEY) && !logs.includes('test-pi-key'));
  fake.restore();
});

test('a mainnet top up: completed with the mainnet key and credited', async () => {
  const { fake, piByApp, ledger } = setup({
    piApp: 'mainnet',
    piAmount: 3,
    rows: [topUpRow()],
  });
  const { result } = await withMainnetKey(() => call(TOPUP));
  assertEquals([result.status, result.json.newBalance], [200, 3]);
  assertEquals(ledger().length, 1);
  assert(
    piByApp.includes('complete:mainnet') &&
      !piByApp.includes('complete:testnet'),
  );
  fake.restore();
});

test('both keys set, a testnet payment: the mainnet key is never used', async () => {
  const { fake, piByApp } = setup({ piApp: 'testnet' });
  const { result } = await withMainnetKey(() => call(PLAN));
  assertEquals(result.status, 200);
  assertEquals(piByApp, ['get:testnet', 'complete:testnet', 'get:testnet']);
  fake.restore();
});

test('both keys set and Pi unreachable before completing: 502, Pi not told to complete, row untouched', async () => {
  const { fake, piByApp, row } = setup({ piApp: 'testnet', piGetFailures: 1 });
  const { result } = await withMainnetKey(() => call(PLAN));
  assertEquals(
    [result.status, result.json.message],
    [502, 'Unable to verify payment'],
  );
  assertEquals(piByApp, ['get:testnet']);
  assertEquals(row()!['status'], APPROVED);
  // A retry carries on
  const retry = await withMainnetKey(() => call(PLAN));
  assertEquals(retry.result.status, 200);
  fake.restore();
});

test('a mainnet completed row being recovered: re-read with the mainnet key', async () => {
  const { fake, piByApp, rpcCalls } = setup({
    piApp: 'mainnet',
    rows: [
      approvedRow({
        status: {
          approved: true,
          verified: true,
          completed: true,
          cancelled: false,
        },
        txid: TXID,
      }),
    ],
  });
  const { result } = await withMainnetKey(() => call(PLAN));
  assertEquals(result.status, 200);
  assertEquals(piByApp, ['get:testnet', 'get:mainnet']);
  assertEquals(rpcCalls.length, 1);
  fake.restore();
});

// ---- Pi's own shape for "already completed": error / error_message, no message field

test("Pi's already_completed body with error / error_message: a top up reaches the credit, once", async () => {
  const { fake, ledger, row } = setup({
    piAmount: 3,
    piAlreadyCompleted: true,
    piAlreadyCompletedBody: {
      error: 'already_completed',
      error_message: 'Current payment is already completed.',
    },
    rows: [topUpRow()],
  });
  const first = await call(TOPUP);
  assertEquals([first.status, first.json.newBalance], [200, 3]);
  assertEquals((row()!['status'] as Row)['cancelled'], false);
  const again = await call(TOPUP);
  assertEquals(again.status, 200);
  assertEquals(ledger().length, 1);
  fake.restore();
});

test('only error_message saying it (no code): recognised too', async () => {
  const { fake, ledger } = setup({
    piAmount: 3,
    piAlreadyCompleted: true,
    piAlreadyCompletedBody: {
      error_message: 'This payment is Already Completed',
    },
    rows: [topUpRow()],
  });
  assertEquals((await call(TOPUP)).status, 200);
  assertEquals(ledger().length, 1);
  fake.restore();
});
