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
const PAYMENT_ID = 'pay_1';
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

function setup(options: { rows?: Row[]; piAmount?: number; priceUsd?: number; rpcError?: string; piAlreadyCompleted?: boolean } = {}) {
  const rpcCalls: Row[] = [];
  const credits: Row[] = [];
  const fake = installFakeSupabase({
    tables: {
      pi_price: [{ id: 1, price_usd: options.priceUsd ?? 0.0767 }],
      payments: options.rows ?? [approvedRow()],
      notifications: [],
    },
    users: { 'owner-token': OWNER },
    external: (url) => {
      if (url.host !== 'api.minepi.com') return undefined;
      if (url.pathname.endsWith('/complete') && options.piAlreadyCompleted) {
        return Response.json({ error: 'already_completed', message: 'This payment was already completed' }, { status: 400 });
      }
      return Response.json({ identifier: PAYMENT_ID, amount: options.piAmount ?? 65.19 });
    },
    rpc: (name, args) => {
      if (name === 'credit_wallet_balance') {
        credits.push(args);
        return Response.json(args['p_amount_pi']);
      }
      assertEquals(name, 'handle_subscription_after_payment');
      rpcCalls.push(args);
      return options.rpcError ? Response.json({ code: 'P0001', message: options.rpcError }, { status: 400 }) : Response.json(null);
    },
  });
  return { fake, rpcCalls, credits, row: () => fake.tables['payments']![0], notifications: () => fake.tables['notifications']! };
}

const call = async (metadata: Record<string, unknown> = PLAN) => {
  const res = await handler(
    new Request('http://fn/complete-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: PAYMENT_ID, txid: TXID, userId: OWNER, amount: 65.19, memo: 'Small Business plan (monthly)', metadata }),
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
  assertEquals(n['content'], 'Payment of 65.19 Pi received successfully! Your small-business subscription is now active.');
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
    tables: { payments: [approvedRow({ metadata: { kind: 'wallet_topup' }, approved_amount_pi: null })], notifications: [] },
    users: { 'owner-token': OWNER },
    external: () => Response.json({ identifier: PAYMENT_ID, amount: 3 }),
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
