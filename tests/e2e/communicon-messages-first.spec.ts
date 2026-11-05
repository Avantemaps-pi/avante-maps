/**
 * CommuniCon leads with Messages: the switch reads Messages | Bot, and it opens on Messages unless
 * something needs the Bot tab. The last tab picked is remembered for the session.
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: { id: mockUser.uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};
const BUSINESS = { id: 9001, business_name: 'Harbour Light Coffee' };
const FULL_BUSINESS = {
  ...BUSINESS,
  owner_id: mockUser.uid, category: 'Coffee Shop', business_description: 'Coffee by the harbour, roasted in small batches.',
  city: 'Cape Town', country: 'South Africa', images: [], is_verified: false, is_certified: false, verification_status: null, is_active: true,
  created_at: '2026-10-01T00:00:00Z', lat: -33.92, lng: 18.421, business_types: ['Food'], keywords: [], location: 'Cape Town',
  street_address: '12 Dock Road', state: 'Western Cape', zip_code: '8001', coordinates: null, contact_info: { email: 'a@b.example' }, hours: null, pi_wallet_address: null,
};
const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

async function setup(page: Page, options: { owner?: boolean; signedOut?: boolean; scheme?: string; pendingCode?: boolean } = {}) {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await mockMap(page, NEARBY_BUSINESSES, options.scheme ? { storage: { colorScheme: options.scheme } } : {});
  await page.route('**/rest/v1/businesses*', (route) => {
    const url = new URL(route.request().url());
    if (!options.owner) return route.fulfill({ json: [] });
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200, headers: { 'content-range': '0-0/1' } });
    return route.fulfill({ json: url.searchParams.has('id') || url.searchParams.get('select')?.includes('contact_info') ? [FULL_BUSINESS] : [BUSINESS] });
  });
  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  if (options.pendingCode) {
    await page.addInitScript(() => {
      localStorage.setItem('avante:pending-contact-code', JSON.stringify({ businessId: 9001, email: 'a@b.example', businessName: 'Harbour Light Coffee', sentAt: Date.now() }));
    });
  }
  if (options.signedOut) await page.addInitScript(() => { localStorage.clear(); });
}

// includeHidden: an open dialog hides the page behind it from the accessibility tree
const tab = (page: Page, name: 'Messages' | 'Bot') => page.getByRole('tab', { name, includeHidden: true });
const expectOn = (page: Page, name: 'Messages' | 'Bot') => expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
const botInput = (page: Page) => page.getByPlaceholder('Ask about your business...');
const navLink = (page: Page, name: string) => page.locator('nav').filter({ hasText: 'Discover' }).getByRole('link', { name });

async function openFromMap(page: Page) {
  await page.goto('/');
  await expect(page.locator('input[aria-label="Search businesses"]')).toHaveAttribute('placeholder', 'Search businesses');
  await navLink(page, 'CommuniCon').tap();
  await page.waitForURL('**/communicon');
}

// ---- Order

test('the switch reads Messages, then Bot, with 44px tabs', async ({ page }) => {
  await setup(page);
  await page.goto('/communicon');
  await expect(page.getByRole('tab')).toHaveText(['Messages', 'Bot']);
  const messages = (await tab(page, 'Messages').boundingBox())!;
  const bot = (await tab(page, 'Bot').boundingBox())!;
  expect(messages.x).toBeLessThan(bot.x);
  expect(Math.round(messages.height)).toBe(44);
  expect(Math.round(bot.height)).toBe(44);
});

test('arrow keys move between them in that order, and focus follows', async ({ page }) => {
  await setup(page);
  await page.goto('/communicon');
  await expectOn(page, 'Messages');
  await tab(page, 'Messages').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Bot')).toBeFocused();
  await expectOn(page, 'Bot');
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Messages')).toBeFocused();
  await expectOn(page, 'Messages');
  // Wraps round from the ends
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Bot')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Messages')).toBeFocused();
});

// ---- What opens

test('from the bottom nav: Messages, with the new customer copy, and Find a business goes to the map', async ({ page }) => {
  await setup(page);
  await openFromMap(page);
  await expectOn(page, 'Messages');
  await expect(page.getByText('No messages yet', { exact: true })).toBeVisible();
  await expect(page.getByText('Message a business from its page or the map, and your chats will show here.')).toBeVisible();
  await expect(page.getByText('No conversations yet')).toHaveCount(0);
  await page.getByRole('button', { name: 'Find a business' }).tap();
  await page.waitForURL((url) => url.pathname === '/');
});

test('from the map\'s quick actions: Messages', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fab_first_visit', '2020-01-01T00:00:00.000Z'));
  await setup(page);
  await page.goto('/');
  await page.locator('[data-add-business-fab]').tap();
  await page.getByRole('button', { name: 'CommuniCon' }).tap();
  await page.waitForURL('**/communicon');
  await expectOn(page, 'Messages');
});

test('Request on Your businesses opens Bot and starts the check, whatever tab was remembered', async ({ page }) => {
  await setup(page, { owner: true });
  await page.addInitScript(() => sessionStorage.setItem('communicon-tab', 'live'));
  await page.goto('/registered-business');
  await page.getByRole('button', { name: 'Request' }).first().tap();
  await page.waitForURL('**/communicon');
  await expectOn(page, 'Bot');
  await expect(botInput(page)).toBeVisible();
});

test('the confirm link opens Bot, with the code entry', async ({ page }) => {
  await setup(page, { owner: true });
  await page.addInitScript(() => sessionStorage.setItem('communicon-tab', 'live'));
  // Held, so the code entry stays open rather than confirming straight away
  await page.route('**/functions/v1/contact-otp', () => {});
  await page.goto('/communicon?confirm_code=482913&business=9001');
  await expectOn(page, 'Bot');
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a broken confirm link still opens Bot', async ({ page }) => {
  await setup(page);
  await page.goto('/communicon?confirm_code=12ab&business=9001');
  await expectOn(page, 'Bot');
});

test('the pending-code banner, from another page, opens Bot with the code entry', async ({ page }) => {
  await setup(page, { pendingCode: true, owner: true });
  await page.goto('/wallet');
  await expect(balanceReady(page)).toBeVisible();
  await page.getByRole('button', { name: 'Enter code' }).tap();
  await page.waitForURL('**/communicon');
  await expectOn(page, 'Bot');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('the banner, while already on Messages, switches to Bot', async ({ page }) => {
  await setup(page);
  await page.goto('/communicon');
  await expectOn(page, 'Messages');
  // A code sent after arriving: the banner appears on this page
  await page.evaluate(() => {
    localStorage.setItem('avante:pending-contact-code', JSON.stringify({ businessId: 9001, email: 'a@b.example', businessName: 'Harbour Light Coffee', sentAt: Date.now() }));
    window.dispatchEvent(new Event('avante:pending-contact-code-change'));
  });
  await page.getByRole('button', { name: 'Enter code' }).tap();
  await expectOn(page, 'Bot');
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('a code reopening by itself on arrival opens Bot', async ({ page }) => {
  await setup(page, { pendingCode: true });
  await page.goto('/communicon');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectOn(page, 'Bot');
});

// ---- Remembering

test('switch to Bot, go to the map, come back: still Bot', async ({ page }) => {
  await setup(page);
  await openFromMap(page);
  await tab(page, 'Bot').tap();
  await expectOn(page, 'Bot');
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL((url) => url.pathname === '/');
  await navLink(page, 'CommuniCon').tap();
  await page.waitForURL('**/communicon');
  await expectOn(page, 'Bot');
});

test('switch back to Messages: that is remembered too, also across a reload', async ({ page }) => {
  await setup(page);
  await page.goto('/communicon');
  await tab(page, 'Bot').tap();
  await tab(page, 'Messages').tap();
  await page.reload();
  await expectOn(page, 'Messages');
  await tab(page, 'Bot').tap();
  await page.reload();
  await expectOn(page, 'Bot');
});

test('a new session starts on Messages again', async ({ page, context }) => {
  await setup(page);
  await page.goto('/communicon');
  await tab(page, 'Bot').tap();
  await expectOn(page, 'Bot');
  // sessionStorage belongs to the tab
  const fresh = await context.newPage();
  await setup(fresh);
  await fresh.goto('/communicon');
  await expectOn(fresh, 'Messages');
});

test('being sent to Bot is not remembered as a pick', async ({ page }) => {
  await setup(page);
  await page.goto('/communicon?confirm_code=12ab&business=9001');
  await expectOn(page, 'Bot');
  expect(await page.evaluate(() => sessionStorage.getItem('communicon-tab'))).toBeNull();
});

test('storage that throws: it still opens on Messages, and the tabs still work', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === 'communicon-tab') throw new Error('denied');
      return original.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'communicon-tab') throw new Error('denied');
      return originalSet.call(this, key, value);
    };
  });
  await page.goto('/communicon');
  await expectOn(page, 'Messages');
  await tab(page, 'Bot').tap();
  await expectOn(page, 'Bot');
});

// ---- Empty inbox

test('a business owner with no conversations: the copy names the selected business, with no action', async ({ page }) => {
  await setup(page, { owner: true });
  await page.goto('/communicon');
  await expectOn(page, 'Messages');
  await page.getByRole('combobox', { name: 'Inbox' }).tap();
  await page.getByRole('option', { name: 'Harbour Light Coffee' }).tap();
  await expect(page.getByText('No messages yet', { exact: true })).toBeVisible();
  await expect(page.getByText('When a customer messages Harbour Light Coffee, it shows here.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find a business' })).toHaveCount(0);
});

test('signed out: unchanged', async ({ page }) => {
  await setup(page, { signedOut: true });
  await page.goto('/communicon');
  await expectOn(page, 'Messages');
  await expect(page.getByText('Sign in to use messages.')).toBeVisible();
});

test('signed in, on a direct load: "Sign in to use messages." never shows', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __sawSignIn: boolean };
    w.__sawSignIn = false;
    const check = () => {
      if (document.body?.innerText?.includes('Sign in to use messages.')) w.__sawSignIn = true;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await page.goto('/communicon');
  await expect(page.getByText('No messages yet', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sawSignIn: boolean }).__sawSignIn)).toBe(false);
});

const balanceReady = (page: Page) => page.getByRole('region', { name: 'Avante Maps balance' }).getByText('Avante Maps balance', { exact: true });
