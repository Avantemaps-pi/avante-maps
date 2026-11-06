/**
 * The new-message email's "Reply in Avante Maps" link: /communicon?conversation=<id> opens Messages
 * with that conversation (the customer's, or in the owner's business inbox), takes the parameter
 * out of the address bar, and leaves the remembered tab alone. A conversation the user can't see
 * shows the existing error.
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
const OTHER_CUSTOMER = '00000000-0000-0000-0000-0000000000aa';
const OWN_BUSINESS = { id: 9001, business_name: 'Harbour Light Coffee' };

// The user's own conversation as a customer, and a customer's conversation with their business
const AS_CUSTOMER = '11111111-1111-4111-8111-111111111111';
const AS_OWNER = '33333333-3333-4333-8333-333333333333';
const HIDDEN = '44444444-4444-4444-8444-444444444444';

const conversations = [
  {
    id: AS_CUSTOMER,
    business_id: 5005,
    customer_id: mockUser.uid,
    customer_unread: 1,
    business_unread: 0,
    last_message_preview: 'Preview: customer side',
  },
  {
    id: AS_OWNER,
    business_id: OWN_BUSINESS.id,
    customer_id: OTHER_CUSTOMER,
    customer_unread: 0,
    business_unread: 1,
    last_message_preview: 'Preview: owner side',
  },
];
const THREADS: Record<string, string> = {
  [AS_CUSTOMER]: 'Thread body: your order is ready',
  [AS_OWNER]: 'Thread body: are you open on Sunday?',
};

async function setup(page: Page, options: { rememberedTab?: string } = {}) {
  const conversationGets: string[] = [];
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
  // As RLS and the filters would: a hidden conversation never comes back
  await page.route('**/rest/v1/conversations*', (route) => {
    const request = route.request();
    if (request.method() !== 'GET')
      return route.fulfill({ status: 204, body: '' });
    const url = new URL(request.url());
    conversationGets.push(url.search);
    const eq = (column: string) =>
      url.searchParams.get(column)?.replace(/^eq\./, '');
    const rows = conversations.filter(
      (c) =>
        (!eq('id') || c.id === eq('id')) &&
        (!eq('customer_id') || c.customer_id === eq('customer_id')) &&
        (!eq('business_id') || String(c.business_id) === eq('business_id')),
    );
    const full = rows.map((c) => ({
      ...c,
      last_message_at: '2026-11-06T10:00:00Z',
      created_at: '2026-11-01T00:00:00Z',
    }));
    if (request.headers()['accept']?.includes('vnd.pgrst.object')) {
      return full.length === 1
        ? route.fulfill({ json: full[0] })
        : route.fulfill({ status: 406, json: { code: 'PGRST116' } });
    }
    return route.fulfill({ json: full });
  });
  await page.route('**/rest/v1/messages*', (route) => {
    const id =
      new URL(route.request().url()).searchParams
        .get('conversation_id')
        ?.replace(/^eq\./, '') ?? '';
    const body = THREADS[id];
    return route.fulfill({
      json: body
        ? [
            {
              id: `m-${id}`,
              conversation_id: id,
              sender_id: OTHER_CUSTOMER,
              sender_role: 'customer',
              body,
              read_at: null,
              created_at: '2026-11-06T10:00:00Z',
            },
          ]
        : [],
    });
  });
  // The user owns business 9001 only
  await page.route('**/rest/v1/businesses*', (route) => {
    const url = new URL(route.request().url());
    const id = url.searchParams.get('id')?.replace(/^eq\./, '');
    const rows = !id || id === String(OWN_BUSINESS.id) ? [OWN_BUSINESS] : [];
    if (route.request().headers()['accept']?.includes('vnd.pgrst.object')) {
      return rows.length === 1
        ? route.fulfill({ json: rows[0] })
        : route.fulfill({ status: 406, json: { code: 'PGRST116' } });
    }
    return route.fulfill({ json: rows });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  if (options.rememberedTab) {
    await page.addInitScript((tab) => {
      if (!sessionStorage.getItem('communicon-tab-set-by-test')) {
        sessionStorage.setItem('communicon-tab', tab);
        sessionStorage.setItem('communicon-tab-set-by-test', '1');
      }
    }, options.rememberedTab);
  }
  return { conversationGets };
}

const messagesTab = (page: Page) =>
  page.getByRole('tab', { name: /^Messages/ });

test("the customer's link opens Messages with that conversation, and the parameter is gone", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/communicon?conversation=${AS_CUSTOMER}`);
  await expect(page.getByText(THREADS[AS_CUSTOMER]!)).toBeVisible();
  await expect(messagesTab(page)).toHaveAttribute('aria-selected', 'true');
  expect(new URL(page.url()).search).toBe('');
});

test("the owner's link opens the conversation in that business's inbox", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/communicon?conversation=${AS_OWNER}`);
  await expect(page.getByText(THREADS[AS_OWNER]!)).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});

test('the link wins over the remembered Bot tab, and leaves it remembered', async ({
  page,
}) => {
  await setup(page, { rememberedTab: 'ai' });
  await page.goto(`/communicon?conversation=${AS_CUSTOMER}`);
  await expect(page.getByText(THREADS[AS_CUSTOMER]!)).toBeVisible();
  await expect(messagesTab(page)).toHaveAttribute('aria-selected', 'true');
  expect(
    await page.evaluate(() => sessionStorage.getItem('communicon-tab')),
  ).toBe('ai');
  // A later visit without the link (a new history entry) opens on the remembered tab
  await page.goto('/');
  await page.goto('/communicon');
  await expect(page.getByRole('tab', { name: 'Bot' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test("a conversation the user can't access shows the existing error, and the parameter is gone", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/communicon?conversation=${HIDDEN}`);
  await expect(page.getByText('Conversation not found')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByText(/^Thread body/)).toHaveCount(0);
});

test('a malformed conversation id shows the same error without asking for it', async ({
  page,
}) => {
  const { conversationGets } = await setup(page);
  await page.goto('/communicon?conversation=not-a-uuid');
  await expect(page.getByText('Conversation not found')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(conversationGets.filter((q) => q.includes('not-a-uuid'))).toEqual([]);
});
