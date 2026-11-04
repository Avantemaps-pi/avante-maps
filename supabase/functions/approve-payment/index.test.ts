/**
 * Unit tests for approve-payment with Supabase, Pi's API and auth mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 deno test --no-lock --allow-env --allow-net --allow-read supabase/functions/approve-payment/index.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { installFakeSupabase, loadHandler, setFunctionEnv, type Row } from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
Deno.env.set('PI_API_KEY', 'test-pi-key');
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const PAYMENT_ID = 'pay_1';

// supabase-js starts auth refresh timers for each client the function creates, which Deno's
// op/resource sanitizers would report as leaks
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

// $5 at $0.0767 is 65.189 π
const PLAN = { subscriptionTier: 'small-business', frequency: 'monthly' };

function setup(options: { piAmount?: number; priceUsd?: number | null; rows?: Row[]; piGetStatus?: number; cancelStatus?: number } = {}) {
  const piCalls: string[] = [];
  const fake = installFakeSupabase({
    tables: {
      pi_price: options.priceUsd === null ? [] : [{ id: 1, price_usd: options.priceUsd ?? 0.0767 }],
      payments: options.rows ?? [],
    },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      assertEquals(new Headers(init?.headers).get('authorization'), 'Key test-pi-key');
      const action = url.pathname.split('/').pop();
      piCalls.push(action === PAYMENT_ID ? 'get' : action!);
      if (action === PAYMENT_ID) {
        return options.piGetStatus ? new Response('nope', { status: options.piGetStatus }) : Response.json({ identifier: PAYMENT_ID, amount: options.piAmount ?? 65.19 });
      }
      if (action === 'cancel') return new Response('{}', { status: options.cancelStatus ?? 200 });
      return Response.json({ identifier: PAYMENT_ID });
    },
  });
  return { fake, piCalls, row: () => fake.tables['payments']!.find((r) => r['payment_id'] === PAYMENT_ID) };
}

const call = async (metadata: Record<string, unknown>, amount = 65.19) => {
  const res = await handler(
    new Request('http://fn/approve-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: PAYMENT_ID, userId: OWNER, amount, memo: 'Small Business plan (monthly)', metadata }),
    }),
  );
  return { status: res.status, json: await res.json() };
};

test('a plan paid below the price: not approved, cancelled with Pi, row marked, 400', async () => {
  const { fake, piCalls, row } = setup({ piAmount: 5 });
  const { status, json } = await call(PLAN, 5);
  assertEquals(status, 400);
  assertEquals(json.success, false);
  assertEquals(json.error_code, 'amount_mismatch');
  assert(Math.abs(json.expectedPi - 5 / 0.0767) < 1e-6);
  assertEquals(piCalls, ['get', 'cancel']);
  assertEquals(row()!['status'], { approved: false, verified: false, completed: false, cancelled: true, error: 'amount_mismatch' });
  assertEquals(row()!['approved_amount_pi'], undefined);
  fake.restore();
});

test('the amount comes from Pi, not the request body', async () => {
  const { fake, piCalls } = setup({ piAmount: 5 });
  const { status } = await call(PLAN, 65.19); // The body claims the right price
  assertEquals(status, 400);
  assert(!piCalls.includes('approve'));
  fake.restore();
});

test('if Pi refuses the cancel: still not approved, still 400', async () => {
  const { fake, piCalls, row } = setup({ piAmount: 5, cancelStatus: 500 });
  const { status, json } = await call(PLAN, 5);
  assertEquals([status, json.error_code], [400, 'amount_mismatch']);
  assert(!piCalls.includes('approve'));
  assertEquals((row()!['status'] as Row)['error'], 'amount_mismatch');
  fake.restore();
});

test('a matching amount: approved, and approved_amount_pi stored from Pi', async () => {
  const { fake, piCalls, row } = setup({ piAmount: 65.19 });
  const { status, json } = await call(PLAN, 1); // Whatever the body says
  assertEquals([status, json.success], [200, true]);
  assertEquals(piCalls, ['get', 'approve']);
  assertEquals(row()!['approved_amount_pi'], 65.19);
  assertEquals((row()!['status'] as Row)['approved'], true);
  fake.restore();
});

test('within the 0.5% tolerance: approved; just under it: refused', async () => {
  const within = setup({ piAmount: 64.87 }); // 65.189 × 0.995 = 64.863
  assertEquals((await call(PLAN)).status, 200);
  within.fake.restore();
  const under = setup({ piAmount: 64.85 });
  assertEquals((await call(PLAN)).status, 400);
  under.fake.restore();
});

test('annual uses the annual price', async () => {
  const { fake, piCalls } = setup({ piAmount: 65.19 });
  const { status } = await call({ subscriptionTier: 'small-business', frequency: 'annual' });
  assertEquals(status, 400); // $48 is 625.81 π
  assert(!piCalls.includes('approve'));
  fake.restore();
});

test('price unavailable: 503, Pi not called, no row', async () => {
  const { fake, piCalls, row } = setup({ priceUsd: null });
  const { status } = await call(PLAN);
  assertEquals(status, 503);
  assertEquals(piCalls, []);
  assertEquals(row(), undefined);
  fake.restore();
});

test('Individual: 400, Pi not called; an unknown tier: 400', async () => {
  const { fake, piCalls, row } = setup();
  assertEquals((await call({ subscriptionTier: 'individual' })).status, 400);
  assertEquals((await call({ subscriptionTier: 'platinum' })).status, 400);
  assertEquals(piCalls, []);
  assertEquals(row(), undefined);
  fake.restore();
});

test("Pi's amount can't be read: 502, not approved, and the row stays open for a retry", async () => {
  const { fake, piCalls, row } = setup({ piGetStatus: 500 });
  const { status } = await call(PLAN);
  assertEquals(status, 502);
  assertEquals(piCalls, ['get']);
  assertEquals((row()!['status'] as Row)['cancelled'], false);
  fake.restore();
});

test('a retry with other metadata: the row keeps the plan the amount was checked for', async () => {
  // The first attempt left a pending row saying Organization annual
  const { fake, row } = setup({
    piAmount: 65.19,
    rows: [{
      payment_id: PAYMENT_ID,
      user_id: OWNER,
      amount: 65.19,
      metadata: { subscriptionTier: 'organization', frequency: 'annual' },
      status: { approved: false, verified: false, completed: false, cancelled: false },
      created_at: new Date().toISOString(),
    }],
  });
  assertEquals((await call(PLAN)).status, 200);
  assertEquals(row()!['metadata'], PLAN);
  fake.restore();
});

test('a top-up: unchanged, approved with no amount check', async () => {
  const { fake, piCalls, row } = setup({ piAmount: 1 });
  const { status } = await call({ kind: 'wallet_topup' }, 1);
  assertEquals(status, 200);
  assertEquals(piCalls, ['approve']);
  assertEquals(row()!['approved_amount_pi'], undefined);
  fake.restore();
});

test('a message fee: unchanged, approved with no amount check', async () => {
  const { fake, piCalls } = setup({ piAmount: 0.5 });
  const { status } = await call({ kind: 'message_fee', feePi: 0.5 }, 0.5);
  assertEquals(status, 200);
  assertEquals(piCalls, ['approve']);
  fake.restore();
});
