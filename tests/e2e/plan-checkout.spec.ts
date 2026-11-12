/**
 * Picking a paid plan on Pricing opens a sheet offering the Avante Maps balance and the Pi Wallet.
 * The balance is only spent through pay-from-balance, and the Pi Wallet path charges the π shown.
 *
 * 375x812 with the sandbox session, a fake Supabase session, mocked pay-from-balance and balance RPC,
 * and a stubbed Pi SDK that records createPayment.
 */
import { test, expect, type Page } from './helpers/fixtures';
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

// $5 at $0.0767 is 65.19 π, $48 is 625.82 π, rounded up
const PRICE_USD = 0.0767;
type PayResponse = { status: number; json: Record<string, unknown> };
const PAID: PayResponse = { status: 200, json: { success: true, balance: 34.81, amountPi: 65.19, tier: 'small-business', frequency: 'monthly' } };

const PIPELINE_OK: PayResponse = { status: 200, json: { success: true, message: 'ok', paymentId: 'pid-1' } };

async function setup(
  page: Page,
  options: {
    balance?: number | 'never' | 'fails';
    pay?: PayResponse;
    holdPay?: boolean;
    priceFails?: boolean;
    /** Answers from the server. With these the mocked Pi SDK runs its callbacks, as the real one does */
    approve?: PayResponse | (() => PayResponse);
    complete?: PayResponse;
    /** What payment-status reports while polling */
    rowStatus?: Record<string, unknown>;
    /** How many times the mocked Pi SDK calls onReadyForServerApproval at once (default 1) */
    approvalCalls?: number;
    /** Once pay-from-balance has succeeded: the balance, and the wallet_ledger rows */
    afterPay?: { balance: number; ledger: object[] };
    /** After approval the wallet closes without signing: the user cancels, or the SDK's error */
    walletCloses?: 'cancel' | { error: string };
  } = {},
) {
  const payCalls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const balances: unknown[] = [];
  const approveCalls: Record<string, unknown>[] = [];
  const completeCalls: Record<string, unknown>[] = [];
  const cleanupCalls: Record<string, unknown>[] = [];
  const price = { usd: PRICE_USD };
  let releasePay = () => {};
  const payHeld = new Promise<void>((resolve) => (releasePay = resolve));

  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await mockMap(page, NEARBY_BUSINESSES);
  await page.route('**/rest/v1/pi_price*', (route) =>
    options.priceFails
      ? route.fulfill({ status: 500, json: { message: 'boom' } })
      : route.fulfill({ json: { price_usd: price.usd, updated_at: '2026-11-04T00:00:00Z' } }),
  );
  await page.route('**/functions/v1/approve-payment', (route) => {
    approveCalls.push(route.request().postDataJSON() as Record<string, unknown>);
    const answer = typeof options.approve === 'function' ? options.approve() : (options.approve ?? PIPELINE_OK);
    return route.fulfill({ status: answer.status, json: answer.json });
  });
  await page.route('**/functions/v1/complete-payment', (route) => {
    completeCalls.push(route.request().postDataJSON() as Record<string, unknown>);
    const answer = options.complete ?? PIPELINE_OK;
    return route.fulfill({ status: answer.status, json: answer.json });
  });
  await page.route('**/functions/v1/cleanup-stale-payments', (route) => {
    cleanupCalls.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { success: true, message: 'ok', cleanedCount: 1, cancelled: true } });
  });
  await page.route('**/functions/v1/payment-status', (route) =>
    route.fulfill({ json: { success: true, status: options.rowStatus ?? { approved: true, completed: false, cancelled: false } } }),
  );
  await page.route('**/rest/v1/wallet_ledger*', (route) => {
    const after = payCalls.length ? options.afterPay : undefined;
    return route.fulfill({ json: after ? after.ledger : [] });
  });
  await page.route('**/rest/v1/rpc/get_wallet_balance*', async (route) => {
    if (options.afterPay && payCalls.length) {
      return route.fulfill({ json: options.afterPay.balance });
    }
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
  await page.addInitScript(
    ({ runCallbacks, approvalFails, approvalCalls, walletCloses }) => {
      const w = window as unknown as { Pi: object; __piInitialized: boolean; __piPayments: unknown[] };
      w.__piPayments = [];
      w.__piInitialized = true;
      type Callbacks = {
        onReadyForServerApproval: (id: string) => Promise<void>;
        onReadyForServerCompletion: (id: string, txid: string) => Promise<void>;
        onCancel: (id: string) => void;
        onError: (error: Error, payment?: object) => void;
      };
      w.Pi = {
        init: () => undefined,
        authenticate: () => Promise.resolve({ accessToken: 'pi', user: { uid: 'pi-uid', username: 'SandboxUser' } }),
        createPayment: (data: unknown, callbacks: Callbacks) => {
          w.__piPayments.push(data);
          if (!runCallbacks) return;
          void (async () => {
            const approvals = Array.from({ length: approvalCalls }, () =>
              callbacks.onReadyForServerApproval('pid-1'),
            );
            await Promise.all(approvals);
            // The wallet closes unsigned, as with too little Pi: approved, but never a transaction
            if (walletCloses === 'cancel') return callbacks.onCancel('pid-1');
            if (walletCloses) {
              return callbacks.onError(new Error(walletCloses.error), {
                identifier: 'pid-1',
                status: { developer_approved: true, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false },
                transaction: null,
              });
            }
            // A refused approval never reaches signing
            if (!approvalFails) await callbacks.onReadyForServerCompletion('pid-1', 'abc123');
          })();
        },
      };
    },
    {
      runCallbacks: options.approve !== undefined || options.complete !== undefined || options.walletCloses !== undefined,
      approvalFails: typeof options.approve === 'object' && options.approve.status !== 200,
      approvalCalls: options.approvalCalls ?? 1,
      walletCloses: options.walletCloses ?? null,
    },
  );
  return { payCalls, balances, releasePay, approveCalls, completeCalls, cleanupCalls, price };
}

const piPayments = (page: Page) =>
  page.evaluate(() => (window as unknown as { __piPayments: { amount: number; memo: string; metadata: Record<string, string> }[] }).__piPayments);
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

async function openPricingAt(page: Page, amount: string) {
  await page.goto('/pricing');
  await expect(page.getByText(`π ${amount}`)).toBeVisible();
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
  await expect(page.getByText('π 625.82')).toBeVisible();
  await planButton(page).tap();
  await expect(sheet(page).getByText('$48.00 a year · 625.82 π today')).toBeVisible();
  await expect(sheet(page).getByText('Covers 1 year from today.')).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Pay 625.82 π from balance' }).tap();
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

test('Continue in Pi Wallet charges the π shown in the sheet, not the USD price', async ({ page }) => {
  const { approveCalls, completeCalls } = await setup(page, { balance: 3.2, complete: PIPELINE_OK });
  await openSheet(page);
  await expect(sheet(page).getByText('$5.00 a month · 65.19 π today')).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect.poll(async () => (await piPayments(page)).length).toBe(1);
  const payment = (await piPayments(page))[0]!;
  expect(payment.amount).toBe(65.19);
  expect(payment.memo).toBe('Small Business plan (monthly)');
  await expect.poll(() => completeCalls.length).toBe(1);
  // With the access token from this visit's Pi.authenticate, for the server's payer check
  expect(approveCalls[0]).toMatchObject({ amount: 65.19, piAccessToken: 'pi' });
  expect(completeCalls[0]).toMatchObject({ amount: 65.19, piAccessToken: 'pi' });
  await expect(page.getByText(/Successfully subscribed/)).toBeVisible();
});

// At $0.0604, $5 is 82.7815 π and $48 is 794.7020 π: rounding up and to the nearest 0.01 differ for both
for (const [name, yearly, shown, sheetText, memo, frequency] of [
  ['monthly', false, '82.79', '$5.00 a month · 82.79 π today', 'Small Business plan (monthly)', 'monthly'],
  ['yearly', true, '794.71', '$48.00 a year · 794.71 π today', 'Small Business plan (yearly)', 'annual'],
] as const) {
  test(`${name}: the card, the balance option and the Pi Wallet option all show ${shown} π`, async ({ page }) => {
    const { price, payCalls } = await setup(page, { balance: 5000, pay: { status: 200, json: { success: true, balance: 1, amountPi: Number(shown), tier: 'small-business', frequency } } });
    price.usd = 0.0604;
    await page.goto('/pricing');
    await expect(page.getByText('π 82.79')).toBeVisible();
    if (yearly) {
      await page.getByRole('button', { name: /Yearly/ }).tap();
      await expect(page.getByText(`π ${shown}`)).toBeVisible();
    }
    await planButton(page).tap();

    // The balance option
    await expect(sheet(page).getByText(sheetText)).toBeVisible();
    await expect(balanceRadio(page)).toBeChecked();
    const pay = sheet(page).getByRole('button', { name: `Pay ${shown} π from balance` });
    await expect(pay).toBeVisible();
    const after = (5000 - Number(shown)).toFixed(2);
    await expect(sheet(page).getByText(`5000.00 π available · ${after} π left after`)).toBeVisible();

    // The Pi Wallet option: the same amount, and it's what the SDK is asked for
    await piRadio(page).check();
    await expect(sheet(page).getByText(sheetText)).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
    await expect.poll(async () => (await piPayments(page)).length).toBe(1);
    const payment = (await piPayments(page))[0]!;
    expect(payment.amount).toBe(Number(shown));
    expect(payment.memo).toBe(memo);
    expect(payment.metadata).toMatchObject({ frequency });
    expect(payCalls).toEqual([]);
  });
}

test('with exactly the rounded-up price in the balance: it covers it, and leaves 0.00', async ({ page }) => {
  const { price } = await setup(page, { balance: 82.79 });
  price.usd = 0.0604;
  await openPricingAt(page, '82.79');
  await planButton(page).tap();
  await expect(balanceRadio(page)).toBeChecked();
  await expect(sheet(page).getByText('82.79 π available · 0.00 π left after')).toBeVisible();
});

test('a cent short of the rounded-up price: not enough, though it covers the nearest', async ({ page }) => {
  const { price } = await setup(page, { balance: 82.78 });
  price.usd = 0.0604;
  await openPricingAt(page, '82.79');
  await planButton(page).tap();
  await expect(sheet(page).getByText('Not enough: 82.78 π available')).toBeVisible();
  await expect(balanceRadio(page)).toBeDisabled();
});

test('Pi price unavailable: both rows and the button disabled, with the message', async ({ page }) => {
  await setup(page, { balance: 100, priceFails: true });
  await page.goto('/pricing');
  await expect(planButton(page)).toBeVisible();
  // Hydrated once a tap opens the sheet
  await expect(async () => {
    await planButton(page).tap();
    await expect(sheet(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(sheet(page).getByText('Price unavailable right now. Try again in a minute.')).toBeVisible();
  await expect(piRadio(page)).toBeDisabled();
  await expect(piRadio(page)).not.toBeChecked();
  await expect(piRow(page)).toHaveCSS('opacity', '0.6');
  await expect(balanceRadio(page)).toBeDisabled();
  await expect(balanceRadio(page)).not.toBeChecked();
  await expect(sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' })).toBeDisabled();
  // No made-up amount from the fallback rate
  await expect(sheet(page).getByText('$5.00 a month · … π today')).toBeVisible();
  expect(await piPayments(page)).toEqual([]);
});

test('amount_mismatch: a toast, no completion, no banner, and the sheet reopens at the fresh price', async ({ page }) => {
  const { completeCalls, price } = await setup(page, {
    balance: 3.2,
    approve: { status: 400, json: { success: false, error_code: 'amount_mismatch', message: 'The payment amount does not match the plan price', expectedPi: 70 } },
    rowStatus: { approved: false, completed: false, cancelled: true, error: 'amount_mismatch' },
  });
  await openSheet(page);
  await expect(sheet(page).getByText('$5.00 a month · 65.19 π today')).toBeVisible();
  price.usd = 0.0714; // The cron moved it: $5 is now 70.03 π, rounded up
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect(page.getByText('The price changed. Please try again.')).toBeVisible();
  await expect(sheet(page).getByText('$5.00 a month · 70.03 π today')).toBeVisible();
  await expect(page.getByText('Payment cancelled')).toHaveCount(0);
  expect(completeCalls).toEqual([]);
  // And paying again asks for the new amount
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect.poll(async () => (await piPayments(page)).length).toBe(2);
  expect((await piPayments(page))[1]!.amount).toBe(70.03);
});

test("plan_not_activated: the server's message, no success toast or banner", async ({ page }) => {
  const message = 'Payment received, but your plan could not be activated. Please contact support.';
  await setup(page, {
    balance: 3.2,
    complete: { status: 500, json: { success: false, error_code: 'plan_not_activated', message } },
    // As live: the row says completed, which is what the poller reads
    rowStatus: { approved: true, verified: true, completed: true, cancelled: false, error: 'plan_not_activated' },
  });
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.getByText(/Successfully subscribed/)).toHaveCount(0);
  await expect(page.getByText('Payment completed')).toHaveCount(0);
  await expect(page.getByText(/your subscription is active/)).toHaveCount(0);
  // The poller has had time to report the row as completed
  await page.waitForTimeout(3000);
  await expect(page.getByText('Payment completed')).toHaveCount(0);
});

test("amount_mismatch_after_completion: the server's message, no success toast or banner", async ({ page }) => {
  const message = "Payment received, but it doesn't match the price. Please contact support.";
  await setup(page, {
    balance: 3.2,
    complete: { status: 400, json: { success: false, error_code: 'amount_mismatch_after_completion', message } },
    rowStatus: { approved: true, verified: true, completed: true, cancelled: false, error: 'amount_mismatch_after_completion' },
  });
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.getByText(/Successfully subscribed/)).toHaveCount(0);
  await expect(page.getByText('Payment completed')).toHaveCount(0);
  await expect(page.getByText(/your subscription is active/)).toHaveCount(0);
  await page.waitForTimeout(3000);
  await expect(page.getByText('Payment completed')).toHaveCount(0);
  // Nothing was offered again: the Pi has moved
  await expect(sheet(page)).toHaveCount(0);
});

test('a refused completion for another reason is an error, not a success', async ({ page }) => {
  await setup(page, { balance: 3.2, complete: { status: 400, json: { success: false, message: 'Payment amount does not match subscription price' } } });
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect(page.getByText('Payment amount does not match subscription price')).toBeVisible();
  await expect(page.getByText(/Successfully subscribed/)).toHaveCount(0);
});

test('Try again on the banner reopens the sheet, rather than paying an amount of its own', async ({ page }) => {
  await setup(page, { balance: 3.2, complete: PIPELINE_OK, rowStatus: { approved: false, completed: false, cancelled: true } });
  await page.route('**/functions/v1/complete-payment', (route) => route.abort());
  await openSheet(page);
  await sheet(page).getByRole('button', { name: 'Continue in Pi Wallet' }).tap();
  await expect(page.getByText('Payment cancelled')).toBeVisible();
  const paymentsBefore = (await piPayments(page)).length;
  await page.getByRole('button', { name: /try again|retry/i }).tap();
  await expect(sheet(page)).toBeVisible();
  expect((await piPayments(page)).length).toBe(paymentsBefore);
});

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

// Pi's approval window is 60 s: with no callback at all, the plan payment ends after 90 s (#174)
test('Pi never calls back: after 90 s the payment times out with the message, and the plan can be chosen again', async ({
  page,
}) => {
  await page.clock.install();
  await setup(page, { balance: 3.2 });
  await openSheet(page);
  await sheet(page)
    .getByRole('button', { name: 'Continue in Pi Wallet' })
    .tap();
  await expect.poll(async () => (await piPayments(page)).length).toBe(1);
  await expect(planButton(page)).toBeDisabled();

  await page.clock.fastForward('01:31');
  await expect(
    page.getByText('The payment timed out. No Pi was taken. Please try again.'),
  ).toBeVisible();
  await expect(planButton(page)).toBeEnabled();
});

// 11 Nov: Pi called onReadyForServerApproval 3 times at once, and the overlapping approves cancelled
// a good payment. One request per payment
test('Pi calling onReadyForServerApproval 3 times at once: one approve-payment request for the plan', async ({
  page,
}) => {
  const { approveCalls, completeCalls } = await setup(page, {
    balance: 3.2,
    approve: PIPELINE_OK,
    complete: PIPELINE_OK,
    approvalCalls: 3,
  });
  await openSheet(page);
  await sheet(page)
    .getByRole('button', { name: 'Continue in Pi Wallet' })
    .tap();
  await expect.poll(() => completeCalls.length).toBe(1);
  expect(approveCalls).toHaveLength(1);
});

// Paid from the balance: the Wallet shows the new balance and the plan row straight away, not up to
// a minute later from the cache (staleTime is 1 min)
test('after paying from the balance, the Wallet shows the reduced balance and the plan row without a refresh', async ({
  page,
}) => {
  await setup(page, {
    balance: 100,
    afterPay: {
      balance: 34.81,
      ledger: [
        {
          id: 21,
          amount_pi: -65.19,
          transaction_type: 'subscription',
          reference_id:
            'plan:small-business:monthly:11111111-1111-4111-8111-111111111111',
          created_at: new Date().toISOString(),
        },
      ],
    },
  });
  // The Wallet first, so its balance and activity are in the cache
  await page.goto('/wallet');
  const activity = page.getByRole('region', { name: 'Recent activity' });
  await expect(page.getByText('100.00 π')).toBeVisible();
  await expect(activity.getByText('No activity yet')).toBeVisible();

  // To Pricing in the app (no reload), and pay from the balance
  await expect(async () => {
    await page.getByRole('button', { name: 'Open menu' }).tap();
    await expect(
      page.getByRole('link', { name: 'Pricing', exact: true }),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Pricing', exact: true }).tap();
  await page.waitForURL('**/pricing');
  await expect(page.getByText('π 65.19')).toBeVisible();
  await planButton(page).tap();
  await sheet(page)
    .getByRole('button', { name: 'Pay 65.19 π from balance' })
    .tap();
  await expect(page.getByText('Small Business plan active')).toBeVisible();

  // Back to the Wallet the same way
  await page.getByRole('button', { name: /back/i }).first().tap();
  await page.waitForURL('**/wallet');
  await expect(page.getByText('34.81 π')).toBeVisible();
  const row = activity.getByRole('listitem').first();
  await expect(row).toContainText('Small Business plan');
  await expect(row).toContainText('Plan · Paid from balance');
  await expect(row).toContainText('− 65.19 π');
});

// 13 Nov: the wallet said "not enough funds" and closed, and the approved payment stayed Pending until
// the stale cleanup ran. Now it's cancelled at once, by its id
test('the wallet cancels after approval: cleanup-stale-payments is called once with that paymentId', async ({
  page,
}) => {
  const { cleanupCalls, completeCalls } = await setup(page, {
    balance: 3.2,
    approve: PIPELINE_OK,
    walletCloses: 'cancel',
  });
  await openSheet(page);
  await sheet(page)
    .getByRole('button', { name: 'Continue in Pi Wallet' })
    .tap();
  await expect
    .poll(() => cleanupCalls.filter((body) => body['paymentId']).length)
    .toBe(1);
  expect(cleanupCalls.find((body) => body['paymentId'])).toEqual({
    userId: mockUser.uid,
    paymentId: 'pid-1',
  });
  // Once only, and nothing to complete
  await page.waitForTimeout(1000);
  expect(cleanupCalls.filter((body) => body['paymentId'])).toHaveLength(1);
  expect(completeCalls).toEqual([]);
});

test('the wallet errors with not enough funds after approval: cleanup-stale-payments gets that paymentId once', async ({
  page,
}) => {
  const { cleanupCalls } = await setup(page, {
    balance: 3.2,
    approve: PIPELINE_OK,
    walletCloses: { error: 'Insufficient funds' },
  });
  await openSheet(page);
  await sheet(page)
    .getByRole('button', { name: 'Continue in Pi Wallet' })
    .tap();
  await expect
    .poll(() => cleanupCalls.filter((body) => body['paymentId']).length)
    .toBe(1);
  expect(cleanupCalls.find((body) => body['paymentId'])!['paymentId']).toBe(
    'pid-1',
  );
});

test('a signed payment never goes to cleanup-stale-payments by its id', async ({
  page,
}) => {
  const { cleanupCalls, completeCalls } = await setup(page, {
    balance: 3.2,
    approve: PIPELINE_OK,
    complete: PIPELINE_OK,
  });
  await openSheet(page);
  await sheet(page)
    .getByRole('button', { name: 'Continue in Pi Wallet' })
    .tap();
  await expect.poll(() => completeCalls.length).toBe(1);
  await page.waitForTimeout(1000);
  expect(cleanupCalls.filter((body) => body['paymentId'])).toEqual([]);
});

test('the plain cleanup runs once when the app opens on Pricing, not again within 5 minutes in the same tab', async ({
  page,
}) => {
  const { cleanupCalls } = await setup(page, { balance: 3.2 });
  await openPricing(page);
  // The app start and Pricing share the throttle: one call between them
  await expect.poll(() => cleanupCalls.length).toBe(1);
  expect(cleanupCalls[0]).toEqual({ userId: mockUser.uid });

  // Away and back to Pricing in the app, without a reload (the router follows popstate)
  const goInApp = (path: string) =>
    page.evaluate((to) => {
      window.history.pushState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
  await goInApp('/about');
  await expect(page.getByText('π 65.19')).toHaveCount(0);
  await goInApp('/pricing');
  await expect(page.getByText('π 65.19')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(cleanupCalls).toHaveLength(1);
});
