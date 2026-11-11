/**
 * Unit tests for the shared notification helpers, with Supabase mocked.
 * Run (no local Deno needed):
 *   docker run --rm -v "$PWD:/app" -w /app denoland/deno:2.1.4 deno test --no-lock --allow-env --allow-net --allow-read supabase/functions/_shared/notifications.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  FAKE_SUPABASE_URL,
  installFakeSupabase,
  type Row,
} from '../../../tests/deno/fakeSupabase.ts';
import {
  createBalancePaymentNotification,
  createNotification,
  planName,
} from './notifications.ts';

const OWNER = '00000000-0000-0000-0000-0000000000a1';

const test = (name: string, fn: () => void | Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

const client = () => createClient(FAKE_SUPABASE_URL, 'test-service');

test('planName: display names, and an unknown slug as it is', () => {
  assertEquals(planName('small-business'), 'Small Business');
  assertEquals(planName('organization'), 'Organization');
  assertEquals(planName('individual'), 'Individual');
  assertEquals(planName('platinum'), 'platinum');
});

test('a balance plan payment: the display name, 2 decimals, plan_paid, /pricing', async () => {
  const fake = installFakeSupabase({
    tables: { notifications: [] },
    users: {},
  });
  const result = await createBalancePaymentNotification(
    client(),
    OWNER,
    70.3,
    'organization',
  );
  assertEquals(result.success, true);
  const n = fake.tables['notifications']![0]!;
  assertEquals(
    n['content'],
    'Your Organization plan is active. 70.30 π was paid from your Avante Maps balance.',
  );
  assertEquals(n['click_url'], '/pricing');
  assertEquals((n['metadata'] as Row)['kind'], 'plan_paid');
  fake.restore();
});

test('any other balance payment: the same wording, its own kind, Open wallet and /wallet', async () => {
  const fake = installFakeSupabase({
    tables: { notifications: [] },
    users: {},
  });
  await createBalancePaymentNotification(client(), OWNER, 0.5);
  const n = fake.tables['notifications']![0]!;
  assertEquals(n['content'], '0.50 π was paid from your Avante Maps balance.');
  assertEquals(n['click_url'], '/wallet');
  assertEquals(n['metadata'], {
    kind: 'balance_paid',
    amount: 0.5,
    actionLabel: 'Open wallet',
  });
  assertEquals(
    [n['type'], n['priority'], n['read']],
    ['payment', 'high', false],
  );
  fake.restore();
});

test('createNotification without a clickUrl writes no click_url (insert-business as before)', async () => {
  const fake = installFakeSupabase({
    tables: { notifications: [] },
    users: {},
  });
  await createNotification(client(), {
    userId: OWNER,
    type: 'business',
    content: 'Registered',
  });
  assertEquals('click_url' in fake.tables['notifications']![0]!, false);
  fake.restore();
});
