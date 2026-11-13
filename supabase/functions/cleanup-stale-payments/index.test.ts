/**
 * Unit tests for cleanup-stale-payments with Supabase, Pi's API and auth mocked: each stale
 * payment is cancelled at Pi in the app that has it, and its row marked cancelled.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 deno test --no-lock --allow-env --allow-net --allow-read supabase/functions/cleanup-stale-payments/index.test.ts
 */
import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  installFakeSupabase,
  loadHandler,
  setFunctionEnv,
  type Row,
} from '../../../tests/deno/fakeSupabase.ts';

setFunctionEnv();
Deno.env.set('PI_API_KEY', 'test-pi-key');
const handler = await loadHandler(new URL('./index.ts', import.meta.url).href);

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const MAINNET_KEY = 'test-pi-mainnet-key';
const OPEN = {
  approved: false,
  verified: false,
  completed: false,
  cancelled: false,
};
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60 * 1000).toISOString();

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

// Pi, where each payment id lives in one app: calls recorded as "action id:app"
function setup(rows: Row[], appOf: Record<string, 'testnet' | 'mainnet'>) {
  const piCalls: string[] = [];
  const fake = installFakeSupabase({
    tables: { payments: rows },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      const key = (
        new Headers(init?.headers).get('authorization') ?? ''
      ).replace('Key ', '');
      const app =
        key === 'test-pi-key'
          ? 'testnet'
          : key === MAINNET_KEY
            ? 'mainnet'
            : 'unknown key';
      const parts = url.pathname.split('/');
      const isGet = init?.method === 'GET';
      const id = isGet ? parts.pop()! : parts[parts.length - 2]!;
      piCalls.push(`${isGet ? 'get' : parts.pop()} ${id}:${app}`);
      if (appOf[id] !== app) {
        return Response.json(
          { error: 'payment_not_found', error_message: 'Payment not found' },
          { status: 404 },
        );
      }
      return Response.json({ identifier: id, amount: 1, user_uid: 'pi-uid' });
    },
  });
  return {
    fake,
    piCalls,
    status: (id: string) =>
      fake.tables['payments']!.find((r) => r['payment_id'] === id)![
        'status'
      ] as Row,
  };
}

const call = async () => {
  const res = await handler(
    new Request('http://fn/cleanup-stale-payments', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: OWNER }),
    }),
  );
  return { status: res.status, json: await res.json() };
};

const stale = (id: string): Row => ({
  payment_id: id,
  user_id: OWNER,
  status: OPEN,
  created_at: minutesAgo(20),
});

test('testnet key only: looked up first (nothing signed), then cancelled with it, row marked', async () => {
  const { fake, piCalls, status } = setup([stale('pay_t')], {
    pay_t: 'testnet',
  });
  const { json } = await call();
  assertEquals(json.cleanedCount, 1);
  assertEquals(piCalls, ['get pay_t:testnet', 'cancel pay_t:testnet']);
  assertEquals(status('pay_t')['cancelled'], true);
  fake.restore();
});

test('both keys: each stale payment is cancelled in the app that has it', async () => {
  Deno.env.set('PI_MAINNET_API_KEY', MAINNET_KEY);
  try {
    const { fake, piCalls, status } = setup(
      [
        stale('pay_t'),
        stale('pay_m'),
        { ...stale('pay_new'), created_at: minutesAgo(2) },
      ],
      { pay_t: 'testnet', pay_m: 'mainnet', pay_new: 'mainnet' },
    );
    const { json } = await call();
    assertEquals(json.cleanedCount, 2);
    assertEquals(piCalls, [
      'get pay_t:testnet',
      'cancel pay_t:testnet',
      'get pay_m:testnet',
      'get pay_m:mainnet',
      'cancel pay_m:mainnet',
    ]);
    assertEquals(
      [
        status('pay_t')['cancelled'],
        status('pay_m')['cancelled'],
        status('pay_new')['cancelled'],
      ],
      [true, true, false],
    );
    fake.restore();
  } finally {
    Deno.env.delete('PI_MAINNET_API_KEY');
  }
});

// Before: left open with a 502, so it came back on every run
test('both keys, neither app has it: nothing asked to cancel at Pi, the row marked "not found at Pi"', async () => {
  Deno.env.set('PI_MAINNET_API_KEY', MAINNET_KEY);
  try {
    const { fake, piCalls, status } = setup([stale('pay_gone')], {});
    const { json } = await call();
    assertEquals(json.cleanedCount, 1);
    assertEquals(piCalls, ['get pay_gone:testnet', 'get pay_gone:mainnet']);
    assert(!piCalls.some((c) => c.startsWith('cancel')));
    assertEquals(
      [status('pay_gone')['cancelled'], status('pay_gone')['error']],
      [true, 'Cancelled: not found at Pi'],
    );
    fake.restore();
  } finally {
    Deno.env.delete('PI_MAINNET_API_KEY');
  }
});

test('no Pi key at all: 500, nothing touched', async () => {
  Deno.env.delete('PI_API_KEY');
  try {
    const { fake, piCalls, status } = setup([stale('pay_t')], {
      pay_t: 'testnet',
    });
    const { status: code } = await call();
    assertEquals(code, 500);
    assertEquals(piCalls, []);
    assertEquals(status('pay_t')['cancelled'], false);
    fake.restore();
  } finally {
    Deno.env.set('PI_API_KEY', 'test-pi-key');
  }
});

// ── paymentId: one payment the wallet closed without signing ──

const OTHER = '00000000-0000-0000-0000-0000000000b2';
const APPROVED = { ...OPEN, approved: true };
const PI_OPEN = {
  developer_approved: true,
  transaction_verified: false,
  developer_completed: false,
  cancelled: false,
  user_cancelled: false,
};

// Pi with the testnet key only, answering each payment as given: calls recorded as "action id"
function setupOne(
  rows: Row[],
  piPayment: Record<string, unknown>,
  // Pi's answer to GET and to cancel (e.g. 500: unreachable, or a refused cancel)
  pi: { getStatus?: number; cancelStatus?: number } = {},
) {
  const piCalls: string[] = [];
  const fake = installFakeSupabase({
    tables: { payments: rows },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      const parts = url.pathname.split('/');
      if (init?.method === 'GET') {
        const id = parts.pop()!;
        piCalls.push(`get ${id}`);
        if (pi.getStatus) return Response.json({ error: 'boom' }, { status: pi.getStatus });
        return Response.json({ identifier: id, amount: 142.05, user_uid: 'pi-uid', ...piPayment });
      }
      const action = parts.pop();
      piCalls.push(`${action} ${parts.pop()}`);
      if (pi.cancelStatus) return Response.json({ error: 'refused' }, { status: pi.cancelStatus });
      return Response.json({ identifier: 'x' });
    },
  });
  return {
    fake,
    piCalls,
    row: (id: string) => fake.tables['payments']!.find((r) => r['payment_id'] === id)!,
  };
}

const callOne = async (paymentId: string) => {
  const res = await handler(
    new Request('http://fn/cleanup-stale-payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: OWNER, paymentId }),
    }),
  );
  return { status: res.status, json: await res.json() };
};

// Approved a minute ago: far younger than the 10 minute staleness limit
const approvedNow = (id: string, user = OWNER): Row => ({
  payment_id: id,
  user_id: user,
  status: APPROVED,
  txid: null,
  created_at: minutesAgo(1),
});

test('paymentId, Pi shows nothing signed: cancelled at Pi and the row cancelled, whatever its age', async () => {
  const { fake, piCalls, row } = setupOne(
    [approvedNow('pay_u'), { ...approvedNow('pay_other_open'), created_at: minutesAgo(30) }],
    { status: PI_OPEN, transaction: null },
  );
  const { status, json } = await callOne('pay_u');
  assertEquals(status, 200);
  assertEquals([json.success, json.cancelled, json.cleanedCount], [true, true, 1]);
  assertEquals(piCalls, ['get pay_u', 'cancel pay_u']);
  const s = row('pay_u')['status'] as Row;
  assertEquals([s['cancelled'], s['completed'], s['error']], [true, false, 'Cancelled: not signed in the Pi wallet']);
  // Only that payment: an old open one is left for the plain cleanup
  assertEquals((row('pay_other_open')['status'] as Row)['cancelled'], false);
  fake.restore();
});

test('paymentId, Pi shows a transaction: not cancelled, { signed: true } with the txid', async () => {
  const { fake, piCalls, row } = setupOne([approvedNow('pay_s')], {
    status: { ...PI_OPEN, transaction_verified: true },
    transaction: { txid: 'tx_abc', verified: true, _link: 'l' },
  });
  const { status, json } = await callOne('pay_s');
  assertEquals(status, 200);
  assertEquals([json.signed, json.txid, json.cleanedCount], [true, 'tx_abc', 0]);
  assertEquals(piCalls, ['get pay_s']);
  assertEquals(row('pay_s')['status'], APPROVED);
  fake.restore();
});

test('paymentId, Pi says developer_completed without a transaction object: still not cancelled', async () => {
  const { fake, piCalls, row } = setupOne([approvedNow('pay_dc')], {
    status: { ...PI_OPEN, developer_completed: true },
    transaction: null,
  });
  const { json } = await callOne('pay_dc');
  assertEquals(json.signed, true);
  assert(!piCalls.some((c) => c.startsWith('cancel')));
  assertEquals(row('pay_dc')['status'], APPROVED);
  fake.restore();
});

test("paymentId of someone else's payment: 403, nothing asked of Pi, nothing changed", async () => {
  const { fake, piCalls, row } = setupOne([approvedNow('pay_x', OTHER)], {
    status: PI_OPEN,
    transaction: null,
  });
  const { status } = await callOne('pay_x');
  assertEquals(status, 403);
  assertEquals(piCalls, []);
  assertEquals(row('pay_x')['status'], APPROVED);
  fake.restore();
});

test('paymentId of a completed payment: unchanged, nothing asked of Pi', async () => {
  const done = { ...APPROVED, verified: true, completed: true };
  const { fake, piCalls, row } = setupOne(
    [{ ...approvedNow('pay_done'), status: done, txid: 'tx_done' }],
    { status: PI_OPEN, transaction: null },
  );
  const { status, json } = await callOne('pay_done');
  assertEquals([status, json.cleanedCount], [200, 0]);
  assertEquals(piCalls, []);
  assertEquals(row('pay_done')['status'], done);
  fake.restore();
});

test('paymentId that Pi already cancelled: no second cancel at Pi, the row marked', async () => {
  const { fake, piCalls, row } = setupOne([approvedNow('pay_pc')], {
    status: { ...PI_OPEN, cancelled: true, user_cancelled: true },
    transaction: null,
  });
  const { json } = await callOne('pay_pc');
  assertEquals(json.cleanedCount, 1);
  assertEquals(piCalls, ['get pay_pc']);
  assertEquals((row('pay_pc')['status'] as Row)['cancelled'], true);
  fake.restore();
});

test('no paymentId: as before, only payments over 10 minutes old are cancelled', async () => {
  const { fake, piCalls, status } = setup(
    [stale('pay_old'), { ...stale('pay_young'), created_at: minutesAgo(1) }],
    { pay_old: 'testnet', pay_young: 'testnet' },
  );
  const { json } = await call();
  assertEquals(json.cleanedCount, 1);
  assertEquals(piCalls, ['get pay_old:testnet', 'cancel pay_old:testnet']);
  assertEquals([status('pay_old')['cancelled'], status('pay_young')['cancelled']], [true, false]);
  assertEquals(
    status('pay_old')['error'],
    'Payment automatically cancelled due to staleness (>10 minutes old)',
  );
  fake.restore();
});

// ── No paymentId: each stale row as safely as one by paymentId ──

// Approved 20 minutes ago: stale
const staleApproved = (id: string, extra: Row = {}): Row => ({
  ...approvedNow(id),
  created_at: minutesAgo(20),
  ...extra,
});

test('stale row with a txid: untouched, nothing asked of Pi, counted as signed', async () => {
  const { fake, piCalls, row } = setupOne(
    [staleApproved('pay_tx', { txid: 'tx_row' })],
    { status: PI_OPEN, transaction: null },
  );
  const { json } = await call();
  assertEquals([json.cleanedCount, json.signedCount], [0, 1]);
  assertEquals(piCalls, []);
  assertEquals(row('pay_tx')['status'], APPROVED);
  fake.restore();
});

test('stale row where Pi shows a transaction: untouched, counted as signed', async () => {
  const { fake, piCalls, row } = setupOne([staleApproved('pay_pi_tx')], {
    status: { ...PI_OPEN, transaction_verified: true },
    transaction: { txid: 'tx_pi', verified: true, _link: 'l' },
  });
  const { json } = await call();
  assertEquals([json.cleanedCount, json.signedCount], [0, 1]);
  assertEquals(piCalls, ['get pay_pi_tx']);
  assertEquals(row('pay_pi_tx')['status'], APPROVED);
  fake.restore();
});

test('stale row whose cancel Pi refuses: the row untouched', async () => {
  const { fake, piCalls, row } = setupOne(
    [staleApproved('pay_refused')],
    { status: PI_OPEN, transaction: null },
    { cancelStatus: 500 },
  );
  const { json } = await call();
  assertEquals(json.cleanedCount, 0);
  assertEquals(piCalls, ['get pay_refused', 'cancel pay_refused']);
  assertEquals(row('pay_refused')['status'], APPROVED);
  fake.restore();
});

test("stale row when Pi can't be reached: untouched, left for next time", async () => {
  const { fake, piCalls, row } = setupOne(
    [staleApproved('pay_down')],
    { status: PI_OPEN, transaction: null },
    { getStatus: 503 },
  );
  const { json } = await call();
  assertEquals(json.cleanedCount, 0);
  assertEquals(piCalls, ['get pay_down']);
  assertEquals(row('pay_down')['status'], APPROVED);
  fake.restore();
});

test('stale unsigned row: cancelled at Pi and marked, with the staleness text, as before', async () => {
  const { fake, piCalls, row } = setupOne([staleApproved('pay_unsigned')], {
    status: PI_OPEN,
    transaction: null,
  });
  const { json } = await call();
  assertEquals([json.cleanedCount, json.signedCount], [1, 0]);
  assertEquals(piCalls, ['get pay_unsigned', 'cancel pay_unsigned']);
  const s = row('pay_unsigned')['status'] as Row;
  assertEquals(
    [s['cancelled'], s['error']],
    [true, 'Payment automatically cancelled due to staleness (>10 minutes old)'],
  );
  fake.restore();
});

test('stale row Pi already cancelled: only our row marked, no second cancel', async () => {
  const { fake, piCalls, row } = setupOne([staleApproved('pay_gone_pi')], {
    status: { ...PI_OPEN, cancelled: true },
    transaction: null,
  });
  const { json } = await call();
  assertEquals(json.cleanedCount, 1);
  assertEquals(piCalls, ['get pay_gone_pi']);
  assertEquals((row('pay_gone_pi')['status'] as Row)['cancelled'], true);
  fake.restore();
});

test('paymentId of a row with a txid: { signed: true } with that txid, nothing asked of Pi', async () => {
  const { fake, piCalls, row } = setupOne(
    [{ ...approvedNow('pay_row_tx'), txid: 'tx_row' }],
    { status: PI_OPEN, transaction: null },
  );
  const { json } = await callOne('pay_row_tx');
  assertEquals([json.signed, json.txid], [true, 'tx_row']);
  assertEquals(piCalls, []);
  assertEquals(row('pay_row_tx')['status'], APPROVED);
  fake.restore();
});

// ── Both keys, paymentId: a payment neither Pi app can find ──

type PiAnswer = 'has_it' | 404 | 500;

// Each app answers GET as given (404 is Pi's payment_not_found): calls recorded as "action id:app"
function setupBothKeys(rows: Row[], answers: { testnet: PiAnswer; mainnet: PiAnswer }) {
  const piCalls: string[] = [];
  const fake = installFakeSupabase({
    tables: { payments: rows },
    users: { 'owner-token': OWNER },
    external: (url, init) => {
      if (url.host !== 'api.minepi.com') return undefined;
      const key = (new Headers(init?.headers).get('authorization') ?? '').replace('Key ', '');
      const app = key === MAINNET_KEY ? 'mainnet' : 'testnet';
      const parts = url.pathname.split('/');
      const isGet = init?.method === 'GET';
      const id = isGet ? parts.pop()! : parts[parts.length - 2]!;
      piCalls.push(`${isGet ? 'get' : parts.pop()} ${id}:${app}`);
      const answer = answers[app];
      if (answer === 404) {
        return Response.json({ error: 'payment_not_found', error_message: 'Payment not found' }, { status: 404 });
      }
      if (answer === 500) return Response.json({ error: 'boom' }, { status: 500 });
      return Response.json({ identifier: id, amount: 1, user_uid: 'pi-uid', status: PI_OPEN, transaction: null });
    },
  });
  return {
    fake,
    piCalls,
    row: (id: string) => fake.tables['payments']!.find((r) => r['payment_id'] === id)!,
  };
}

const withBothKeys = async (fn: () => Promise<void>) => {
  Deno.env.set('PI_MAINNET_API_KEY', MAINNET_KEY);
  try {
    await fn();
  } finally {
    Deno.env.delete('PI_MAINNET_API_KEY');
  }
};

test('both keys return 404 for the paymentId: the row cancelled "not found at Pi", 200, no cancel at Pi', () =>
  withBothKeys(async () => {
    const { fake, piCalls, row } = setupBothKeys([approvedNow('pay_nf')], { testnet: 404, mainnet: 404 });
    const { status, json } = await callOne('pay_nf');
    assertEquals(status, 200);
    assertEquals([json.success, json.cancelled, json.cleanedCount], [true, true, 1]);
    assertEquals(piCalls, ['get pay_nf:testnet', 'get pay_nf:mainnet']);
    const s = row('pay_nf')['status'] as Row;
    assertEquals([s['cancelled'], s['completed'], s['error']], [true, false, 'Cancelled: not found at Pi']);
    fake.restore();
  }));

test('one key returns 404 and the other 500: left open, 502', () =>
  withBothKeys(async () => {
    const { fake, piCalls, row } = setupBothKeys([approvedNow('pay_half')], { testnet: 404, mainnet: 500 });
    const { status, json } = await callOne('pay_half');
    assertEquals([status, json.cleanedCount], [502, 0]);
    assertEquals(piCalls, ['get pay_half:testnet', 'get pay_half:mainnet']);
    assertEquals(row('pay_half')['status'], APPROVED);
    fake.restore();
  }));

test('the first key returns 500: no second lookup, left open, 502', () =>
  withBothKeys(async () => {
    const { fake, piCalls, row } = setupBothKeys([approvedNow('pay_down2')], { testnet: 500, mainnet: 404 });
    const { status } = await callOne('pay_down2');
    assertEquals(status, 502);
    assertEquals(piCalls, ['get pay_down2:testnet']);
    assertEquals(row('pay_down2')['status'], APPROVED);
    fake.restore();
  }));

test('a row with a txid is never touched, even when neither app has the payment', () =>
  withBothKeys(async () => {
    const { fake, piCalls, row } = setupBothKeys(
      [
        { ...approvedNow('pay_tx_nf'), txid: 'tx_row' },
        staleApproved('pay_tx_nf_stale', { txid: 'tx_row2' }),
      ],
      { testnet: 404, mainnet: 404 },
    );
    const one = await callOne('pay_tx_nf');
    assertEquals([one.status, one.json.signed, one.json.cleanedCount], [200, true, 0]);
    const all = await call();
    assertEquals(all.json.cleanedCount, 0);
    assertEquals(piCalls, []);
    assertEquals(row('pay_tx_nf')['status'], APPROVED);
    assertEquals(row('pay_tx_nf_stale')['status'], APPROVED);
    fake.restore();
  }));

test('only PI_API_KEY set, and it returns 404 payment_not_found: the row not changed, 502', async () => {
  const { fake, piCalls, row } = setupBothKeys([approvedNow('pay_one_key')], { testnet: 404, mainnet: 404 });
  const { status, json } = await callOne('pay_one_key');
  assertEquals([status, json.cleanedCount], [502, 0]);
  assertEquals(piCalls, ['get pay_one_key:testnet']);
  assertEquals(row('pay_one_key')['status'], APPROVED);
  fake.restore();
});
