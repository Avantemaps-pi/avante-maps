/**
 * Pi payments need the payments scope on the SDK object of this page load: every payment
 * authenticates the current window.Pi with payments first (a cached result from an earlier load
 * doesn't count), once per object; a "scope" error before approval authenticates and starts once
 * more; and an unfinished payment Pi reports is completed (with a transaction) or cancelled or
 * explained (without).
 *
 * A fake pi-sdk.js enforces scopes like Pi's: createPayment throws
 * 'Cannot create a payment without "payments" scope' unless authenticate with payments ran on that
 * object, and every call before init() throws "not initialized".
 *
 * 375x812 in the Pi Browser, with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

const PI_BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Mobile Safari/537.36 PiBrowser/1.17.1';
test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
  userAgent: PI_BROWSER_UA,
});

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const NO_SCOPE = 'Cannot create a payment without "payments" scope';
const NOT_INITIALIZED =
  'Pi Network SDK was not initialized. Call init() before any other method.';
const UNFINISHED =
  'An earlier Pi payment is unfinished. Open the Pi Wallet to finish or cancel it, then try again.';

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

// window.__fakePi records inits, authenticates (which object, which scopes) and payments.
// __makeFakePi(label) makes a new, uninitialised, unauthenticated SDK object.
// log.incomplete: a payment authenticate reports as unfinished. log.scopeErrorAfterApproval: the
// payment fails with the scope error after its approval callback
const FAKE_SDK = `
(function () {
  var NOT_INIT = ${JSON.stringify(NOT_INITIALIZED)};
  var NO_SCOPE = ${JSON.stringify(NO_SCOPE)};
  var log = (window.__fakePi = window.__fakePi || {
    inits: [], auths: [], payments: [], made: 0, incomplete: null, scopeErrorAfterApproval: false
  });
  function makePi(label) {
    var state = { initialized: false, scopes: [] };
    function guard() { if (!state.initialized) throw new Error(NOT_INIT); }
    return {
      __label: label,
      init: function (config) {
        state.initialized = true;
        log.inits.push({ label: label, sandbox: config.sandbox });
      },
      // As if Pi forgot this object's scopes (our marker stays)
      __dropScopes: function () { state.scopes = []; },
      authenticate: function (scopes, onIncompletePaymentFound) {
        try { guard(); } catch (e) { return Promise.reject(e); }
        state.scopes = scopes.slice();
        log.auths.push({ label: label, scopes: scopes.slice() });
        if (log.incomplete && typeof onIncompletePaymentFound === 'function') onIncompletePaymentFound(log.incomplete);
        return Promise.resolve({ accessToken: 'pi-token', user: { uid: 'pi-uid-owner', username: 'SandboxUser' } });
      },
      nativeFeaturesList: function () {
        try { guard(); } catch (e) { return Promise.reject(e); }
        return Promise.resolve(['inline_media']);
      },
      createPayment: function (data, callbacks) {
        guard();
        if (state.scopes.indexOf('payments') === -1) throw new Error(NO_SCOPE);
        var id = 'pay_' + (log.payments.length + 1);
        log.payments.push({ label: label, amount: data.amount, id: id });
        setTimeout(function () {
          callbacks.onReadyForServerApproval(id);
          setTimeout(function () {
            if (log.scopeErrorAfterApproval) callbacks.onError(new Error(NO_SCOPE));
            else callbacks.onReadyForServerCompletion(id, 'tx_' + id);
          }, 300);
        }, 50);
      },
    };
  }
  window.__makeFakePi = function (label) { log.made += 1; return makePi(label); };
  window.Pi = window.__makeFakePi('sdk-1');
})();
`;

interface FakePiLog {
  inits: Array<{ label: string; sandbox: boolean }>;
  auths: Array<{ label: string; scopes: string[] }>;
  payments: Array<{ label: string; amount: number; id: string }>;
  made: number;
}

const fakePi = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakePi: FakePiLog }).__fakePi);
const setFake = (page: Page, values: Record<string, unknown>) =>
  page.evaluate(
    (v) =>
      Object.assign((window as unknown as { __fakePi: object }).__fakePi, v),
    values,
  );

const INCOMPLETE_WITH_TX = {
  identifier: 'pay_earlier',
  user_uid: 'pi-uid-owner',
  amount: 3,
  memo: 'Wallet top-up (3 Pi)',
  metadata: { kind: 'wallet_topup' },
  status: {
    developer_approved: true,
    transaction_verified: true,
    developer_completed: false,
    cancelled: false,
    user_cancelled: false,
  },
  transaction: {
    txid: 'txabcdef1234567890',
    verified: true,
    _link: 'https://example.invalid',
  },
};
const INCOMPLETE_NO_TX = {
  ...INCOMPLETE_WITH_TX,
  identifier: 'pay_open',
  transaction: null,
};

interface Options {
  /** A Pi sign-in cached in localStorage by an earlier page load */
  cachedPiAuth?: boolean;
  complete?: { status: number; body: object };
  cleanup?: { cleanedCount: number };
}

async function setup(page: Page, options: Options = {}) {
  const calls = {
    approve: 0,
    complete: [] as Record<string, unknown>[],
    cleanup: 0,
  };
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
  // After mockMap, so this wins over its abort
  await page.route('**/pi-sdk.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: FAKE_SDK }),
  );
  await page.route('**/rest/v1/rpc/get_wallet_balance*', (route) =>
    route.fulfill({ json: 23.5 }),
  );
  await page.route('**/rest/v1/pi_price*', (route) =>
    route.fulfill({
      json: { price_usd: 0.5, updated_at: '2026-11-04T00:00:00Z' },
    }),
  );
  await page.route('**/functions/v1/approve-payment', (route) => {
    calls.approve += 1;
    return route.fulfill({
      json: { success: true, message: 'Payment approved successfully' },
    });
  });
  await page.route('**/functions/v1/complete-payment', (route) => {
    calls.complete.push(
      route.request().postDataJSON() as Record<string, unknown>,
    );
    const answer = options.complete ?? {
      status: 200,
      body: {
        success: true,
        message: 'Wallet credited successfully',
        newBalance: 26.5,
      },
    };
    return route.fulfill({ status: answer.status, json: answer.body });
  });
  await page.route('**/functions/v1/cleanup-stale-payments', (route) => {
    calls.cleanup += 1;
    const cleaned = options.cleanup?.cleanedCount ?? 0;
    return route.fulfill({
      json: {
        success: true,
        message: `Cleaned up ${cleaned} stale payments`,
        cleanedCount: cleaned,
      },
    });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  if (options.cachedPiAuth) {
    await page.addInitScript(() =>
      localStorage.setItem(
        'pi_auth_result',
        JSON.stringify({
          accessToken: 'old-token',
          user: { uid: 'pi-uid-owner', username: 'SandboxUser' },
        }),
      ),
    );
  }
  return calls;
}

// Hydrated (the balance is fetched on the client) and the head has initialised the SDK
async function openWallet(page: Page) {
  await page.goto('/wallet');
  await expect(page.getByText('23.50 π')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await fakePi(page))?.inits.length ?? 0)
    .toBeGreaterThan(0);
}

async function topUp(page: Page, amount = '1') {
  const dialog = page.getByRole('dialog', { name: 'Top up your wallet' });
  await expect(async () => {
    await page.getByRole('button', { name: /Top up/ }).tap();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await dialog.getByLabel('Amount (Pi)').fill(amount);
  await dialog.getByRole('button', { name: 'Confirm' }).tap();
}

const SUCCESS = 'Wallet topped up successfully!';
const PAYMENT_SCOPES = ['username', 'payments', 'wallet_address'];

test('a Pi sign-in cached by an earlier load does not skip authenticating: payments first, then the payment', async ({
  page,
}) => {
  const calls = await setup(page, { cachedPiAuth: true });
  await openWallet(page);
  await topUp(page);
  await expect(page.getByText(SUCCESS)).toBeVisible();
  const log = await fakePi(page);
  expect(log.auths).toEqual([{ label: 'sdk-1', scopes: PAYMENT_SCOPES }]);
  expect(log.payments.map((p) => p.label)).toEqual(['sdk-1']);
  expect(calls.approve).toBe(1);
  expect(calls.complete).toHaveLength(1);
});

test('the same SDK object is authenticated once for two payments; a replaced window.Pi is authenticated again', async ({
  page,
}) => {
  await setup(page);
  await openWallet(page);
  await topUp(page);
  await expect(page.getByText(SUCCESS)).toBeVisible();
  await topUp(page, '2');
  await expect.poll(async () => (await fakePi(page)).payments.length).toBe(2);
  expect((await fakePi(page)).auths).toEqual([
    { label: 'sdk-1', scopes: PAYMENT_SCOPES },
  ]);

  // A reloaded pi-sdk.js: a new object, with no scopes yet
  await page.evaluate(() => {
    const w = window as unknown as {
      Pi: unknown;
      __makeFakePi: (l: string) => unknown;
    };
    w.Pi = w.__makeFakePi('replacement');
  });
  await topUp(page, '3');
  await expect.poll(async () => (await fakePi(page)).payments.length).toBe(3);
  const log = await fakePi(page);
  expect(log.auths).toEqual([
    { label: 'sdk-1', scopes: PAYMENT_SCOPES },
    { label: 'replacement', scopes: PAYMENT_SCOPES },
  ]);
  expect(log.payments.map((p) => p.label)).toEqual([
    'sdk-1',
    'sdk-1',
    'replacement',
  ]);
});

test('a "scope" error before the approval: authenticated with payments and started once more', async ({
  page,
}) => {
  const calls = await setup(page);
  await openWallet(page);
  await topUp(page);
  await expect(page.getByText(SUCCESS)).toBeVisible();
  // Our marker says payments, but Pi has lost them for this object
  await page.evaluate(() =>
    (
      window as unknown as { Pi: { __dropScopes: () => void } }
    ).Pi.__dropScopes(),
  );
  await topUp(page, '2');
  await expect.poll(async () => (await fakePi(page)).payments.length).toBe(2);
  await expect(page.getByText(NO_SCOPE)).toHaveCount(0);
  expect((await fakePi(page)).auths).toHaveLength(2);
  await expect.poll(() => calls.complete.length).toBe(2);
});

test('a "scope" error after the approval: no second payment, the error shows', async ({
  page,
}) => {
  await setup(page);
  await openWallet(page);
  await setFake(page, { scopeErrorAfterApproval: true });
  await topUp(page);
  await expect(page.getByText(NO_SCOPE)).toBeVisible();
  const log = await fakePi(page);
  expect(log.payments).toHaveLength(1);
  expect(log.auths).toHaveLength(1);
});

// ---- Unfinished payments at Pi, through /diagnostics → Authenticate for payments

const sdkRow = (page: Page, label: string) =>
  page.locator(`[data-row="Pi SDK: ${label}"] dd`);

async function openDiagnostics(page: Page) {
  await page.goto('/diagnostics');
  await expect(
    sdkRow(page, 'this window.Pi authenticated with payments'),
  ).toHaveText('no');
}

async function authenticateForPayments(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Authenticate for payments' }).tap();
    await expect(sdkRow(page, 'Authenticate for payments')).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });
}

test('/diagnostics: Authenticate for payments shows the scopes, and the SDK object now has payments', async ({
  page,
}) => {
  await setup(page);
  await openDiagnostics(page);
  await expect(sdkRow(page, 'unfinished payment reported by Pi')).toHaveText(
    'none reported',
  );
  await authenticateForPayments(page);
  await expect(sdkRow(page, 'Authenticate for payments')).toHaveText(
    'username, payments, wallet_address',
  );
  await expect(
    sdkRow(page, 'this window.Pi authenticated with payments'),
  ).toHaveText('yes');
  await expect(sdkRow(page, 'unfinished payment reported by Pi')).toHaveText(
    'none reported',
  );
});

test('an unfinished payment with a transaction is completed with its details, and the success shows', async ({
  page,
}) => {
  const calls = await setup(page);
  await openDiagnostics(page);
  await setFake(page, { incomplete: INCOMPLETE_WITH_TX });
  await authenticateForPayments(page);
  await expect.poll(() => calls.complete.length).toBe(1);
  expect(calls.complete[0]).toEqual({
    paymentId: 'pay_earlier',
    userId: mockUser.uid,
    amount: 3,
    memo: 'Wallet top-up (3 Pi)',
    metadata: { kind: 'wallet_topup' },
    txid: 'txabcdef1234567890',
  });
  await expect(
    page.getByText('Your earlier Pi payment is complete.'),
  ).toBeVisible();
  await expect(sdkRow(page, 'unfinished payment reported by Pi')).toHaveText(
    'pay_earlier (has a transaction; completed)',
  );
  expect(calls.cleanup).toBe(0);
});

test("an unfinished payment the server refuses to complete shows the server's message", async ({
  page,
}) => {
  const message =
    "This payment was started from a different Pi account. Sign in with the account you're paying from.";
  await setup(page, {
    complete: {
      status: 403,
      body: { success: false, error_code: 'payment_user_mismatch', message },
    },
  });
  await openDiagnostics(page);
  await setFake(page, { incomplete: INCOMPLETE_WITH_TX });
  await authenticateForPayments(page);
  await expect(page.getByText(message)).toBeVisible();
  await expect(sdkRow(page, 'unfinished payment reported by Pi')).toHaveText(
    'pay_earlier (has a transaction; refused)',
  );
});

test('an unfinished payment without a transaction: cleanup-stale-payments, then the Pi Wallet message when nothing was cancelled', async ({
  page,
}) => {
  const calls = await setup(page, { cleanup: { cleanedCount: 0 } });
  await openDiagnostics(page);
  await setFake(page, { incomplete: INCOMPLETE_NO_TX });
  await authenticateForPayments(page);
  await expect.poll(() => calls.cleanup).toBe(1);
  await expect(page.getByText(UNFINISHED)).toBeVisible();
  expect(calls.complete).toHaveLength(0);
  await expect(sdkRow(page, 'unfinished payment reported by Pi')).toHaveText(
    'pay_open (no transaction; unfinished)',
  );
});

test('an unfinished payment without a transaction that cleanup cancels: says so', async ({
  page,
}) => {
  const calls = await setup(page, { cleanup: { cleanedCount: 1 } });
  await openDiagnostics(page);
  await setFake(page, { incomplete: INCOMPLETE_NO_TX });
  await authenticateForPayments(page);
  await expect.poll(() => calls.cleanup).toBe(1);
  await expect(
    page.getByText(
      'An earlier unfinished Pi payment was cancelled. Please try again.',
    ),
  ).toBeVisible();
  await expect(sdkRow(page, 'unfinished payment reported by Pi')).toHaveText(
    'pay_open (no transaction; cancelled)',
  );
});

// The handler's own log lines (completePayment's client logging, unchanged here, prints the txid
// it's given, as it does for every payment)
test("the unfinished-payment handler's logs never hold a whole txid", async ({
  page,
}) => {
  const lines: string[] = [];
  page.on('console', (m) => lines.push(m.text()));
  const calls = await setup(page);
  await openDiagnostics(page);
  await setFake(page, { incomplete: INCOMPLETE_WITH_TX });
  await authenticateForPayments(page);
  await expect.poll(() => calls.complete.length).toBe(1);
  await expect(
    page.getByText('Your earlier Pi payment is complete.'),
  ).toBeVisible();
  const output = lines
    .filter((line) => line.includes('client.incompletePayment'))
    .join('\n');
  expect(output).toContain('pay_earlier');
  expect(output).toContain('txabcd…');
  expect(output).not.toContain('txabcdef1234567890');
});
