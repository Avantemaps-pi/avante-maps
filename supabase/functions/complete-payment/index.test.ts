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

function setup(options: { rows?: Row[]; piAmount?: number; priceUsd?: number; rpcError?: string } = {}) {
  const rpcCalls: Row[] = [];
  const fake = installFakeSupabase({
    tables: {
      pi_price: [{ id: 1, price_usd: options.priceUsd ?? 0.0767 }],
      payments: options.rows ?? [approvedRow()],
      notifications: [],
    },
    users: { 'owner-token': OWNER },
    external: (url) => {
      if (url.host !== 'api.minepi.com') return undefined;
      return Response.json({ identifier: PAYMENT_ID, amount: options.piAmount ?? 65.19 });
    },
    rpc: (name, args) => {
      assertEquals(name, 'handle_subscription_after_payment');
      rpcCalls.push(args);
      return options.rpcError ? Response.json({ code: 'P0001', message: options.rpcError }, { status: 400 }) : Response.json(null);
    },
  });
  return { fake, rpcCalls, row: () => fake.tables['payments']![0], notifications: () => fake.tables['notifications']! };
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

test('the plan fails to activate: 500 plan_not_activated, no success, no notification', async () => {
  const { fake, row, notifications } = setup({ rpcError: 'No completed payment found' });
  const { status, json } = await call();
  assertEquals(status, 500);
  assertEquals(json.success, false);
  assertEquals(json.error_code, 'plan_not_activated');
  assertEquals(json.message, 'Payment received, but your plan could not be activated. Please contact support.');
  assert(!JSON.stringify(json).includes('No completed payment'));
  assertEquals(notifications().length, 0);
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
  assertEquals(notifications().length, 0);
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

test('a top-up: unchanged, credited with no plan', async () => {
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
  fake.restore();
});
