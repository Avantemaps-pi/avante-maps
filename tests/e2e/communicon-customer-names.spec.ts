/**
 * A business inbox shows each customer's Pi username ("@alice") from the owner-only
 * get_conversation_customer_names RPC, in the list and the open conversation's header. While it
 * loads, on an error, or for a customer without a username, it keeps "Customer 5627fb". A
 * customer inbox never asks for it.
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page } from './helpers/fixtures';
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
const OWN_BUSINESS = { id: 9001, business_name: 'Harbour Light Coffee' };
const ALICE = '5627fb00-0000-4000-8000-000000000001';
const NO_NAME = '9b31ce00-0000-4000-8000-000000000002';

const conversations = [
  {
    id: 'c-alice',
    business_id: OWN_BUSINESS.id,
    customer_id: ALICE,
    last_message_preview: 'Are you open on Sunday?',
    customer_unread: 0,
    business_unread: 0,
  },
  {
    id: 'c-noname',
    business_id: OWN_BUSINESS.id,
    customer_id: NO_NAME,
    last_message_preview: 'Do you deliver?',
    customer_unread: 0,
    business_unread: 0,
  },
  // The user's own conversation as a customer, with another business
  {
    id: 'c-mine',
    business_id: 5005,
    customer_id: mockUser.uid,
    last_message_preview: 'Thanks!',
    customer_unread: 0,
    business_unread: 0,
  },
];

async function setup(
  page: Page,
  options: { rpc?: 'answers' | 'fails'; scheme?: string } = {},
) {
  const rpcCalls: string[][] = [];
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(
    page,
    NEARBY_BUSINESSES,
    options.scheme ? { storage: { colorScheme: options.scheme } } : {},
  );
  await page.route('**/rest/v1/businesses*', (route) =>
    route.fulfill({ json: [OWN_BUSINESS] }),
  );
  await page.route('**/rest/v1/conversations*', (route) => {
    const request = route.request();
    if (request.method() !== 'GET')
      return route.fulfill({ status: 204, body: '' });
    const url = new URL(request.url());
    const eq = (column: string) =>
      url.searchParams.get(column)?.replace(/^eq\./, '');
    const rows = conversations.filter(
      (c) =>
        (!eq('customer_id') || c.customer_id === eq('customer_id')) &&
        (!eq('business_id') || String(c.business_id) === eq('business_id')),
    );
    return route.fulfill({
      json: rows.map((c) => ({
        ...c,
        last_message_at: '2026-11-07T10:00:00Z',
        created_at: '2026-11-01T00:00:00Z',
      })),
    });
  });
  await page.route('**/rest/v1/messages*', (route) => {
    const id =
      new URL(route.request().url()).searchParams
        .get('conversation_id')
        ?.replace(/^eq\./, '') ?? '';
    return route.fulfill({
      json: [
        {
          id: `m-${id}`,
          conversation_id: id,
          sender_id: ALICE,
          sender_role: 'customer',
          body: `Thread of ${id}`,
          read_at: null,
          created_at: '2026-11-07T10:00:00Z',
        },
      ],
    });
  });
  await page.route(
    '**/rest/v1/rpc/get_conversation_customer_names',
    (route) => {
      const ids = (
        route.request().postDataJSON() as { p_conversation_ids: string[] }
      ).p_conversation_ids;
      rpcCalls.push(ids);
      if (options.rpc === 'fails')
        return route.fulfill({
          status: 500,
          json: { code: 'XX000', message: 'boom' },
        });
      // As the function would: only the owner's conversations, and only customers with a username
      return route.fulfill({
        json: ids.includes('c-alice')
          ? [{ conversation_id: 'c-alice', username: 'alice' }]
          : [],
      });
    },
  );
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  return { rpcCalls };
}

const picker = (page: Page) => page.getByRole('combobox', { name: 'Inbox' });

async function openBusinessInbox(page: Page) {
  await page.goto('/communicon');
  await picker(page).tap();
  await page.getByRole('option', { name: /Harbour Light Coffee/ }).tap();
  await expect(page.getByText('Are you open on Sunday?')).toBeVisible();
}

test('a business inbox shows "@alice" in the row and the open conversation\'s header', async ({
  page,
}) => {
  const { rpcCalls } = await setup(page, { rpc: 'answers' });
  await openBusinessInbox(page);
  await expect(page.getByText('@alice', { exact: true })).toBeVisible();
  // A customer without a name keeps the fallback
  await expect(
    page.getByText('Customer 9b31ce', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Customer 5627fb')).toHaveCount(0);
  // Asked once, with this inbox's conversations
  expect(rpcCalls.length).toBe(1);
  expect([...rpcCalls[0]!].sort()).toEqual(['c-alice', 'c-noname']);

  await page.getByText('Are you open on Sunday?').tap();
  await expect(page.getByText('Thread of c-alice')).toBeVisible();
  const header = page
    .getByRole('button', { name: 'Back to conversations' })
    .locator('xpath=..');
  await expect(header).toContainText('@alice');
});

test('an RPC error keeps "Customer 5627fb", and the inbox still works', async ({
  page,
}) => {
  const { rpcCalls } = await setup(page, { rpc: 'fails' });
  await openBusinessInbox(page);
  await expect.poll(() => rpcCalls.length).toBe(1);
  await expect(
    page.getByText('Customer 5627fb', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('@alice')).toHaveCount(0);

  await page.getByText('Are you open on Sunday?').tap();
  await expect(page.getByText('Thread of c-alice')).toBeVisible();
  const header = page
    .getByRole('button', { name: 'Back to conversations' })
    .locator('xpath=..');
  await expect(header).toContainText('Customer 5627fb');
  await expect(
    page.getByPlaceholder('Reply as your business...'),
  ).toBeVisible();
});

test('a customer inbox never asks for usernames', async ({ page }) => {
  const { rpcCalls } = await setup(page, { rpc: 'answers' });
  await page.goto('/communicon');
  await expect(picker(page)).toContainText('My messages');
  await expect(page.getByText('Thanks!')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(rpcCalls).toEqual([]);
});
