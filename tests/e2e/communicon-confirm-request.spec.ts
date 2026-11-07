/**
 * The "contact email changed" notification links to /communicon?confirm=1: it opens the Bot tab on
 * the contact email confirmation (a code already sent, or else the verification check, which
 * sends one), takes the parameter out of the address bar, and leaves the remembered tab alone.
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page, type Request } from './helpers/fixtures';
import { SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser } from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const fakeSession = {
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
const HARBOUR = {
  id: 9001,
  business_name: 'Harbour Light Coffee',
  verification_status: null,
  is_verified: false,
  is_active: true,
  created_at: '2026-10-01T00:00:00Z',
};

async function setup(page: Page, options: { pendingCode?: boolean } = {}) {
  const verifyCalls: Request[] = [];
  const otpCalls: Request[] = [];
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: fakeSession.user }),
  );
  for (const t of [
    'users',
    'user_roles',
    'conversations',
    'messages',
    'notifications',
  ]) {
    await page.route(`**/rest/v1/${t}*`, (route) =>
      route.fulfill({ json: [] }),
    );
  }
  await page.route('**/rest/v1/businesses*', (route) =>
    (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object')
      ? route.fulfill({
          json: {
            contact_info: { email: 'new@harbour.example' },
            contact_email_verified_for: null,
          },
        })
      : route.fulfill({ json: [HARBOUR] }),
  );
  await page.route('**/functions/v1/chat-ai', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
    }),
  );
  await page.route('**/functions/v1/contact-otp', (route) => {
    otpCalls.push(route.request());
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/functions/v1/verify-business', (route) => {
    verifyCalls.push(route.request());
    const { business_id: id } = route.request().postDataJSON() as {
      business_id: number;
    };
    return route.fulfill({
      json: {
        success: true,
        results: [
          {
            id,
            name: 'x',
            verified: false,
            contactConfirmed: false,
            reason: 'Contact email not confirmed',
            totalTransactions: 13,
            creditedTransactions: 4,
            uniqueWallets: 9,
          },
        ],
      },
    });
  });
  await page.addInitScript(
    ([mockKey, storageKey, user, session, pending]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(
        storageKey as string,
        JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }),
      );
      localStorage.setItem('supabase.auth.token', JSON.stringify(session));
      // Messages was the tab picked earlier in this visit: the link must still open Bot
      if (!sessionStorage.getItem('communicon-tab'))
        sessionStorage.setItem('communicon-tab', 'live');
      if (pending && !sessionStorage.getItem('pending-seeded')) {
        localStorage.setItem(
          'avante:pending-contact-code',
          JSON.stringify({
            businessId: 9001,
            email: 'new@harbour.example',
            businessName: 'Harbour Light Coffee',
            sentAt: Date.now(),
          }),
        );
        sessionStorage.setItem('pending-seeded', '1');
      }
    },
    [
      SANDBOX_MOCK_KEY,
      STORAGE_KEY,
      mockUser,
      fakeSession,
      !!options.pendingCode,
    ] as const,
  );
  return { verifyCalls, otpCalls };
}

const tab = (page: Page, name: 'Messages' | 'Bot') =>
  page.getByRole('tab', { name: new RegExp(`^${name}`), includeHidden: true });
const cardFor = (page: Page) =>
  page.getByRole('region', {
    name: `Verification progress for ${HARBOUR.business_name}`,
  });

test('?confirm=1 opens Bot and runs the verification check, and the parameter is gone', async ({
  page,
}) => {
  const { verifyCalls } = await setup(page);
  await page.goto('/communicon?confirm=1');
  await expect(tab(page, 'Bot')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(cardFor(page)).toBeVisible();
  // The card's contact step is where the code is sent from
  await expect(cardFor(page)).toContainText(/contact/i);
  await expect.poll(() => new URL(page.url()).search).toBe('');
  // The remembered tab isn't changed by the link
  expect(
    await page.evaluate(() => sessionStorage.getItem('communicon-tab')),
  ).toBe('live');
});

test('?confirm=1 with a code already sent reopens its code entry instead of a new check', async ({
  page,
}) => {
  const { verifyCalls, otpCalls } = await setup(page, { pendingCode: true });
  await page.goto('/communicon?confirm=1');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('new@harbour.example');
  await expect(tab(page, 'Bot')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await page.waitForTimeout(1000);
  expect(verifyCalls).toHaveLength(0);
  // No new code is sent just by opening it
  expect(otpCalls).toHaveLength(0);
});

test('any other confirm value is taken out of the address bar and starts nothing', async ({
  page,
}) => {
  const { verifyCalls } = await setup(page);
  await page.goto('/communicon?confirm=yes');
  await expect(tab(page, 'Messages')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await page.waitForTimeout(1000);
  expect(verifyCalls).toHaveLength(0);
});
