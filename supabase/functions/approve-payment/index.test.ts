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
// The owner's uid in this Pi app: what Pi reports as the payment's user_uid and from /me
const OWNER_PI_UID = 'pi-uid-owner-0001';
const OWNER_USERNAME = 'JordynDaniel';
const PI_TOKEN = 'pi-access-token-0001';
const PAYMENT_ID = 'pay_1';

// supabase-js starts auth refresh timers for each client the function creates, which Deno's
// op/resource sanitizers would report as leaks
const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

// $5 at $0.0767 is 65.189 π
const PLAN = { subscriptionTier: 'small-business', frequency: 'monthly' };

function setup(
  options: {
    piAmount?: number;
    priceUsd?: number | null;
    rows?: Row[];
    piGetStatus?: number;
    cancelStatus?: number;
    /** Who Pi says is paying (default: the owner's Pi account) */
    piUserUid?: string | null;
    /** users.pi_uid for the signed-in user (default: the owner's Pi account) */
    ownerPiUid?: string | null;
    /** users.username for the signed-in user */
    ownerUsername?: string | null;
    /** What Pi's /me answers (default: the owner, in this app) */
    me?: { uid?: string; username?: string };
    meStatus?: number;
  } = {},
) {
  const piCalls: string[] = [];
  const meAuth: (string | null)[] = [];
  const fake = installFakeSupabase({
    tables: {
      pi_price: options.priceUsd === null ? [] : [{ id: 1, price_usd: options.priceUsd ?? 0.0767 }],
      payments: options.rows ?? [],
      users: [{
        id: OWNER,
        pi_uid: options.ownerPiUid === undefined ? OWNER_PI_UID : options.ownerPiUid,
        username: options.ownerUsername === undefined ? OWNER_USERNAME : options.ownerUsername,
      }],
    },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      if (url.pathname === '/v2/me') {
        meAuth.push(new Headers(init?.headers).get('authorization'));
        if (options.meStatus) return new Response('nope', { status: options.meStatus });
        return Response.json(options.me ?? { uid: OWNER_PI_UID, username: OWNER_USERNAME });
      }
      assertEquals(new Headers(init?.headers).get('authorization'), 'Key test-pi-key');
      const action = url.pathname.split('/').pop();
      piCalls.push(action === PAYMENT_ID ? 'get' : action!);
      if (action === PAYMENT_ID) {
        return options.piGetStatus
          ? new Response('nope', { status: options.piGetStatus })
          : Response.json({
            identifier: PAYMENT_ID,
            amount: options.piAmount ?? 65.19,
            user_uid: options.piUserUid === undefined ? OWNER_PI_UID : options.piUserUid,
          });
      }
      if (action === 'cancel') return new Response('{}', { status: options.cancelStatus ?? 200 });
      return Response.json({ identifier: PAYMENT_ID });
    },
  });
  return { fake, piCalls, meAuth, row: () => fake.tables['payments']!.find((r) => r['payment_id'] === PAYMENT_ID) };
}

const call = async (metadata: Record<string, unknown>, amount = 65.19, piAccessToken: string | undefined = PI_TOKEN) => {
  const res = await handler(
    new Request('http://fn/approve-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: PAYMENT_ID, userId: OWNER, amount, memo: 'Small Business plan (monthly)', metadata, piAccessToken }),
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
  assertEquals(piCalls, ['get', 'approve']);
  assertEquals(row()!['approved_amount_pi'], undefined);
  fake.restore();
});

test('a message fee: unchanged, approved with no amount check', async () => {
  const { fake, piCalls } = setup({ piAmount: 0.5 });
  const { status } = await call({ kind: 'message_fee', feePi: 0.5 }, 0.5);
  assertEquals(status, 200);
  assertEquals(piCalls, ['get', 'approve']);
  fake.restore();
});

// ---- Who paid: the Pi account must be the signed-in user's

const TOPUP = { kind: 'wallet_topup' };
const FEE = { kind: 'message_fee', conversationId: '11111111-1111-4111-8111-111111111111', businessId: 7, feePi: 0.5 };
const MISMATCH_MESSAGE = "This payment was started from a different Pi account. Sign in with the account you're paying from.";

for (const [kind, metadata, amount] of [['top up', TOPUP, 3], ['message fee', FEE, 0.5], ['plan', PLAN, 65.19]] as const) {
  test(`paid from another Pi account (${kind}): cancelled at Pi, 403, not approved, row marked`, async () => {
    const { fake, piCalls, row } = setup({ piAmount: amount, piUserUid: 'pi-uid-someone-else' });
    const { status, json } = await call(metadata, amount);
    assertEquals(status, 403);
    assertEquals(json.success, false);
    assertEquals(json.error_code, 'payment_user_mismatch');
    assertEquals(json.message, MISMATCH_MESSAGE);
    assertEquals(piCalls, ['get', 'cancel']);
    assertEquals(row()!['status'], { approved: false, verified: false, completed: false, cancelled: true, error: 'payment_user_mismatch' });
    assertEquals(row()!['approved_amount_pi'], undefined);
    fake.restore();
  });
}

// The owner's case: signed in through the Mainnet app, paying in the Testnet app
test("users.pi_uid is another app's uid, and /me matches the payment: approved", async () => {
  const { fake, piCalls, meAuth } = setup({ piAmount: 3, ownerPiUid: 'pi-uid-from-the-other-app' });
  const { status, json } = await call(TOPUP, 3);
  assertEquals([status, json.success], [200, true]);
  assertEquals(piCalls, ['get', 'approve']);
  assertEquals(meAuth, [`Bearer ${PI_TOKEN}`]); // The user's token, never the API key
  fake.restore();
});

test('the signed-in user has no pi_uid: not needed any more, approved', async () => {
  const { fake } = setup({ piAmount: 3, ownerPiUid: null });
  assertEquals((await call(TOPUP, 3)).status, 200);
  fake.restore();
});

test('the username matches in a different case: approved', async () => {
  const { fake, piCalls } = setup({ piAmount: 3, me: { uid: OWNER_PI_UID, username: 'JORDYNdaniel' } });
  assertEquals((await call(TOPUP, 3)).status, 200);
  assertEquals(piCalls, ['get', 'approve']);
  fake.restore();
});

test("the token holder isn't the payer in this app: cancelled at Pi, 403, row marked", async () => {
  const { fake, piCalls, row } = setup({ piAmount: 3, me: { uid: 'pi-uid-someone-else', username: OWNER_USERNAME } });
  const { status, json } = await call(TOPUP, 3);
  assertEquals([status, json.error_code, json.message], [403, 'payment_user_mismatch', MISMATCH_MESSAGE]);
  assertEquals(piCalls, ['get', 'cancel']);
  assertEquals((row()!['status'] as Row)['error'], 'payment_user_mismatch');
  fake.restore();
});

test("the payer's username isn't this account's: cancelled at Pi, 403, row marked", async () => {
  const { fake, piCalls, row } = setup({ piAmount: 3, me: { uid: OWNER_PI_UID, username: 'SomeoneElse' } });
  const { status, json } = await call(TOPUP, 3);
  assertEquals([status, json.error_code], [403, 'payment_user_mismatch']);
  assertEquals(piCalls, ['get', 'cancel']);
  assertEquals((row()!['status'] as Row)['error'], 'payment_user_mismatch');
  fake.restore();
});

test('the signed-in user has no username: refused the same way', async () => {
  const { fake, piCalls } = setup({ piAmount: 3, ownerUsername: null });
  assertEquals((await call(TOPUP, 3)).status, 403);
  assertEquals(piCalls, ['get', 'cancel']);
  fake.restore();
});

const TOKEN_INVALID_MESSAGE = 'Your Pi sign-in has expired. Close and reopen Avante Maps, then try again.';
const PENDING = { approved: false, verified: false, completed: false, cancelled: false };

for (const [name, options] of [
  ['/me says 401', { meStatus: 401 }],
  ['/me is down', { meStatus: 503 }],
  ["/me doesn't say who", { me: { uid: OWNER_PI_UID } }],
] as const) {
  test(`${name}: 401 pi_token_invalid, not cancelled, left pending for a retry`, async () => {
    const { fake, piCalls, row } = setup({ piAmount: 3, ...options });
    const { status, json } = await call(TOPUP, 3);
    assertEquals([status, json.error_code, json.message], [401, 'pi_token_invalid', TOKEN_INVALID_MESSAGE]);
    assertEquals(piCalls, ['get']);
    assertEquals(row()!['status'], PENDING);
    fake.restore();
  });
}

test('no piAccessToken (an old client): 400 pi_token_missing, before the row, Pi not called', async () => {
  const { fake, piCalls, meAuth, row } = setup({ piAmount: 3 });
  const res = await handler(
    new Request('http://fn/approve-payment', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId: PAYMENT_ID, userId: OWNER, amount: 3, memo: 'Top up', metadata: TOPUP }),
    }),
  );
  const json = await res.json();
  assertEquals([res.status, json.error_code, json.message], [400, 'pi_token_missing', 'Please reopen Avante Maps and try again.']);
  assertEquals([piCalls, meAuth, row()], [[], [], undefined]);
  fake.restore();
});

test('a piAccessToken of the wrong size: 400, Pi not called', async () => {
  for (const token of ['short', 'x'.repeat(2001)]) {
    const { fake, piCalls, row } = setup({ piAmount: 3 });
    assertEquals((await call(TOPUP, 3, token)).status, 400);
    assertEquals([piCalls, row()], [[], undefined]);
    fake.restore();
  }
});

test("Pi doesn't say who paid: refused the same way", async () => {
  const { fake, piCalls } = setup({ piAmount: 3, piUserUid: null });
  const { status, json } = await call(TOPUP, 3);
  assertEquals([status, json.error_code], [403, 'payment_user_mismatch']);
  assertEquals(piCalls, ['get', 'cancel']);
  fake.restore();
});

test('the Pi account matches: a top up, a fee and a plan are approved as today', async () => {
  for (const [metadata, amount] of [[TOPUP, 3], [FEE, 0.5], [PLAN, 65.19]] as const) {
    const { fake, piCalls, row } = setup({ piAmount: amount });
    const { status, json } = await call(metadata, amount);
    assertEquals([status, json.success], [200, true], JSON.stringify(metadata));
    assertEquals(piCalls, ['get', 'approve']);
    assertEquals((row()!['status'] as Row)['approved'], true);
    fake.restore();
  }
});

test('a top up whose Pi payment can\'t be read: 502, not approved, the row stays open', async () => {
  const { fake, piCalls, row } = setup({ piGetStatus: 500 });
  const { status } = await call(TOPUP, 3);
  assertEquals(status, 502);
  assertEquals(piCalls, ['get']);
  assertEquals(row()!['status'], { approved: false, verified: false, completed: false, cancelled: false });
  fake.restore();
});

test('logs never hold a whole Pi uid', async () => {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    const { fake } = setup({ piAmount: 3, piUserUid: 'pi-uid-someone-else' });
    await call(TOPUP, 3);
    fake.restore();
  } finally {
    Object.assign(console, original);
  }
  const output = lines.join('\n');
  assert(!output.includes('pi-uid-someone-else'), output);
  assert(!output.includes(OWNER_PI_UID), output);
  assert(!output.includes(OWNER_USERNAME), output);
  assert(!output.includes(PI_TOKEN), output);
  assert(output.includes('pi-uid…'));
  assert(output.includes('Jordyn…'));
});

// The app sends x-lifecycle-id and x-correlation-id (src/utils/correlation.ts); if the preflight
// doesn't allow them the browser never sends the POST and approval times out
test('OPTIONS allows the correlation headers the app sends', async () => {
  const res = await handler(
    new Request('http://fn/approve-payment', { method: 'OPTIONS' }),
  );
  assertEquals(res.status, 200);
  const allowed = (res.headers.get('access-control-allow-headers') ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase());
  for (const header of [
    'x-lifecycle-id',
    'x-correlation-id',
    'x-request-id',
    'x-trace-id',
  ]) {
    assert(
      allowed.includes(header),
      `${header} is not in Access-Control-Allow-Headers`,
    );
  }
  for (const header of [
    'authorization',
    'x-client-info',
    'apikey',
    'content-type',
  ]) {
    assert(allowed.includes(header), `${header} is no longer allowed`);
  }
});

// ---- Both Pi apps: each key sees only its own app's payments (Pi says 404 payment_not_found)

const MAINNET_KEY = 'test-pi-mainnet-key';
const NOT_FOUND = {
  error: 'payment_not_found',
  error_message: 'Payment not found',
};

// Pi with both apps' keys set: the payment exists only in `app`. Calls are recorded as
// "action:app", the app being the one whose key made the call
function setupTwoApps(options: {
  app: 'testnet' | 'mainnet' | 'neither';
  piAmount?: number;
  piUserUid?: string;
  rows?: Row[];
}) {
  Deno.env.set('PI_MAINNET_API_KEY', MAINNET_KEY);
  const piCalls: string[] = [];
  const fake = installFakeSupabase({
    tables: {
      pi_price: [{ id: 1, price_usd: 0.0767 }],
      payments: options.rows ?? [],
      users: [{ id: OWNER, pi_uid: OWNER_PI_UID, username: OWNER_USERNAME }],
    },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      if (url.pathname === '/v2/me')
        return Response.json({ uid: OWNER_PI_UID, username: OWNER_USERNAME });
      const key = (
        new Headers(init?.headers).get('authorization') ?? ''
      ).replace('Key ', '');
      const app =
        key === 'test-pi-key'
          ? 'testnet'
          : key === MAINNET_KEY
            ? 'mainnet'
            : 'unknown key';
      const action = url.pathname.split('/').pop();
      piCalls.push(`${action === PAYMENT_ID ? 'get' : action}:${app}`);
      if (app !== options.app) return Response.json(NOT_FOUND, { status: 404 });
      if (action === PAYMENT_ID) {
        return Response.json({
          identifier: PAYMENT_ID,
          amount: options.piAmount ?? 65.19,
          user_uid: options.piUserUid ?? OWNER_PI_UID,
        });
      }
      return Response.json({ identifier: PAYMENT_ID });
    },
  });
  return {
    piCalls,
    row: () =>
      fake.tables['payments']!.find((r) => r['payment_id'] === PAYMENT_ID),
    restore: () => {
      fake.restore();
      Deno.env.delete('PI_MAINNET_API_KEY');
    },
  };
}

// The function's log lines during fn
async function logsOf<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string }> {
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
  }
}

test('a payment only the mainnet key can see: found with it, and approved with it', async () => {
  const two = setupTwoApps({ app: 'mainnet' });
  try {
    const { result, logs } = await logsOf(() => call(PLAN, 65.19));
    assertEquals([result.status, result.json.success], [200, true]);
    assertEquals(two.piCalls, [
      'get:testnet',
      'get:mainnet',
      'approve:mainnet',
    ]);
    assertEquals((two.row()!['status'] as Row)['approved'], true);
    assert(logs.includes('"pi_app":"mainnet"'));
    assert(!logs.includes(MAINNET_KEY) && !logs.includes('test-pi-key'));
  } finally {
    two.restore();
  }
});

test('a mainnet plan paid below the price: cancelled with the mainnet key', async () => {
  const two = setupTwoApps({ app: 'mainnet', piAmount: 5 });
  try {
    const { status, json } = await call(PLAN, 5);
    assertEquals([status, json.error_code], [400, 'amount_mismatch']);
    assertEquals(two.piCalls, ['get:testnet', 'get:mainnet', 'cancel:mainnet']);
  } finally {
    two.restore();
  }
});

test('a mainnet payment from another Pi account: payment_user_mismatch, cancelled with the mainnet key', async () => {
  const two = setupTwoApps({
    app: 'mainnet',
    piUserUid: 'pi-uid-someone-else',
  });
  try {
    const { status, json } = await call(PLAN, 65.19);
    assertEquals([status, json.error_code], [403, 'payment_user_mismatch']);
    assertEquals(two.piCalls, ['get:testnet', 'get:mainnet', 'cancel:mainnet']);
  } finally {
    two.restore();
  }
});

test('both keys set, a testnet payment: the mainnet key is never used', async () => {
  const two = setupTwoApps({ app: 'testnet' });
  try {
    const { status } = await call(PLAN, 65.19);
    assertEquals(status, 200);
    assertEquals(two.piCalls, ['get:testnet', 'approve:testnet']);
  } finally {
    two.restore();
  }
});

test('neither app has it: 502 as before, nothing approved, the row left pending', async () => {
  const two = setupTwoApps({ app: 'neither' });
  try {
    const { result, logs } = await logsOf(() => call(PLAN, 65.19));
    assertEquals(
      [result.status, result.json.message],
      [502, 'Unable to verify payment'],
    );
    assertEquals(two.piCalls, ['get:testnet', 'get:mainnet']);
    assertEquals((two.row()!['status'] as Row)['cancelled'], false);
    // #172's line, with Pi's error body
    assert(
      logs.includes('get_payment_failed') && logs.includes('payment_not_found'),
    );
  } finally {
    two.restore();
  }
});

test('a stale mainnet row: cancelled at Pi with the mainnet key before approving again', async () => {
  const stale = {
    payment_id: PAYMENT_ID,
    user_id: OWNER,
    amount: 65.19,
    metadata: PLAN,
    status: {
      approved: false,
      verified: false,
      completed: false,
      cancelled: false,
    },
    created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
  };
  const two = setupTwoApps({ app: 'mainnet', rows: [stale] });
  try {
    await call(PLAN, 65.19);
    assertEquals(two.piCalls.slice(0, 3), [
      'get:testnet',
      'get:mainnet',
      'cancel:mainnet',
    ]);
    assert(
      !two.piCalls.some((c) => c.endsWith(':testnet') && !c.startsWith('get')),
    );
  } finally {
    two.restore();
  }
});
