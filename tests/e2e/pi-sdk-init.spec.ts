/**
 * Pi SDK init: sandbox only outside the Pi Browser on non-mainnet hosts; init per SDK instance
 * (a replaced window.Pi is initialised before it's used); one retry on "not initialized" (never
 * after a payment exists); no second pi-sdk.js; and a top up that shows the server's result.
 *
 * A fake pi-sdk.js stands in for Pi's: like the real one, every call on an object that hasn't had
 * init() throws "Pi Network SDK was not initialized. Call init() before any other method."
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page, type Browser } from './helpers/fixtures';
import {
  makeAdmin,
  mockMap,
  NEARBY_BUSINESSES,
  mockUser,
} from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const PI_BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Mobile Safari/537.36 PiBrowser/2.1.0';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36';
const NOT_INITIALIZED =
  'Pi Network SDK was not initialized. Call init() before any other method.';

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

// The fake SDK. window.__fakePi records each init (which object, which sandbox) and each payment.
// __makeFakePi(label) makes a new, uninitialised SDK object, as a reloaded pi-sdk.js would.
// With window.__fakePiLate set, window.Pi only appears after 1.5s (the SDK still loading)
const FAKE_SDK = `
(function () {
  var NOT_INIT = ${JSON.stringify(NOT_INITIALIZED)};
  var log = (window.__fakePi = window.__fakePi || { inits: [], payments: [], made: 0, errorAfterApproval: false });
  function makePi(label) {
    var state = { initialized: false };
    function guard() { if (!state.initialized) throw new Error(NOT_INIT); }
    return {
      __label: label,
      init: function (config) {
        state.initialized = true;
        log.inits.push({ label: label, sandbox: config.sandbox, version: config.version });
      },
      // As if init didn't take: the object keeps any marker, but the SDK isn't initialised
      __forget: function () { state.initialized = false; },
      authenticate: function () {
        try { guard(); } catch (e) { return Promise.reject(e); }
        return Promise.resolve({ accessToken: 'pi-token', user: { uid: 'pi-uid-owner', username: 'SandboxUser' } });
      },
      nativeFeaturesList: function () {
        try { guard(); } catch (e) { return Promise.reject(e); }
        return Promise.resolve(['inline_media', 'request_permission']);
      },
      createPayment: function (data, callbacks) {
        guard();
        var id = 'pay_' + (log.payments.length + 1);
        log.payments.push({ label: label, amount: data.amount, id: id });
        setTimeout(function () {
          callbacks.onReadyForServerApproval(id);
          setTimeout(function () {
            if (log.errorAfterApproval) callbacks.onError(new Error(NOT_INIT));
            else callbacks.onReadyForServerCompletion(id, 'tx_' + id);
          }, 300);
        }, 50);
      },
    };
  }
  window.__makeFakePi = function (label) { log.made += 1; return makePi(label); };
  var install = function () { window.Pi = window.__makeFakePi('sdk-' + (log.made + 1)); };
  if (window.__fakePiLate) setTimeout(install, 1500); else install();
})();
`;

interface FakePiLog {
  inits: Array<{ label: string; sandbox: boolean; version: string }>;
  payments: Array<{ label: string; amount: number; id: string }>;
  made: number;
  errorAfterApproval: boolean;
}

const fakePi = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakePi: FakePiLog }).__fakePi);

interface Options {
  approve?: { status: number; body: object };
  complete?: { status: number; body: object };
  late?: boolean;
  cachedPiAuth?: boolean;
}

async function setup(page: Page, options: Options = {}) {
  const calls = { approve: 0, complete: 0, balance: 0 };
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
  // After mockMap, so this wins over its abort
  await page.route('**/pi-sdk.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: FAKE_SDK }),
  );
  await page.route('**/rest/v1/rpc/get_wallet_balance*', (route) => {
    calls.balance += 1;
    return route.fulfill({ json: 23.5 });
  });
  await page.route('**/rest/v1/pi_price*', (route) =>
    route.fulfill({
      json: { price_usd: 0.5, updated_at: '2026-11-04T00:00:00Z' },
    }),
  );
  await page.route('**/functions/v1/approve-payment', (route) => {
    calls.approve += 1;
    const answer = options.approve ?? {
      status: 200,
      body: {
        success: true,
        message: 'Payment approved successfully',
        paymentId: 'pay_1',
      },
    };
    return route.fulfill({ status: answer.status, json: answer.body });
  });
  await page.route('**/functions/v1/complete-payment', (route) => {
    calls.complete += 1;
    const answer = options.complete ?? {
      status: 200,
      body: {
        success: true,
        message: 'Wallet credited successfully',
        newBalance: 24.5,
      },
    };
    return route.fulfill({ status: answer.status, json: answer.body });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  if (options.late)
    await page.addInitScript(
      () =>
        ((window as unknown as { __fakePiLate: boolean }).__fakePiLate = true),
    );
  if (options.cachedPiAuth) {
    await page.addInitScript(() =>
      localStorage.setItem(
        'pi_auth_result',
        JSON.stringify({
          accessToken: 'pi-token',
          user: { uid: 'pi-uid-owner', username: 'SandboxUser' },
        }),
      ),
    );
  }
  return calls;
}

// The head's init has run on the first SDK object, and the app has hydrated (the balance is
// fetched on the client)
async function openWallet(page: Page) {
  await page.goto('/wallet');
  await expect(page.getByText('23.50 π')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await fakePi(page))?.inits.length ?? 0)
    .toBeGreaterThan(0);
}

async function topUp(page: Page, amount = '1') {
  const dialog = page.getByRole('dialog', { name: 'Top up your wallet' });
  // A tap before hydration has finished does nothing: tap until the dialog opens
  await expect(async () => {
    await page.getByRole('button', { name: /Top up/ }).tap();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await dialog.getByLabel('Amount (Pi)').fill(amount);
  await dialog.getByRole('button', { name: 'Confirm' }).tap();
}

// ---- Sandbox: the inline init script, on each hostname (served from a fake origin) and browser

async function initScriptFromApp(page: Page): Promise<string> {
  const html = await (await page.request.get('/')).text();
  const scripts = [
    ...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g),
  ].map((m) => m[1]!);
  const init = scripts.find((s) => s.includes('Pi SDK Init'));
  if (!init) throw new Error('PI_INIT_SCRIPT not found in the page');
  return init;
}

async function sandboxOn(
  browser: Browser,
  initScript: string,
  origin: string,
  userAgent: string,
) {
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><script>${FAKE_SDK}</script><script>${initScript}</script></head><body>ok</body></html>`,
    }),
  );
  await page.goto(`${origin}/`);
  const log = await fakePi(page);
  await context.close();
  return log.inits;
}

test('the init script: sandbox false inside the Pi Browser and on mainnet hosts, true only outside it elsewhere', async ({
  page,
  browser,
}) => {
  const initScript = await initScriptFromApp(page);
  const cases: Array<[string, string, boolean]> = [
    ['https://avantemapsaebbcf9516.pinet.com', PI_BROWSER_UA, false],
    ['https://testnet.avantemaps.com', PI_BROWSER_UA, false],
    ['https://testnet.avantemaps.com', DESKTOP_UA, true],
    ['https://mainnet.avantemaps.com', DESKTOP_UA, false],
    ['https://avantemaps.com', DESKTOP_UA, false],
    ['https://mainnet.avantemaps.com', PI_BROWSER_UA, false],
  ];
  for (const [origin, userAgent, sandbox] of cases) {
    const inits = await sandboxOn(browser, initScript, origin, userAgent);
    expect(
      inits,
      `${origin} ${userAgent === PI_BROWSER_UA ? 'Pi Browser' : 'desktop'}`,
    ).toEqual([{ label: 'sdk-1', sandbox, version: '2.0' }]);
  }
});

test('the init script runs again (re-inserted) without a second init, and inits a replaced window.Pi', async ({
  page,
  browser,
}) => {
  const initScript = await initScriptFromApp(page);
  const context = await browser.newContext({ userAgent: PI_BROWSER_UA });
  const other = await context.newPage();
  await other.route('https://avantemapsaebbcf9516.pinet.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><script>${FAKE_SDK}</script><script>${initScript}</script></head><body>ok</body></html>`,
    }),
  );
  await other.goto('https://avantemapsaebbcf9516.pinet.com/');
  const rerun = (s: string) =>
    other.evaluate((code) => {
      const el = document.createElement('script');
      el.textContent = code;
      document.head.appendChild(el);
    }, s);
  await rerun(initScript);
  expect((await fakePi(other)).inits.map((i) => i.label)).toEqual(['sdk-1']);
  // A reloaded pi-sdk.js: a new object, so the page flag alone mustn't stop its init
  await other.evaluate(() => {
    const w = window as unknown as {
      Pi: unknown;
      __makeFakePi: (l: string) => unknown;
    };
    w.Pi = w.__makeFakePi('reloaded');
  });
  await rerun(initScript);
  expect((await fakePi(other)).inits).toEqual([
    { label: 'sdk-1', sandbox: false, version: '2.0' },
    { label: 'reloaded', sandbox: false, version: '2.0' },
  ]);
  await context.close();
});

// ---- In the app, inside the Pi Browser

test.describe('in the Pi Browser', () => {
  test.use({ userAgent: PI_BROWSER_UA });

  test('init uses sandbox false on this host too, once', async ({ page }) => {
    await setup(page);
    await openWallet(page);
    await page.waitForTimeout(500);
    expect((await fakePi(page)).inits).toEqual([
      { label: 'sdk-1', sandbox: false, version: '2.0' },
    ]);
  });

  test('a replaced window.Pi (new object, no marker) is initialised before createPayment', async ({
    page,
  }) => {
    const calls = await setup(page);
    await openWallet(page);
    await page.evaluate(() => {
      const w = window as unknown as {
        Pi: unknown;
        __makeFakePi: (l: string) => unknown;
      };
      w.Pi = w.__makeFakePi('replacement');
    });
    await topUp(page);
    await expect(
      page.getByText('Wallet topped up successfully!'),
    ).toBeVisible();
    const log = await fakePi(page);
    expect(log.payments.map((p) => p.label)).toEqual(['replacement']);
    expect(log.inits).toContainEqual({
      label: 'replacement',
      sandbox: false,
      version: '2.0',
    });
    expect([calls.approve, calls.complete]).toEqual([1, 1]);
  });

  test('a first call that throws "not initialized" is initialised and retried once, and succeeds', async ({
    page,
  }) => {
    const calls = await setup(page, { cachedPiAuth: true });
    await openWallet(page);
    // Marked as initialised by us, but the SDK says otherwise
    await page.evaluate(() =>
      (window as unknown as { Pi: { __forget: () => void } }).Pi.__forget(),
    );
    await topUp(page);
    await expect(
      page.getByText('Wallet topped up successfully!'),
    ).toBeVisible();
    const log = await fakePi(page);
    expect(log.payments).toHaveLength(1);
    expect(log.inits.map((i) => i.label)).toEqual(['sdk-1', 'sdk-1']);
    expect([calls.approve, calls.complete]).toEqual([1, 1]);
  });

  test('Pi.authenticate gets the same retry (no cached Pi sign-in)', async ({
    page,
  }) => {
    await setup(page);
    await openWallet(page);
    await page.evaluate(() =>
      (window as unknown as { Pi: { __forget: () => void } }).Pi.__forget(),
    );
    await topUp(page);
    await expect(
      page.getByText('Wallet topped up successfully!'),
    ).toBeVisible();
    expect((await fakePi(page)).payments).toHaveLength(1);
  });

  test('"not initialized" after the approval callback: no second payment, the error shows', async ({
    page,
  }) => {
    await setup(page, { cachedPiAuth: true });
    await openWallet(page);
    await page.evaluate(
      () =>
        ((
          window as unknown as { __fakePi: FakePiLog }
        ).__fakePi.errorAfterApproval = true),
    );
    await topUp(page);
    await expect(page.getByText(NOT_INITIALIZED)).toBeVisible();
    expect((await fakePi(page)).payments).toHaveLength(1);
  });

  test('while pi-sdk.js is still loading, no second script tag is added, and the SDK is initialised once', async ({
    page,
  }) => {
    await setup(page, { late: true });
    await page.goto('/wallet');
    await expect(page.getByRole('button', { name: /Top up/ })).toBeVisible();
    await expect
      .poll(async () => (await fakePi(page))?.inits.length ?? 0, {
        timeout: 15_000,
      })
      .toBe(1);
    await page.waitForTimeout(500);
    expect(
      await page.locator('script[src*="sdk.minepi.com/pi-sdk.js"]').count(),
    ).toBeLessThanOrEqual(1);
    // The SDK ran once (a second pi-sdk.js would make a second object) and was initialised once
    expect((await fakePi(page)).made).toBe(1);
    expect((await fakePi(page)).inits).toEqual([
      { label: 'sdk-1', sandbox: false, version: '2.0' },
    ]);
  });

  // ---- Top up: the server's result

  test("an approval refused with 403 shows the server's message, and the balance is fetched again", async ({
    page,
  }) => {
    const message =
      "This payment was started from a different Pi account. Sign in with the account you're paying from.";
    const calls = await setup(page, {
      cachedPiAuth: true,
      approve: {
        status: 403,
        body: { success: false, error_code: 'payment_user_mismatch', message },
      },
    });
    await openWallet(page);
    const before = calls.balance;
    await topUp(page);
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByText('Wallet topped up successfully!')).toHaveCount(
      0,
    );
    await expect.poll(() => calls.balance).toBeGreaterThan(before);
    // Still open, to try again
    await expect(
      page.getByRole('dialog', { name: 'Top up your wallet' }),
    ).toBeVisible();
  });

  test('a completion that fails with 500 shows its message, not success', async ({
    page,
  }) => {
    const message =
      'Payment completed but wallet credit failed. Please contact support.';
    const calls = await setup(page, {
      cachedPiAuth: true,
      complete: { status: 500, body: { success: false, message } },
    });
    await openWallet(page);
    const before = calls.balance;
    await topUp(page);
    await expect(page.getByText(message)).toBeVisible();
    await expect(page.getByText('Wallet topped up successfully!')).toHaveCount(
      0,
    );
    expect(calls.complete).toBe(1);
    await expect.poll(() => calls.balance).toBeGreaterThan(before);
  });

  test('a completion the server confirms shows success, closes the dialog and fetches the balance again', async ({
    page,
  }) => {
    const calls = await setup(page, { cachedPiAuth: true });
    await openWallet(page);
    const before = calls.balance;
    await topUp(page);
    await expect(
      page.getByText('Wallet topped up successfully!'),
    ).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Top up your wallet' }),
    ).toHaveCount(0);
    await expect.poll(() => calls.balance).toBeGreaterThan(before);
  });

  // ---- Diagnostics

  test('/diagnostics shows the Pi SDK state, and Test Pi SDK returns the features list', async ({
    page,
  }) => {
    await setup(page);
    // An admin-only page
    await makeAdmin(page);
    await page.goto('/diagnostics');
    const row = (label: string) =>
      page.locator(`[data-row="Pi SDK: ${label}"] dd`);
    await expect(row('Pi Browser (user agent)')).toHaveText('yes');
    await expect(row('hostname')).toHaveText('localhost');
    await expect(row('sandbox used by init')).toHaveText('false');
    await expect(row('window.__piInitialized')).toHaveText('true');
    await expect(row('this window.Pi initialised by us')).toHaveText('yes');
    // The server's HTML has one; hydration can take head script tags out, so 0 or 1, never more
    await expect(row('pi-sdk.js script tags now')).toHaveText(/^[01]$/);
    await page.getByRole('button', { name: 'Test Pi SDK' }).tap();
    await expect(row('Test Pi SDK')).toHaveText(
      '["inline_media","request_permission"]',
    );
  });

  test('/diagnostics with a replaced window.Pi: says "no", and Test Pi SDK initialises it and works', async ({
    page,
  }) => {
    await setup(page);
    // An admin-only page
    await makeAdmin(page);
    await page.goto('/diagnostics');
    const row = (label: string) =>
      page.locator(`[data-row="Pi SDK: ${label}"] dd`);
    await expect(row('this window.Pi initialised by us')).toHaveText('yes');
    await page.evaluate(() => {
      const w = window as unknown as {
        Pi: unknown;
        __makeFakePi: (l: string) => unknown;
      };
      w.Pi = w.__makeFakePi('replacement');
    });
    await page.getByRole('button', { name: 'Test Pi SDK' }).tap();
    await expect(row('Test Pi SDK')).toHaveText(
      '["inline_media","request_permission"]',
    );
    await expect(row('this window.Pi initialised by us')).toHaveText('yes');
  });
});

// ---- Outside the Pi Browser (desktop testing on a non-mainnet host)

test.describe('outside the Pi Browser', () => {
  test.use({ userAgent: DESKTOP_UA });

  test('init uses sandbox true here (localhost is not a mainnet host)', async ({
    page,
  }) => {
    await setup(page);
    await openWallet(page);
    expect((await fakePi(page)).inits[0]).toEqual({
      label: 'sdk-1',
      sandbox: true,
      version: '2.0',
    });
  });
});
