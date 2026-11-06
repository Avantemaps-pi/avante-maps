/**
 * Unread message badges: the bottom nav's CommuniCon tab and CommuniCon's Messages tab show the
 * user's unread count (customer_unread on their own conversations, business_unread on their
 * businesses'), follow realtime changes, and clear when the conversation is opened.
 *
 * 375x812 with the sandbox session, a fake Supabase session, mocked Supabase and a mocked
 * realtime socket.
 */
import {
  test,
  expect,
  type Page,
  type WebSocketRoute,
} from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: {
    id: mockUser.uid,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
};
const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const OTHER_CUSTOMER = '00000000-0000-0000-0000-0000000000aa';

interface ConversationRow {
  id: string;
  business_id: number;
  customer_id: string;
  customer_unread: number;
  business_unread: number;
  last_message_preview: string;
}

const conversation = (
  id: string,
  fields: Partial<ConversationRow>,
): ConversationRow => ({
  id,
  business_id: 9001,
  customer_id: mockUser.uid,
  customer_unread: 0,
  business_unread: 0,
  last_message_preview: `Preview ${id}`,
  ...fields,
});

// The realtime socket: joins are accepted with the channel's own postgres_changes bindings, and
// push() sends a conversations UPDATE to every channel listening for one
async function mockRealtime(page: Page) {
  let nextId = 1;
  const channels: Array<{
    ws: WebSocketRoute;
    topic: string;
    bindings: Array<{ id: number; event: string; table?: string }>;
  }> = [];
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      if (event === 'phx_join') {
        const requested: Array<{ event: string; table?: string }> =
          payload?.config?.postgres_changes ?? [];
        const bindings = requested.map((binding) => ({
          ...binding,
          id: nextId++,
        }));
        channels.push({ ws, topic, bindings });
        ws.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            'phx_reply',
            { status: 'ok', response: { postgres_changes: bindings } },
          ]),
        );
      } else if (ref) {
        ws.send(
          JSON.stringify([
            joinRef,
            ref,
            topic,
            'phx_reply',
            { status: 'ok', response: {} },
          ]),
        );
      }
    });
  });
  return {
    joined: () =>
      channels.filter((c) =>
        c.bindings.some(
          (b) => b.table === 'conversations' && b.event === 'UPDATE',
        ),
      ).length,
    push(record: ConversationRow) {
      for (const { ws, topic, bindings } of channels) {
        const ids = bindings
          .filter(
            (b) =>
              b.table === 'conversations' &&
              (b.event === 'UPDATE' || b.event === '*'),
          )
          .map((b) => b.id);
        if (ids.length === 0) continue;
        const data = {
          type: 'UPDATE',
          schema: 'public',
          table: 'conversations',
          commit_timestamp: new Date().toISOString(),
          columns: [],
          errors: null,
          record,
          old_record: { id: record.id },
        };
        ws.send(
          JSON.stringify([
            null,
            null,
            topic,
            'postgres_changes',
            { ids, data },
          ]),
        );
      }
    },
  };
}

async function setup(
  page: Page,
  rows: ConversationRow[],
  options: { signedOut?: boolean; scheme?: string } = {},
) {
  const conversationRequests: string[] = [];
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(
    page,
    NEARBY_BUSINESSES,
    options.scheme ? { storage: { colorScheme: options.scheme } } : {},
  );
  // Answered like PostgREST with RLS: eq filters apply, and a PATCH zeroes the given count
  await page.route('**/rest/v1/conversations*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    conversationRequests.push(`${request.method()} ${url.search}`);
    const eq = (column: string) =>
      url.searchParams.get(column)?.replace(/^eq\./, '');
    const matching = rows.filter(
      (r) =>
        (!eq('id') || r.id === eq('id')) &&
        (!eq('customer_id') || r.customer_id === eq('customer_id')) &&
        (!eq('business_id') || String(r.business_id) === eq('business_id')),
    );
    if (request.method() === 'PATCH') {
      const update = request.postDataJSON() as Partial<ConversationRow>;
      for (const r of matching) Object.assign(r, update);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      json: matching.map((r) => ({
        ...r,
        last_message_at: '2026-11-06T10:00:00Z',
        created_at: '2026-11-01T00:00:00Z',
      })),
    });
  });
  const realtime = await mockRealtime(page);
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  if (options.signedOut)
    await page.addInitScript(() => {
      localStorage.clear();
    });
  return { conversationRequests, realtime };
}

const nav = (page: Page) => page.locator('nav').filter({ hasText: 'Discover' });
const navBadge = (page: Page) => nav(page).locator('[data-unread-badge]');
const messagesPill = (page: Page) =>
  page.getByRole('tab', { name: /^Messages/ }).locator('[data-unread-pill]');

async function openMap(page: Page) {
  await page.goto('/');
  await expect(
    page.locator('input[aria-label="Search businesses"]'),
  ).toHaveAttribute('placeholder', 'Search businesses');
}

test('customer: 2 + 1 unread shows 3 on the nav and the Messages tab', async ({
  page,
}) => {
  await setup(page, [
    conversation('c1', { customer_unread: 2, business_unread: 6 }),
    conversation('c2', { customer_unread: 1 }),
  ]);
  await openMap(page);
  await expect(navBadge(page)).toHaveText('3');
  await expect(
    nav(page).getByRole('link', { name: 'CommuniCon, 3 unread' }),
  ).toBeVisible();

  const badge = (await navBadge(page).boundingBox())!;
  expect(Math.round(badge.height)).toBe(16);
  expect(Math.round(badge.width)).toBeGreaterThanOrEqual(16);
  const style = await navBadge(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      color: s.color,
      background: s.backgroundColor,
    };
  });
  expect(style.fontSize).toBe('11px');
  expect(style.fontWeight).toBe('600');
  expect(style.color).toBe('rgb(255, 255, 255)');
  // Primary blue (#2563EB; the HSL token rounds the green to 100), not red
  expect(style.background).toMatch(/^rgb\(37, (99|100), 235\)$/);

  await nav(page)
    .getByRole('link', { name: /CommuniCon/ })
    .tap();
  await page.waitForURL('**/communicon');
  await expect(messagesPill(page)).toHaveText('3 unread');
  await expect(messagesPill(page)).toBeVisible();
});

test("owner: business_unread on their business's conversations counts, customer_unread on them doesn't", async ({
  page,
}) => {
  await setup(page, [
    // A customer's conversation with the user's business
    conversation('b1', {
      customer_id: OTHER_CUSTOMER,
      business_unread: 4,
      customer_unread: 7,
    }),
    // The user's own conversation as a customer
    conversation('c1', { customer_unread: 1, business_unread: 5 }),
  ]);
  await openMap(page);
  await expect(navBadge(page)).toHaveText('5');
  await expect(
    nav(page).getByRole('link', { name: 'CommuniCon, 5 unread' }),
  ).toBeVisible();
});

test('12 unread shows 9+', async ({ page }) => {
  await setup(page, [conversation('c1', { customer_unread: 12 })]);
  await openMap(page);
  await expect(navBadge(page)).toHaveText('9+');
  await expect(
    nav(page).getByRole('link', { name: 'CommuniCon, 12 unread' }),
  ).toBeVisible();
  await page.goto('/communicon');
  await expect(messagesPill(page)).toHaveText('9+ unread');
});

test('a realtime UPDATE changes the badge without a reload', async ({
  page,
}) => {
  const rows = [conversation('c1', { customer_unread: 2 })];
  const { realtime } = await setup(page, rows);
  await openMap(page);
  await expect(navBadge(page)).toHaveText('2');
  await expect.poll(() => realtime.joined()).toBeGreaterThan(0);

  const row = rows[0]!;
  row.customer_unread = 5;
  realtime.push(row);
  await expect(navBadge(page)).toHaveText('5');
  await expect(
    nav(page).getByRole('link', { name: 'CommuniCon, 5 unread' }),
  ).toBeVisible();
});

test('opening the conversation clears it within a second', async ({ page }) => {
  await setup(page, [
    conversation('c1', { customer_unread: 2 }),
    conversation('c2', { customer_unread: 1 }),
  ]);
  await page.goto('/communicon');
  await expect(messagesPill(page)).toHaveText('3 unread');
  await page.getByText('Preview c1').tap();
  await expect(messagesPill(page)).toHaveText('1 unread', { timeout: 1000 });

  await page.goto('/');
  await expect(navBadge(page)).toHaveText('1');
});

test('signed out: no badge and no conversations request', async ({ page }) => {
  const { conversationRequests } = await setup(
    page,
    [conversation('c1', { customer_unread: 2 })],
    { signedOut: true },
  );
  // Signed out, / is the landing page (no bottom nav); Discover has it
  await page.goto('/recommendations');
  await expect(
    nav(page).getByRole('link', { name: 'CommuniCon' }),
  ).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(navBadge(page)).toHaveCount(0);
  await page.goto('/communicon');
  await expect(page.getByRole('tab', { name: 'Messages' })).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(messagesPill(page)).toHaveCount(0);
  expect(conversationRequests).toEqual([]);
});

test('0 unread: no badge, no pill, plain accessible name', async ({ page }) => {
  const { conversationRequests } = await setup(page, [
    conversation('c1', {}),
    conversation('b1', { customer_id: OTHER_CUSTOMER, customer_unread: 3 }),
  ]);
  await openMap(page);
  await expect.poll(() => conversationRequests.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await expect(navBadge(page)).toHaveCount(0);
  await expect(
    nav(page).getByRole('link', { name: 'CommuniCon', exact: true }),
  ).toBeVisible();
  await page.goto('/communicon');
  await expect(page.getByText('Preview c1')).toBeVisible();
  await expect(messagesPill(page)).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveText(['Messages', 'Bot']);
});
