/**
 * Unit tests for pay-from-balance with Supabase and auth mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 test --allow-env --allow-net --allow-read supabase/functions/pay-from-balance/index.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { installFakeSupabase, loadHandler, setFunctionEnv } from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

// supabase-js starts auth refresh timers for each client the function creates, which Deno's
// op/resource sanitizers would report as leaks
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

type PayArgs = { p_user_id: string; p_tier: string; p_frequency: string; p_amount_pi: number; p_request_id: string };

/** pay_plan_from_balance as the migration behaves: idempotent per reference, P0001 when short */
function setup(options: { balance?: number; priceUsd?: number | null; rpcError?: { code: string; message: string } } = {}) {
  let balance = options.balance ?? 100;
  const references = new Set<string>();
  const debits: PayArgs[] = [];
  const fake = installFakeSupabase({
    tables: { pi_price: options.priceUsd === null ? [] : [{ id: 1, price_usd: options.priceUsd ?? 0.0767 }] },
    users: { 'owner-token': OWNER, 'other-token': OTHER },
    rpc: (name, args) => {
      assertEquals(name, 'pay_plan_from_balance');
      if (options.rpcError) return Response.json(options.rpcError, { status: 400 });
      const pay = args as unknown as PayArgs;
      const reference = `plan:${pay.p_tier}:${pay.p_frequency}:${pay.p_request_id}`;
      if (references.has(reference)) return Response.json(balance);
      if (balance < pay.p_amount_pi) {
        return Response.json({
          code: 'P0001',
          message: `debit_wallet_balance: insufficient balance (have ${balance}, need ${pay.p_amount_pi})`,
        }, { status: 400 });
      }
      references.add(reference);
      debits.push(pay);
      balance -= pay.p_amount_pi;
      return Response.json(balance);
    },
  });
  return { fake, debits };
}

const VALID = { kind: 'subscription', subscriptionTier: 'small-business', frequency: 'monthly', requestId: REQUEST_ID };

const call = async (body: unknown, token: string | null = 'owner-token') => {
  const res = await handler(
    new Request('http://fn/pay-from-balance', {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
};

test('no token: 401, nothing debited', async () => {
  const { fake, debits } = setup();
  const { status } = await call(VALID, null);
  assertEquals(status, 401);
  assertEquals(debits.length, 0);
  fake.restore();
});

test('an invalid token: 401, nothing debited', async () => {
  const { fake, debits } = setup();
  const { status } = await call(VALID, 'expired-token');
  assertEquals(status, 401);
  assertEquals(debits.length, 0);
  fake.restore();
});

test('an unknown tier, or Individual: 400, nothing debited', async () => {
  const { fake, debits } = setup();
  for (const subscriptionTier of ['platinum', 'individual', 'constructor', '__proto__']) {
    assertEquals((await call({ ...VALID, subscriptionTier })).status, 400, subscriptionTier);
  }
  assertEquals(debits.length, 0);
  fake.restore();
});

test('a bad body: 400 (wrong kind, the page\'s "yearly", no request id, not JSON)', async () => {
  const { fake, debits } = setup();
  assertEquals((await call({ ...VALID, kind: 'message_fee' })).status, 400);
  assertEquals((await call({ ...VALID, frequency: 'yearly' })).status, 400);
  assertEquals((await call({ ...VALID, requestId: undefined })).status, 400);
  assertEquals((await call('not json')).status, 400);
  assertEquals(debits.length, 0);
  fake.restore();
});

test('the amount comes from the price table and pi_price, not the body', async () => {
  const { fake, debits } = setup({ balance: 5000 });
  const monthly = await call({ ...VALID, amount: 0.01, amountPi: 0.01, p_amount_pi: 0.01 });
  assertEquals(monthly.status, 200);
  assertEquals(debits[0]!.p_amount_pi, 65.19); // $5 at $0.0767, to 2 decimals as the page shows it
  assertEquals(monthly.json.amountPi, 65.19);
  const annual = await call({ ...VALID, subscriptionTier: 'organization', frequency: 'annual', requestId: '22222222-2222-4222-8222-222222222222', amount: 1 });
  assertEquals(debits[1]!.p_amount_pi, 1251.63); // $96
  assertEquals(annual.json.frequency, 'annual');
  fake.restore();
});

test('the user comes from the token, not the body', async () => {
  const { fake, debits } = setup();
  await call({ ...VALID, userId: OTHER, p_user_id: OTHER });
  assertEquals(debits[0]!.p_user_id, OWNER);
  fake.restore();
});

test('success: 200 with the new balance, amount, tier and frequency', async () => {
  const { fake } = setup({ balance: 100 });
  const { status, json } = await call(VALID);
  assertEquals(status, 200);
  assertEquals(json.success, true);
  assert(Math.abs(json.balance - 34.81) < 1e-9);
  assertEquals([json.amountPi, json.tier, json.frequency], [65.19, 'small-business', 'monthly']);
  fake.restore();
});

test('not enough balance: 409 with error_code and the balance', async () => {
  const { fake, debits } = setup({ balance: 3.2 });
  const { status, json } = await call(VALID);
  assertEquals(status, 409);
  assertEquals(json.error_code, 'insufficient_balance');
  assertEquals(json.balance, 3.2);
  assertEquals(debits.length, 0);
  fake.restore();
});

test('the same requestId twice: one debit, both succeed', async () => {
  const { fake, debits } = setup({ balance: 100 });
  const first = await call(VALID);
  const second = await call(VALID);
  assertEquals([first.status, second.status], [200, 200]);
  assertEquals(debits.length, 1);
  assertEquals(second.json.balance, first.json.balance);
  fake.restore();
});

test('price unavailable: 503, nothing debited', async () => {
  const { fake, debits } = setup({ priceUsd: null });
  assertEquals((await call(VALID)).status, 503);
  assertEquals(debits.length, 0);
  fake.restore();
});

test('another P0001 is not reported as an insufficient balance', async () => {
  const { fake } = setup({ rpcError: { code: 'P0001', message: 'No completed payment found for user x and plan small-business' } });
  const { status, json } = await call(VALID);
  assertEquals(status, 500);
  assertEquals(json.error_code, undefined);
  assert(!JSON.stringify(json).includes('No completed payment'));
  fake.restore();
});
