/**
 * Picking a paid plan on Pricing opens a sheet offering the Avante Maps balance and the Pi Wallet.
 * The balance is only spent through pay-from-balance, and the Pi Wallet path is the existing flow.
 *
 * 375x812 with the sandbox session, a fake Supabase session, mocked pay-from-balance and balance RPC,
 * and a stubbed Pi SDK that records createPayment.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
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

// $5 at $0.0767 is 65.19 π, $48 is 625.81 π
const PRICE_USD = 0.0767;
type PayResponse = { status: number; json: Record<string, unknown> };
const PAID: PayResponse = { status: 200, json: { success: true, balance: 34.81, amountPi: 65.19, tier: 'small-business', frequency: 'monthly' } };

async function setup(page: Page, options: { balance?: number | 'never' | 'fails'; pay?: PayResponse; holdPay?: boolean } = {}) {
  const payCalls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const balances: unknown[] = [];
  let releasePay = () => {};
  const payHeld = new Promise<void>((resolve) => (releasePay = resolve));

  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await mockMap(page, NEARBY_BUSINESSES);
  await page.route('**/rest/v1/pi_price*', (route) => route.fulfill({ json: { price_usd: PRICE_USD, updated_at: '2026-11-04T00:00:00Z' } }));
  await page.route('**/rest/v1/rpc/get_wallet_balance*', async (route) => {
    balances.push(options.balance);
    if (options.balance === 'never') return; // Stays loading
    if (options.balance === 'fails') return route.fulfill({ status: 500, json: { message: 'boom' } });
    return route.fulfill({ json: options.balance ?? 100 });
  });
  await page.route('**/functions/v1/pay-from-balance', async (route) => {
    payCalls.push({ body: route.request().postDataJSON() as Record<string, unknown>, headers: route.request().headers() });
    if (options.holdPay) await payHeld;
    const response = options.pay ?? PAID;
    return route.fulfill({ status: response.status, json: response.json });
  });
  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  await page.addInitScript(() => {
    const w = window as unknown as { Pi: object; __piInitialized: boolean; __piPayments: unknown[] };
    w.__piPayments = [];
    w.__piInitialized = true;
    w.Pi = {
      init: () => undefined,
      authenticate: () => Promise.resolve({ accessToken: 'pi', user: { uid: 'pi-uid', username: 'SandboxUser' } }),
      createPayment: (data: unknown) => {
        w.__piPayments.push(data);
      },
    };
  });
  return { payCalls, balances, releasePay };
}

const piPayments = (page: Page) => page.evaluate(() => (window as unknown as { __piPayments: { metadata: Record<string, string> }[] }).__piPayments);
const planButton = (page: Page) => page.locator('[data-plan-button="small-business"]');
const sheet = (page: Page) => page.getByRole('dialog');
const balanceRadio = (page: Page) => sheet(page).getByRole('radio', { name: /Avante Maps balance/ });
const piRadio = (page: Page) => sheet(page).getByRole('radio', { name: /Pi Wallet/ });
const balanceRow = (page: Page) => sheet(page).locator('label', { hasText: 'Avante Maps balance' });
const piRow = (page: Page) => sheet(page).locator('label', { hasText: 'Pi Wallet' });

// The page is server-rendered: the live price only shows once it has hydrated, and a tap before
// that does nothing
async function openPricing(page: Page) {
  await page.goto('/pricing');
  await expect(page.getByText('π 65.19')).toBeVisible();
}

async function openSheet(page: Page) {
  await openPricing(page);
  await planButton(page).tap();
  await expect(sheet(page)).toBeVisible();
}

test('enough balance: the balance row is selected, and paying spends it without a Pi payment', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 100 });
  await openSheet(page);

  await expect(sheet(page).getByRole('heading', { name: 'Small Business plan' })).toBeVisible();
  await expect(sheet(page).getByText('$5.00 a month · 65.19 π today')).toBeVisible();
  await expect(sheet(page).getByRole('group', { name: 'Pay with' })).toBeVisible();
  await expect(balanceRadio(page)).toBeChecked();
  await expect(sheet(page).getByText('100.00 π available · 34.81 π left after')).toBeVisible();
  await expect(sheet(page).getByText('Approve the payment in the Pi Wallet app')).toBeVisible();
  await expect(sheet(page).getByText('Covers 1 month from today.')).toBeVisible();
  await expect(sheet(page).getByRole('link', { name: 'Top up your balance' })).toHaveCount(0);

  await sheet(page).getByRole('button', { name: 'Pay 65.19 π from balance' }).tap();
  await expect(page.getByText('Small Business plan active')).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);

  expect(payCalls).toHaveLength(1);
  const { body, headers } = payCalls[0]!;
  expect(body).toMatchObject({ kind: 'subscription', subscriptionTier: 'small-business', frequency: 'monthly' });
  expect(body['requestId']).toMatch(/^[0-9a-f-]{36}$/);
  // The server works out the amount, and the key isn't sent as a bearer token
  expect(body).not.toHaveProperty('amount');
  expect(body).not.toHaveProperty('amountPi');
  expect(headers['apikey']).toMatch(/^sb_publishable_/);
  expect(headers['authorization']).toBe(`Bearer ${session.access_token}`);
  expect(await piPayments(page)).toEqual([]);
});

test('yearly: annual price and wording, and the function is sent "annual"', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 1000, pay: { status: 200, json: { ...PAID.json, frequency: 'annual' } } });
  await openPricing(page);
  await page.getByRole('button', { name: /Yearly/ }).tap();
  await expect(page.getByText('π 625.81')).toBeVisible();
  await planButton(page).tap();
  await expect(sheet(page).getByText('$48.00 a year · 625.81 π today')).toBeVisible();
  await expect(sheet(page).getByText('Covers 1 year from today.')).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Pay 625.81 π from balance' }).tap();
  await expect(page.getByText('Small Business plan active')).toBeVisible();
  expect(payCalls[0]!.body['frequency']).toBe('annual');
});

test('not enough balance: row disabled, Top up goes to /wallet, Pi Wallet starts the existing flow', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 3.2 });
  await openSheet(page);

  await expect(balanceRadio(page)).toBeDisabled();
  await expect(balanceRadio(page)).not.toBeChecked();
  await expect(sheet(page).getByText('Not enough: 3.20 π available')).toBeVisible();
  await expect(piRadio(page)).toBeChecked();
  await expect(balanceRow(page)).toHaveCSS('opacity', '0.6');

  const topUp = sheet(page).getByRole('link', { name: 'Top up your balance' });
  await expect(topUp).toHaveAttribute('href', '/wallet');
  expect(Math.round((await topUp.boundingBox())!.height)).toBeGreaterThanOrEqual(44);

  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect(sheet(page)).toHaveCount(0);
  await expect.poll(async () => (await piPayments(page)).length).toBe(1);
  expect((await piPayments(page))[0]!.metadata).toMatchObject({ subscriptionTier: 'small-business', frequency: 'monthly' });
  expect(payCalls).toEqual([]);
});

test('Top up your balance opens the wallet', async ({ page }) => {
  await setup(page, { balance: 3.2 });
  await openSheet(page);
  await sheet(page).getByRole('link', { name: 'Top up your balance' }).tap();
  await page.waitForURL('**/wallet');
});

test('enough balance, choosing Pi Wallet: the button changes and the Pi flow starts', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 100 });
  await openSheet(page);
  await piRadio(page).check();
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect.poll(async () => (await piPayments(page)).length).toBe(1);
  expect(payCalls).toEqual([]);
});

test('a 409: toast, the balance refreshed, Pi Wallet selected', async ({ page }) => {
  const { balances } = await setup(page, { balance: 100, pay: { status: 409, json: { success: false, error_code: 'insufficient_balance', balance: 3.2 } } });
  await openSheet(page);
  const before = balances.length;
  await sheet(page).getByRole('button', { name: 'Pay 65.19 π from balance' }).tap();
  await expect(page.getByText('Not enough balance')).toBeVisible();
  await expect(piRadio(page)).toBeChecked();
  await expect(sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' })).toBeVisible();
  await expect.poll(() => balances.length).toBeGreaterThan(before);
  expect(await piPayments(page)).toEqual([]);
});

test('another error: the message in a toast, nothing changes, and a retry reuses the requestId', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 100, pay: { status: 500, json: { success: false, message: 'Payment failed. Your balance has not changed.' } } });
  await openSheet(page);
  const pay = sheet(page).getByRole('button', { name: 'Pay 65.19 π from balance' });
  await pay.tap();
  await expect(page.getByText('Payment failed. Your balance has not changed.')).toBeVisible();
  await expect(balanceRadio(page)).toBeChecked();
  await pay.tap();
  await expect.poll(() => payCalls.length).toBe(2);
  expect(payCalls[1]!.body['requestId']).toBe(payCalls[0]!.body['requestId']);

  // Closed and reopened it's still the same attempt: the first response may have been lost
  await sheet(page).getByRole('button', { name: 'Close' }).tap();
  await expect(sheet(page)).toHaveCount(0);
  await planButton(page).tap();
  await pay.tap();
  await expect.poll(() => payCalls.length).toBe(3);
  expect(payCalls[2]!.body['requestId']).toBe(payCalls[0]!.body['requestId']);
});

test('after a success the next purchase is a new request', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 100 });
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Pay 65.19 π from balance' }).tap();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByText('Small Business plan active')).toBeVisible();
  await planButton(page).tap();
  await sheet(page).getByRole('button', { name: 'Pay 65.19 π from balance' }).tap();
  await expect.poll(() => payCalls.length).toBe(2);
  expect(payCalls[1]!.body['requestId']).not.toBe(payCalls[0]!.body['requestId']);
});

test('while paying: a spinner, and the sheet cannot be closed', async ({ page }) => {
  const { releasePay } = await setup(page, { balance: 100, holdPay: true });
  await openSheet(page);
  const pay = sheet(page).getByRole('button', { name: 'Pay 65.19 π from balance' });
  await pay.tap();
  await expect(pay).toBeDisabled();
  await expect(pay.locator('svg.animate-spin')).toBeVisible();
  await expect(sheet(page).getByRole('button', { name: 'Close' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.touchscreen.tap(187, 40);
  await expect(sheet(page)).toBeVisible();
  releasePay();
  await expect(page.getByText('Small Business plan active')).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
});

test('while the balance loads: a skeleton, and Pi Wallet selected', async ({ page }) => {
  await setup(page, { balance: 'never' });
  await openSheet(page);
  await expect(sheet(page).getByTestId('balance-skeleton')).toBeVisible();
  await expect(balanceRadio(page)).toBeDisabled();
  await expect(piRadio(page)).toBeChecked();
  await expect(sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' })).toBeVisible();
});

test('a balance that fails to load is not shown as zero', async ({ page }) => {
  await setup(page, { balance: 'fails' });
  await openSheet(page);
  await expect(sheet(page).getByText('Balance unavailable right now')).toBeVisible({ timeout: 20_000 });
  await expect(sheet(page).getByText(/Not enough/)).toHaveCount(0);
  await expect(sheet(page).getByRole('link', { name: 'Top up your balance' })).toHaveCount(0);
  await expect(piRadio(page)).toBeChecked();
});

for (const [name, close] of [
  ['the Close button', (page: Page) => sheet(page).getByRole('button', { name: 'Close' }).tap()],
  ['the scrim', (page: Page) => page.touchscreen.tap(187, 40)],
  ['Escape', (page: Page) => page.keyboard.press('Escape')],
] as const) {
  test(`${name} closes the sheet, and focus returns to the plan button`, async ({ page }) => {
    const { payCalls } = await setup(page, { balance: 100 });
    await openSheet(page);
    await close(page);
    await expect(sheet(page)).toHaveCount(0);
    await expect(planButton(page)).toBeFocused();
    expect(payCalls).toEqual([]);
    expect(await piPayments(page)).toEqual([]);
  });
}

test('logged out: asked to log in, with no sheet', async ({ page }) => {
  const { payCalls } = await setup(page, { balance: 100 });
  await page.addInitScript(() => localStorage.clear());
  await openPricing(page);
  await planButton(page).tap();
  await expect(page.getByText('Please log in to upgrade your subscription')).toBeVisible();
  await expect(sheet(page).getByText('Pay with')).toHaveCount(0);
  expect(payCalls).toEqual([]);
});

test('sizes and selected row: 44px Close, 64px rows, 2px primary border on the selected row', async ({ page }) => {
  await setup(page, { balance: 100 });
  await openSheet(page);
  const close = (await sheet(page).getByRole('button', { name: 'Close' }).boundingBox())!;
  expect([Math.round(close.width), Math.round(close.height)]).toEqual([44, 44]);
  await expect(sheet(page).getByRole('heading', { name: 'Small Business plan' })).toHaveCSS('font-size', '18px');
  const selected = balanceRow(page);
  const other = piRow(page);
  expect((await selected.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  expect((await other.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  await expect(selected).toHaveCSS('border-width', '2px');
  await expect(other).toHaveCSS('border-width', '1px');
  await expect(selected).toHaveCSS('border-radius', '12px');
  const noSideways = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(noSideways).toBe(true);
});
