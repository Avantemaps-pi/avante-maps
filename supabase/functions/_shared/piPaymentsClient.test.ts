/**
 * Unit tests for the Pi payments client, with fetch mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 deno test --no-lock --allow-env --allow-net --allow-read supabase/functions/_shared/piPaymentsClient.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createPiPayments, piSaysAlready } from './piPaymentsClient.ts';

const TESTNET_KEY = 'testnet-key-AAAA1111';
const MAINNET_KEY = 'mainnet-key-BBBB2222';
const PAYMENT_ID = 'pay_1';
const NOT_FOUND = {
  error: 'payment_not_found',
  error_message: 'Payment not found',
};

const test = (name: string, fn: () => void | Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

interface PiCall {
  method: string;
  path: string;
  key: string | null;
  body: string | null;
}

type PiAnswer = 'has' | 'missing' | number | 'throws';

/** Pi as seen by each key: 'has' answers 200, 'missing' 404 payment_not_found, or a status */
function mockPi(byKey: Record<string, PiAnswer>) {
  const calls: PiCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const auth = new Headers(init?.headers).get('authorization');
    const key = auth?.replace('Key ', '') ?? null;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      key,
      body: (init?.body as string) ?? null,
    });
    const answer = byKey[key ?? ''];
    if (answer === 'throws')
      return Promise.reject(new TypeError('network down'));
    if (answer === 'missing' || answer === undefined)
      return Promise.resolve(Response.json(NOT_FOUND, { status: 404 }));
    if (typeof answer === 'number')
      return Promise.resolve(
        new Response('{"error":"boom"}', { status: answer }),
      );
    if (url.pathname.endsWith(`/${PAYMENT_ID}`)) {
      return Promise.resolve(
        Response.json({
          identifier: PAYMENT_ID,
          amount: 3,
          user_uid: 'pi-uid-1',
        }),
      );
    }
    return Promise.resolve(Response.json({ ok: true }));
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

function setKeys(testnet: string | null, mainnet: string | null) {
  if (testnet === null) Deno.env.delete('PI_API_KEY');
  else Deno.env.set('PI_API_KEY', testnet);
  if (mainnet === null) Deno.env.delete('PI_MAINNET_API_KEY');
  else Deno.env.set('PI_MAINNET_API_KEY', mainnet);
}

// Every console line written during fn
async function captureLogs(fn: () => Promise<void>): Promise<string> {
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
    await fn();
  } finally {
    Object.assign(console, real);
  }
  return lines.join('\n');
}

test('found with the first key: testnet, one call', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 'has', [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(found.ok);
  assertEquals(
    [found.app, found.client.app, found.payment.amount],
    ['testnet', 'testnet', 3],
  );
  assertEquals(
    pi.calls.map((c) => [c.method, c.path, c.key]),
    [['GET', '/v2/payments/pay_1', TESTNET_KEY]],
  );
  pi.restore();
});

test('404 payment_not_found with the first key, found with the second: approve, complete and cancel use the second', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 'missing', [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(found.ok);
  assertEquals(found.app, 'mainnet');
  await found.client.approve(PAYMENT_ID);
  await found.client.complete(PAYMENT_ID, 'tx_1');
  await found.client.cancel(PAYMENT_ID);
  assertEquals(
    pi.calls.map((c) => [c.method, c.path, c.key]),
    [
      ['GET', '/v2/payments/pay_1', TESTNET_KEY],
      ['GET', '/v2/payments/pay_1', MAINNET_KEY],
      ['POST', '/v2/payments/pay_1/approve', MAINNET_KEY],
      ['POST', '/v2/payments/pay_1/complete', MAINNET_KEY],
      ['POST', '/v2/payments/pay_1/cancel', MAINNET_KEY],
    ],
  );
  assertEquals(pi.calls[3]!.body, JSON.stringify({ txid: 'tx_1' }));
  pi.restore();
});

test("both keys 404: payment_not_found, with Pi's error body", async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 'missing', [MAINNET_KEY]: 'missing' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(!found.ok);
  assertEquals(
    [found.reason, found.status, found.app],
    ['payment_not_found', 404, 'mainnet'],
  );
  assert(found.piErrorBody.includes('payment_not_found'));
  assertEquals(pi.calls.length, 2);
  pi.restore();
});

test('a 404 without payment_not_found in the body does not move on', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  };
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(!found.ok);
  assertEquals([found.reason, calls], ['pi_error', 1]);
  globalThis.fetch = realFetch;
});

test('401 on the first key: that error, and the second key is never called', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 401, [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(!found.ok);
  assertEquals(
    [found.reason, found.status, found.app],
    ['pi_error', 401, 'testnet'],
  );
  assertEquals(
    pi.calls.map((c) => c.key),
    [TESTNET_KEY],
  );
  pi.restore();
});

test('500 on the first key: no fall-through', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 500, [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(!found.ok);
  assertEquals([found.reason, found.status], ['pi_error', 500]);
  assertEquals(pi.calls.length, 1);
  pi.restore();
});

test('no answer on the first key: network error, no fall-through', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 'throws', [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(!found.ok);
  assertEquals(
    [found.reason, found.status, found.message],
    ['network', null, 'network down'],
  );
  assertEquals(pi.calls.length, 1);
  pi.restore();
});

test('mainnet key unset: one call, the same result as before', async () => {
  setKeys(TESTNET_KEY, null);
  const pi = mockPi({ [TESTNET_KEY]: 'missing' });
  const payments = createPiPayments()!;
  assertEquals(payments.apps, ['testnet']);
  const found = await payments.getPayment(PAYMENT_ID);
  assert(!found.ok);
  assertEquals(found.reason, 'payment_not_found');
  assertEquals(
    pi.calls.map((c) => c.key),
    [TESTNET_KEY],
  );
  pi.restore();
});

test('an empty mainnet key counts as unset', () => {
  setKeys(TESTNET_KEY, '');
  assertEquals(createPiPayments()!.apps, ['testnet']);
});

test('only the mainnet key: mainnet alone', () => {
  setKeys(null, MAINNET_KEY);
  assertEquals(createPiPayments()!.apps, ['mainnet']);
});

test('no key at all: null (the misconfiguration the functions report)', () => {
  setKeys(null, null);
  assertEquals(createPiPayments(), null);
  setKeys('', '');
  assertEquals(createPiPayments(), null);
});

test('findClient with one key: that key, without calling Pi', async () => {
  setKeys(TESTNET_KEY, null);
  const pi = mockPi({ [TESTNET_KEY]: 'has' });
  const found = await createPiPayments()!.findClient(PAYMENT_ID);
  assert(found.ok);
  assertEquals([found.client.app, pi.calls.length], ['testnet', 0]);
  await found.client.complete(PAYMENT_ID, 'tx_1');
  assertEquals(
    pi.calls.map((c) => [c.path, c.key]),
    [['/v2/payments/pay_1/complete', TESTNET_KEY]],
  );
  pi.restore();
});

test('findClient with both keys: asks Pi, and binds the app that has the payment', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 'missing', [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.findClient(PAYMENT_ID);
  assert(found.ok);
  assertEquals(found.client.app, 'mainnet');
  pi.restore();
});

test('findClient with both keys when Pi fails: the error, no client', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 503 });
  const found = await createPiPayments()!.findClient(PAYMENT_ID);
  assert(!found.ok);
  assertEquals([found.reason, found.status], ['pi_error', 503]);
  pi.restore();
});

test('the bound client re-reads the payment with its own key only', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const pi = mockPi({ [TESTNET_KEY]: 'missing', [MAINNET_KEY]: 'has' });
  const found = await createPiPayments()!.getPayment(PAYMENT_ID);
  assert(found.ok);
  const again = await found.client.getPayment(PAYMENT_ID);
  assert(again.ok);
  assertEquals(
    pi.calls.map((c) => c.key),
    [TESTNET_KEY, MAINNET_KEY, MAINNET_KEY],
  );
  pi.restore();
});

test('no result or log line holds either key', async () => {
  setKeys(TESTNET_KEY, MAINNET_KEY);
  const results: unknown[] = [];
  const logs = await captureLogs(async () => {
    const scenarios: Record<string, PiAnswer>[] = [
      { [TESTNET_KEY]: 'missing', [MAINNET_KEY]: 'has' },
      { [TESTNET_KEY]: 'missing', [MAINNET_KEY]: 'missing' },
      { [TESTNET_KEY]: 401 },
      { [TESTNET_KEY]: 'throws' },
    ];
    for (const byKey of scenarios) {
      const pi = mockPi(byKey);
      const found = await createPiPayments()!.getPayment(PAYMENT_ID);
      results.push(found.ok ? { ...found, client: found.client.app } : found);
      pi.restore();
    }
  });
  const text = JSON.stringify(results) + logs;
  for (const key of [TESTNET_KEY, MAINNET_KEY]) {
    assert(!text.includes(key), 'a key leaked');
    assert(!text.includes(key.slice(-8)), 'part of a key leaked');
  }
});

test("piSaysAlready: Pi's real already_approved body, and the other shapes", () => {
  const real = {
    error: 'already_approved',
    error_message: 'Current payment is already approved.',
  };
  assert(piSaysAlready(real, 'approved'));
  assert(
    piSaysAlready({ error_message: 'Payment Already Approved' }, 'approved'),
  );
  assert(
    piSaysAlready({ message: 'This payment was already approved' }, 'approved'),
  );
  assert(
    piSaysAlready(
      { error: 'already_completed', error_message: 'x' },
      'completed',
    ),
  );
  assert(
    piSaysAlready(
      { error_message: 'Current payment is already completed.' },
      'completed',
    ),
  );
  assert(!piSaysAlready(real, 'completed'));
  assert(!piSaysAlready({ error: 'payment_not_found' }, 'approved'));
  assert(!piSaysAlready({ error_message: 42 }, 'approved'));
  assert(!piSaysAlready(null, 'approved'));
  assert(!piSaysAlready('already approved', 'approved'));
});
