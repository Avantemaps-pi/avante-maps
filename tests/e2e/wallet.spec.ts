/**
 * The Wallet page: what the balance is, the user's wallets, and activity from payments and from
 * spends in wallet_ledger.
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase. The ledger mock
 * applies the query's filter, so a client that asked for deposits too would get them.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockMap, NEARBY_BUSINESSES, mockUser, STORAGE_KEY } from './helpers/mapMocks';

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

const PI_WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSX7KQ';
const PAYOUT_WALLET = 'GD3WHARBOURLIGHTPAYOUTWALLETADDRESS00000000000000000002O6O';

const COMPLETED = { approved: true, verified: true, completed: true, cancelled: false };
const payment = (id: number, created_at: string, amount: number, metadata: object | null, status: object = COMPLETED, extra: object = {}) => ({
  id, amount, approved_amount_pi: null, memo: null, status, metadata, created_at, ...extra,
});
const TOP_UP = payment(1, '2026-11-01T09:00:00Z', 40, { kind: 'wallet_topup' });
const PI_PLAN = payment(2, '2026-11-02T09:00:00Z', 65.19, { subscriptionTier: 'small-business', frequency: 'monthly' }, COMPLETED, { approved_amount_pi: 65.19 });
const BALANCE_SPEND = { id: 11, amount_pi: -16.4, transaction_type: 'subscription', reference_id: 'plan:small-business:monthly:11111111-1111-4111-8111-111111111111', created_at: '2026-11-03T09:00:00Z' };
const TOP_UP_CREDIT = { id: 10, amount_pi: 40, transaction_type: 'deposit', reference_id: null, created_at: '2026-11-01T09:00:01Z' };

const BUSINESS = { id: 56, business_name: 'Harbour Light Coffee', pi_wallet_address: PAYOUT_WALLET, is_active: true };
const NO_PAYOUT = { id: 57, business_name: 'Dock Road Deli', pi_wallet_address: null, is_active: true };

interface Options {
  scheme?: 'light' | 'dark';
  walletAddress?: string | null;
  businesses?: object[] | 'fails';
  payments?: object[];
  ledger?: object[];
  paymentsFail?: boolean;
  priceFails?: boolean;
  balance?: number | 'fails';
  signedOut?: boolean;
  clipboardFails?: boolean;
}

async function setup(page: Page, options: Options = {}) {
  const requests = { payments: [] as string[], ledger: [] as string[], businesses: [] as string[] };
  const data = { businesses: options.businesses };

  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await mockMap(page, NEARBY_BUSINESSES, options.scheme ? { storage: { colorScheme: options.scheme } } : {});
  await page.route('**/rest/v1/pi_price*', (route) =>
    options.priceFails ? route.fulfill({ status: 500, json: { message: 'boom' } }) : route.fulfill({ json: { price_usd: 0.5, updated_at: '2026-11-04T00:00:00Z' } }),
  );
  await page.route('**/rest/v1/rpc/get_wallet_balance*', (route) =>
    options.balance === 'fails' ? route.fulfill({ status: 500, json: { message: 'boom' } }) : route.fulfill({ json: options.balance ?? 23.5 }),
  );
  await page.route('**/rest/v1/payments*', (route) => {
    requests.payments.push(route.request().url());
    return options.paymentsFail ? route.fulfill({ status: 500, json: { message: 'boom' } }) : route.fulfill({ json: options.payments ?? [] });
  });
  await page.route('**/rest/v1/wallet_ledger*', (route) => {
    const url = new URL(route.request().url());
    requests.ledger.push(url.href);
    const rows = (options.ledger ?? []) as { amount_pi: number; transaction_type: string }[];
    const filtered = url.searchParams.get('or') === '(amount_pi.lt.0,transaction_type.neq.deposit)';
    return route.fulfill({ json: filtered ? rows.filter((row) => row.amount_pi < 0 || row.transaction_type !== 'deposit') : rows });
  });
  await page.route('**/rest/v1/businesses*', (route) => {
    requests.businesses.push(route.request().url());
    return data.businesses === 'fails' ? route.fulfill({ status: 500, json: { message: 'boom' } }) : route.fulfill({ json: data.businesses ?? [] });
  });

  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  if (options.walletAddress !== undefined) {
    await page.addInitScript(
      ([key, user]) => localStorage.setItem(key as string, JSON.stringify(user)),
      [STORAGE_KEY, { ...mockUser, walletAddress: options.walletAddress ?? '', lastAuthenticated: Date.now() }] as const,
    );
  }
  if (options.signedOut) await page.addInitScript(() => localStorage.clear());
  await page.addInitScript((fails) => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (fails) return Promise.reject(new Error('denied'));
          w.__copied.push(text);
          return Promise.resolve();
        },
      },
    });
  }, options.clipboardFails ?? false);
  return { requests, data };
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
const balanceCard = (page: Page) => page.getByRole('region', { name: 'Avante Maps balance' });
const wallets = (page: Page) => page.getByRole('region', { name: 'Your wallets' });
const activity = (page: Page) => page.getByRole('region', { name: 'Recent activity' });
const activityRows = (page: Page) => activity(page).getByRole('listitem');

// ---- Balance card

test('testnet host: "Avante Maps balance", what it is for, the chip, and no USD line', async ({ page }) => {
  await setup(page);
  await page.goto('/wallet');
  const card = balanceCard(page);
  await expect(card.getByText('Avante Maps balance', { exact: true })).toBeVisible();
  await expect(card.getByText('Testnet Pi')).toBeVisible();
  await expect(card.getByText('23.50')).toBeVisible();
  await expect(card.getByText('Pays for plans in the app.')).toBeVisible();
  await expect(card.getByText('Your Pi Wallet balance stays in the Pi Wallet app.')).toBeVisible();
  await expect(card.getByText('Your Pi Wallet balance stays in the Pi Wallet app.')).toHaveCSS('opacity', '0.95');
  await expect(card.getByText('Pays for plans in the app.')).toHaveCSS('opacity', '0.95');
  await expect(card.getByText(/USD/)).toHaveCount(0);
  await expect(card.getByText(/message/i)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Top up/ })).toBeVisible();
  // Solid, not a gradient
  await expect(card).toHaveCSS('background-image', 'none');
  await expect(card.getByText('Avante Maps balance', { exact: true })).toHaveCSS('text-transform', 'none');
});

// Serves the app from a mainnet hostname, without leaving the machine
async function asMainnet(page: Page) {
  const local = process.env.PREVIEW_URL ?? 'http://localhost:8080';
  await page.route('https://mainnet.avantemaps.com/**', async (route) => {
    try {
      const response = await route.fetch({ url: route.request().url().replace('https://mainnet.avantemaps.com', local) });
      await route.fulfill({ response });
    } catch {
      // The test ended while this request was still being forwarded
    }
  });
}

test('mainnet host: no chip, and the USD line', async ({ page }) => {
  await setup(page, { balance: 10 });
  await asMainnet(page);
  await page.goto('https://mainnet.avantemaps.com/wallet');
  const card = balanceCard(page);
  await expect(card.getByText('≈ $5.00 USD')).toBeVisible();
  await expect(card.getByText('≈ $5.00 USD')).toHaveCSS('opacity', '0.95');
  await expect(card.getByText('Testnet Pi')).toHaveCount(0);
});

test('mainnet with no price: "USD value unavailable", not a made-up rate', async ({ page }) => {
  await setup(page, { balance: 10, priceFails: true });
  await asMainnet(page);
  await page.goto('https://mainnet.avantemaps.com/wallet');
  await expect(balanceCard(page).getByText('USD value unavailable')).toBeVisible();
  await expect(balanceCard(page).getByText(/≈/)).toHaveCount(0);
});

test('a balance that fails to load is not shown as 0.00', async ({ page }) => {
  await setup(page, { balance: 'fails' });
  await page.goto('/wallet');
  await expect(balanceCard(page).getByText("Couldn't load your balance.")).toBeVisible({ timeout: 20_000 });
  await expect(balanceCard(page).getByText('0.00')).toHaveCount(0);
});

// ---- Your wallets

test('a Pi wallet address: shortened, and Copy writes the whole address', async ({ page }) => {
  await setup(page, { walletAddress: PI_WALLET });
  await page.goto('/wallet');
  const shortened = wallets(page).getByText('GABC…X7KQ');
  await expect(shortened).toBeVisible();
  await expect(shortened).toHaveCSS('font-family', /mono/i);
  await expect(wallets(page).getByText(PI_WALLET)).toHaveCount(0);
  const copy = wallets(page).getByRole('button', { name: 'Copy your Pi wallet address' });
  expect(Math.round((await copy.boundingBox())!.height)).toBe(44);
  await copy.tap();
  await expect(page.getByText('Address copied')).toBeVisible();
  expect(await copied(page)).toEqual([PI_WALLET]);
});

test('if the browser refuses the copy, it says so', async ({ page }) => {
  await setup(page, { walletAddress: PI_WALLET, clipboardFails: true });
  await page.goto('/wallet');
  await wallets(page).getByRole('button', { name: 'Copy your Pi wallet address' }).tap();
  await expect(page.getByText("Couldn't copy the address")).toBeVisible();
  await expect(page.getByText('Address copied')).toHaveCount(0);
});

for (const [name, walletAddress] of [
  ['empty', ''],
  ['blank', '   '],
  ['the sandbox placeholder', 'sandbox-mock-wallet'],
] as const) {
  test(`a Pi wallet that is ${name}: "Not shared by Pi", no Copy button`, async ({ page }) => {
    await setup(page, { walletAddress });
    await page.goto('/wallet');
    await expect(wallets(page).getByText('Not shared by Pi')).toBeVisible();
    await expect(wallets(page).getByRole('button', { name: /Copy/ })).toHaveCount(0);
    await expect(wallets(page).getByText('sandbox-mock-wallet')).toHaveCount(0);
  });
}

test('an owner with a payout wallet: shortened, Copy, and Edit opens Update business', async ({ page }) => {
  const { requests } = await setup(page, { businesses: [BUSINESS] });
  await page.goto('/wallet');
  await expect(wallets(page).getByText('Harbour Light Coffee · payout wallet')).toBeVisible();
  await expect(wallets(page).getByText('GD3W…2O6O')).toBeVisible();
  await expect(page.getByText("Customers' payments to your business go to its payout wallet.")).toBeVisible();
  // Read as the session user, not user.uid
  expect(new URL(requests.businesses[0]!).searchParams.get('owner_id')).toBe(`eq.${session.user.id}`);
  expect(new URL(requests.businesses[0]!).searchParams.get('order')).toBe('created_at.desc');

  await wallets(page).getByRole('button', { name: 'Copy the Harbour Light Coffee payout wallet address' }).tap();
  await expect.poll(() => copied(page)).toEqual([PAYOUT_WALLET]);

  const edit = wallets(page).getByRole('link', { name: /^Edit/ });
  await expect(edit).toHaveText('Edit');
  expect(Math.round((await edit.boundingBox())!.height)).toBe(44);
  await expect(edit).toHaveAttribute('aria-label', 'Edit the Harbour Light Coffee payout wallet');
  await expect(edit).toHaveAttribute('href', '/update-registration/56?field=piWalletAddress');
});

test('no payout wallet: "No payout wallet yet" and Add, with no Copy', async ({ page }) => {
  await setup(page, { businesses: [NO_PAYOUT] });
  await page.goto('/wallet');
  await expect(wallets(page).getByText('No payout wallet yet')).toBeVisible();
  await expect(wallets(page).getByRole('button', { name: /Dock Road Deli/ })).toHaveCount(0);
  const add = wallets(page).getByRole('link', { name: /Add/ });
  await expect(add).toHaveText('Add');
  await expect(add).toHaveAttribute('aria-label', 'Add a payout wallet for Dock Road Deli');
  await expect(add).toHaveAttribute('href', '/update-registration/57?field=piWalletAddress');
});

test('an inactive business is labelled, and stays listed', async ({ page }) => {
  await setup(page, { businesses: [{ ...BUSINESS, is_active: false }] });
  await page.goto('/wallet');
  await expect(wallets(page).getByText('Harbour Light Coffee · Inactive · payout wallet')).toBeVisible();
});

test('a customer with no businesses: only the Pi wallet row, and no payout note', async ({ page }) => {
  await setup(page, { businesses: [] });
  await page.goto('/wallet');
  await expect(wallets(page).getByText('Your Pi wallet')).toBeVisible();
  await expect(wallets(page).getByText(/payout wallet/)).toHaveCount(0);
  await expect(page.getByText("Customers' payments to your business")).toHaveCount(0);
});

test('businesses fail to load: the Pi wallet row stays, and Try again recovers', async ({ page }) => {
  const { data } = await setup(page, { businesses: 'fails', walletAddress: PI_WALLET });
  await page.goto('/wallet');
  await expect(wallets(page).getByText("Couldn't load your businesses.")).toBeVisible();
  await expect(wallets(page).getByText('GABC…X7KQ')).toBeVisible();
  data.businesses = [BUSINESS];
  await wallets(page).getByRole('button', { name: 'Try again' }).tap();
  await expect(wallets(page).getByText('Harbour Light Coffee · payout wallet')).toBeVisible();
  await expect(wallets(page).getByText("Couldn't load your businesses.")).toHaveCount(0);
});

test('signed out: no wallets section, and nothing is read', async ({ page }) => {
  const { requests } = await setup(page, { signedOut: true });
  await page.goto('/wallet');
  await expect(page.getByText('Sign in to view your payment history.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your wallets' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toHaveCount(0);
  expect(requests).toEqual({ payments: [], ledger: [], businesses: [] });
});

// ---- Recent activity

test('a top up, a Pi Wallet plan and a balance spend: labelled, newest first, no credit row', async ({ page }) => {
  const { requests } = await setup(page, { payments: [PI_PLAN, TOP_UP], ledger: [BALANCE_SPEND, TOP_UP_CREDIT] });
  await page.goto('/wallet');
  const rows = activityRows(page);
  await expect(rows).toHaveCount(3);

  await expect(rows.nth(0)).toContainText('Small Business plan');
  await expect(rows.nth(0)).toContainText('Plan · Paid from balance · 3 Nov');
  await expect(rows.nth(0)).toContainText('− 16.40 π');

  await expect(rows.nth(1)).toContainText('Small Business plan');
  await expect(rows.nth(1)).toContainText('Plan · 2 Nov · Completed');
  await expect(rows.nth(1)).toContainText('− 65.19 π');

  await expect(rows.nth(2)).toContainText('Top up');
  await expect(rows.nth(2)).toContainText('1 Nov · Completed');
  await expect(rows.nth(2)).toContainText('+ 40.00 π');

  await expect(page.getByText('Your 10 most recent payments.')).toBeVisible();

  // Both scoped to this user. An admin's policy on the ledger would otherwise return everyone's
  const ledgerUrl = new URL(requests.ledger[0]!);
  expect(ledgerUrl.searchParams.get('user_id')).toBe(`eq.${session.user.id}`);
  expect(ledgerUrl.searchParams.get('or')).toBe('(amount_pi.lt.0,transaction_type.neq.deposit)');
  expect(new URL(requests.payments[0]!).searchParams.get('user_id')).toBe(`eq.${session.user.id}`);
});

test('colours and sizes: + in primary, − in the foreground colour, 60px rows', async ({ page }) => {
  await setup(page, { payments: [TOP_UP], ledger: [BALANCE_SPEND] });
  await page.goto('/wallet');
  const rows = activityRows(page);
  await expect(rows).toHaveCount(2);
  const heading = await activity(page).getByRole('heading', { name: 'Recent activity' }).evaluate((el) => getComputedStyle(el).color);
  await expect(rows.nth(0).getByText('− 16.40 π')).toHaveCSS('color', heading);
  await expect(rows.nth(1).getByText('+ 40.00 π')).not.toHaveCSS('color', heading);
  await expect(rows.nth(0).getByText('− 16.40 π')).toHaveCSS('font-variant-numeric', 'tabular-nums');
  for (const row of await rows.all()) expect(Math.round((await row.boundingBox())!.height)).toBeGreaterThanOrEqual(60);
});

test('other kinds: Message fee, the memo, Payment, Payment from balance', async ({ page }) => {
  await setup(page, {
    payments: [
      payment(5, '2026-10-29T09:00:00Z', 0.5, { kind: 'message_fee' }),
      payment(6, '2026-10-28T09:00:00Z', 1, {}, COMPLETED, { memo: 'Something else' }),
      payment(7, '2026-10-27T09:00:00Z', 2, null),
    ],
    ledger: [{ id: 12, amount_pi: -0.1, transaction_type: 'message_fee', reference_id: 'other:1', created_at: '2026-10-30T09:00:00Z' }],
  });
  await page.goto('/wallet');
  const rows = activityRows(page);
  await expect(rows.nth(0)).toContainText('Payment from balance');
  await expect(rows.nth(0)).toContainText('− 0.10 π');
  await expect(rows.nth(1)).toContainText('Message fee');
  await expect(rows.nth(2)).toContainText('Something else');
  await expect(rows.nth(2)).toContainText('Payment · 28 Oct · Completed');
  await expect(rows.nth(3).getByText('Payment', { exact: true })).toBeVisible();
});

test('a plan shows the amount approved with Pi, not the one the client sent', async ({ page }) => {
  await setup(page, { payments: [payment(2, '2026-11-02T09:00:00Z', 5, { subscriptionTier: 'organization' }, COMPLETED, { approved_amount_pi: 130.38 })] });
  await page.goto('/wallet');
  await expect(activityRows(page).first()).toContainText('Organization plan');
  await expect(activityRows(page).first()).toContainText('− 130.38 π');
});

test('10 at most, merged across both sources', async ({ page }) => {
  const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T09:00:00Z`;
  await setup(page, {
    payments: Array.from({ length: 10 }, (_, i) => payment(100 + i, day(20 - i * 2), 1, { kind: 'wallet_topup' })),
    ledger: Array.from({ length: 10 }, (_, i) => ({ id: 200 + i, amount_pi: -1, transaction_type: 'subscription', reference_id: 'plan:organization:monthly:r', created_at: day(19 - i * 2 + 2) })),
  });
  await page.goto('/wallet');
  await expect(activityRows(page)).toHaveCount(10);
  await expect(activityRows(page).first()).toContainText('21 Oct');
});

test('Pending, for a payment that is approved or only just created', async ({ page }) => {
  await setup(page, {
    payments: [
      payment(1, '2026-11-02T09:00:00Z', 1, { kind: 'wallet_topup' }, { approved: true, verified: false, completed: false, cancelled: false }),
      payment(2, '2026-11-01T09:00:00Z', 1, { kind: 'wallet_topup' }, { approved: false, verified: false, completed: false, cancelled: false }),
    ],
  });
  await page.goto('/wallet');
  await expect(activityRows(page).nth(0)).toContainText('2 Nov · Pending');
  await expect(activityRows(page).nth(1)).toContainText('1 Nov · Pending');
});

test('a refund and a balance adjustment: labelled, + in primary, date only, sorted with the rest', async ({ page }) => {
  await setup(page, {
    payments: [TOP_UP],
    ledger: [
      { id: 20, amount_pi: 5, transaction_type: 'refund', reference_id: null, created_at: '2026-11-04T09:00:00Z' },
      { id: 21, amount_pi: 2.5, transaction_type: 'admin_adjustment', reference_id: null, created_at: '2026-10-31T09:00:00Z' },
      BALANCE_SPEND,
    ],
  });
  await page.goto('/wallet');
  const rows = activityRows(page);
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText('Refund');
  await expect(rows.nth(0)).toContainText('+ 5.00 π');
  await expect(rows.nth(0).getByText('4 Nov', { exact: true })).toBeVisible();
  await expect(rows.nth(1)).toContainText('− 16.40 π');
  await expect(rows.nth(2)).toContainText('Top up');
  await expect(rows.nth(3)).toContainText('Balance adjustment');
  await expect(rows.nth(3)).toContainText('+ 2.50 π');
  await expect(rows.nth(3).getByText('31 Oct', { exact: true })).toBeVisible();
  // The same colour as a top up's +
  const plus = await rows.nth(2).getByText('+ 40.00 π').evaluate((el) => getComputedStyle(el).color);
  await expect(rows.nth(0).getByText('+ 5.00 π')).toHaveCSS('color', plus);
  await expect(rows.nth(3).getByText('+ 2.50 π')).toHaveCSS('color', plus);
});

test('a deposit in the ledger does not add a second row to its top up', async ({ page }) => {
  await setup(page, { payments: [TOP_UP], ledger: [TOP_UP_CREDIT] });
  await page.goto('/wallet');
  await expect(activityRows(page)).toHaveCount(1);
  await expect(activityRows(page).first()).toContainText('Top up');
  await expect(page.getByText('Balance adjustment')).toHaveCount(0);
});

const CANCELLED = { approved: false, verified: false, completed: false, cancelled: true };

test('amount_mismatch reads "Cancelled · price changed", and its amount has no sign and is muted', async ({ page }) => {
  await setup(page, { payments: [payment(3, '2026-11-02T09:00:00Z', 5, { subscriptionTier: 'small-business' }, { ...CANCELLED, error: 'amount_mismatch' })] });
  await page.goto('/wallet');
  const row = activityRows(page).first();
  await expect(row).toContainText('Plan · 2 Nov · Cancelled · price changed');
  await expect(row.getByRole('link', { name: 'Contact support' })).toHaveCount(0);
  const amount = row.getByText('5.00 π', { exact: true });
  await expect(amount).toBeVisible();
  await expect(row).not.toContainText('−');
  const muted = await row.getByText('Plan · 2 Nov').evaluate((el) => getComputedStyle(el).color);
  await expect(amount).toHaveCSS('color', muted);
});

test('any cancelled payment has no sign, including a top up', async ({ page }) => {
  await setup(page, {
    payments: [
      payment(1, '2026-11-02T09:00:00Z', 7, { kind: 'wallet_topup' }, CANCELLED),
      payment(2, '2026-11-01T09:00:00Z', 8, { subscriptionTier: 'organization' }, { ...CANCELLED, error: 'Pi Network API error' }),
    ],
  });
  await page.goto('/wallet');
  await expect(activityRows(page).nth(0).getByText('7.00 π', { exact: true })).toBeVisible();
  await expect(activityRows(page).nth(1).getByText('8.00 π', { exact: true })).toBeVisible();
});

test('a failed payment that was not cancelled keeps its sign, in red', async ({ page }) => {
  await setup(page, {
    payments: [
      payment(1, '2026-11-02T09:00:00Z', 7, { subscriptionTier: 'organization' }, { approved: true, completed: false, cancelled: false, voided: true }),
      payment(2, '2026-11-01T09:00:00Z', 8, { subscriptionTier: 'organization' }, { approved: true, completed: false, cancelled: false, error: 'boom' }),
    ],
  });
  await page.goto('/wallet');
  for (const [index, text, status] of [[0, '− 7.00 π', 'Voided'], [1, '− 8.00 π', 'Error']] as const) {
    const row = activityRows(page).nth(index);
    const red = await row.getByText(status, { exact: true }).evaluate((el) => getComputedStyle(el).color);
    await expect(row.getByText(text)).toHaveCSS('color', red);
  }
});

test('plan_not_activated reads "Paid · plan not activated", with the Contact support line', async ({ page }) => {
  await setup(page, {
    payments: [payment(4, '2026-11-02T09:00:00Z', 65.19, { subscriptionTier: 'small-business' }, { ...COMPLETED, error: 'plan_not_activated' }, { approved_amount_pi: 65.19 })],
  });
  await page.goto('/wallet');
  const row = activityRows(page).first();
  await expect(row).toContainText('Plan · 2 Nov · Paid · plan not activated');
  await expect(row).not.toContainText('Completed');
  await expect(row).toContainText("Contact support and we'll sort it out.");
  // The Pi moved, so the status is red and the amount isn't
  const status = await row.getByText('Paid · plan not activated').evaluate((el) => getComputedStyle(el).color);
  await expect(row.getByText('− 65.19 π')).not.toHaveCSS('color', status);
  const link = row.getByRole('link', { name: 'Contact support' });
  expect(Math.round((await link.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  await link.tap();
  await page.waitForURL('**/contact');
});

test('empty: "No activity yet" in a bordered card, not dashed, and no footnote', async ({ page }) => {
  await setup(page, { ledger: [TOP_UP_CREDIT] }); // A credit alone isn't activity
  await page.goto('/wallet');
  const title = activity(page).getByText('No activity yet');
  await expect(title).toBeVisible();
  await expect(activity(page).getByText('Top ups and plan payments will show here.')).toBeVisible();
  await expect(title.locator('..')).toHaveCSS('border-top-style', 'solid');
  await expect(page.getByText('Your 10 most recent payments.')).toHaveCount(0);
});

test('Refresh refetches both sources and picks up what changed, spinning meanwhile', async ({ page }) => {
  const options: Options = { payments: [TOP_UP] };
  const { requests } = await setup(page, options);
  await page.goto('/wallet');
  await expect(activityRows(page)).toHaveCount(1);
  const before = { payments: requests.payments.length, ledger: requests.ledger.length };

  options.ledger = [BALANCE_SPEND];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/rest/v1/wallet_ledger*', async (route) => {
    await held;
    await route.fallback();
  });
  const refresh = activity(page).getByRole('button', { name: 'Refresh activity' });
  expect(Math.round((await refresh.boundingBox())!.width)).toBe(44);
  await refresh.tap();
  await expect(refresh.locator('svg.animate-spin')).toBeVisible();
  release();
  await expect(activityRows(page)).toHaveCount(2);
  await expect(refresh.locator('svg.animate-spin')).toHaveCount(0);
  expect(requests.payments.length).toBeGreaterThan(before.payments);
  expect(requests.ledger.length).toBeGreaterThan(before.ledger);
});

test('a source failing shows the error, not a partial list', async ({ page }) => {
  await setup(page, { paymentsFail: true, ledger: [BALANCE_SPEND] });
  await page.goto('/wallet');
  await expect(activity(page).getByRole('alert')).toContainText('Failed to load activity');
  await expect(activityRows(page)).toHaveCount(0);
  await expect(activity(page).getByRole('button', { name: 'Refresh activity' })).toBeVisible();
});

// ---- Edit and Add open the Pi wallet address field

const HOURS = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => [day, { open: '08:00', close: '18:00', closed: false }]),
);
const fullRow = (row: { id: number; business_name: string; pi_wallet_address: string | null; is_active: boolean }) => ({
  ...row,
  owner_id: mockUser.uid,
  category: 'Coffee Shop',
  business_description: 'Coffee by the harbour, roasted in small batches every week.',
  city: 'Cape Town',
  country: 'South Africa',
  images: [],
  is_verified: false,
  is_certified: false,
  verification_status: null,
  created_at: '2026-10-01T00:00:00Z',
  lat: -33.92,
  lng: 18.421,
  business_types: ['Food'],
  keywords: [],
  location: 'Cape Town',
  street_address: '12 Dock Road',
  state: 'Western Cape',
  zip_code: '8001',
  coordinates: null,
  contact_info: { first_name: 'Thandi', last_name: 'Mokoena', email: 'hello@harbour.example', phone: '+27215550123', website: 'https://harbour.pinet.com' },
  hours: HOURS,
});

async function setupOwner(page: Page) {
  const context = await setup(page, { businesses: [BUSINESS, NO_PAYOUT] });
  // Wallet lists both; Update business asks for one by id
  await page.route('**/rest/v1/businesses*', (route) => {
    const id = new URL(route.request().url()).searchParams.get('id');
    if (!id) return route.fallback();
    const row = [BUSINESS, NO_PAYOUT].find((business) => `eq.${business.id}` === id);
    return route.fulfill({ json: row ? [fullRow(row)] : [] });
  });
  return context;
}

const walletField = (page: Page) => page.locator('#piWalletAddress');
const updateTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

async function expectOnWalletField(page: Page, id: number) {
  await expect(updateTab(page, 'Details')).toHaveAttribute('aria-selected', 'true');
  await expect(walletField(page)).toBeFocused();
  await expect(walletField(page)).toBeInViewport();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  expect(new URL(page.url()).pathname).toBe(`/update-registration/${id}`);
  // The navigation that dropped the param mustn't scroll back to the top afterwards
  await page.waitForTimeout(500);
  await expect(walletField(page)).toBeFocused();
  await expect(walletField(page)).toBeInViewport();
}

test('Edit lands on Details with the Pi wallet address focused, in view, and no param left', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/wallet');
  await wallets(page).getByRole('link', { name: /^Edit/ }).tap();
  await page.waitForURL('**/update-registration/56*');
  await expectOnWalletField(page, 56);
  await expect(walletField(page)).toHaveValue(PAYOUT_WALLET);
});

test('Add does the same, on an empty field', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/wallet');
  await wallets(page).getByRole('link', { name: /^Add/ }).tap();
  await page.waitForURL('**/update-registration/57*');
  await expectOnWalletField(page, 57);
  await expect(walletField(page)).toHaveValue('');
});

test('from a Wallet page scrolled down: still lands on the field', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/wallet');
  const add = wallets(page).getByRole('link', { name: /^Add/ });
  await expect(add).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 150));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await add.tap();
  await page.waitForURL('**/update-registration/57*');
  await expectOnWalletField(page, 57);
});

test('the header back arrow returns to Wallet, and so does browser Back', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/wallet');
  const edit = wallets(page).getByRole('link', { name: /^Edit/ });
  await edit.tap();
  await page.waitForURL('**/update-registration/56*');
  await expectOnWalletField(page, 56);
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL('**/wallet');

  await edit.tap();
  await page.waitForURL('**/update-registration/56*');
  await expectOnWalletField(page, 56);
  await page.goBack();
  await page.waitForURL('**/wallet');
  await expect(wallets(page)).toBeVisible();
});

test('a reload after landing opens normally, on the first tab', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/wallet');
  await wallets(page).getByRole('link', { name: /^Edit/ }).tap();
  await page.waitForURL('**/update-registration/56*');
  await expectOnWalletField(page, 56);
  await page.reload();
  await expect(updateTab(page, 'Owner')).toHaveAttribute('aria-selected', 'true');
  await expect(walletField(page)).toHaveCount(0);
});

test('a typed change still asks before leaving', async ({ page }) => {
  await setupOwner(page);
  await page.goto('/wallet');
  await wallets(page).getByRole('link', { name: /^Edit/ }).tap();
  await page.waitForURL('**/update-registration/56*');
  await expectOnWalletField(page, 56);
  await walletField(page).fill('GCHANGED');
  await page.getByRole('button', { name: 'Go back' }).tap();
  await expect(page.getByRole('alertdialog', { name: 'Unsaved Changes' })).toBeVisible();
});

test('no sideways scroll, with a long business name and a full page', async ({ page }) => {
  await setup(page, {
    walletAddress: PI_WALLET,
    businesses: [{ ...BUSINESS, business_name: 'The Extraordinarily Long Named Harbour Light Coffee Roasters Company' }, NO_PAYOUT],
    payments: [PI_PLAN, TOP_UP],
    ledger: [BALANCE_SPEND],
  });
  await page.goto('/wallet');
  await expect(activityRows(page)).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
