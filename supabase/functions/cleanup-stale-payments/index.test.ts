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

test('testnet key only: cancelled with it, without looking it up first (as before), row marked', async () => {
  const { fake, piCalls, status } = setup([stale('pay_t')], {
    pay_t: 'testnet',
  });
  const { json } = await call();
  assertEquals(json.cleanedCount, 1);
  assertEquals(piCalls, ['cancel pay_t:testnet']);
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

test('both keys, neither app has it: nothing cancelled at Pi, the row still marked (as before)', async () => {
  Deno.env.set('PI_MAINNET_API_KEY', MAINNET_KEY);
  try {
    const { fake, piCalls, status } = setup([stale('pay_gone')], {});
    const { json } = await call();
    assertEquals(json.cleanedCount, 1);
    assertEquals(piCalls, ['get pay_gone:testnet', 'get pay_gone:mainnet']);
    assert(!piCalls.some((c) => c.startsWith('cancel')));
    assertEquals(status('pay_gone')['cancelled'], true);
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
