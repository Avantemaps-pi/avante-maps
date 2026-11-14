/**
 * Logging out leaves the signed-in app: the side menu's Logout (phone or desktop) goes to `/`,
 * which shows the landing page, with "You've been logged out" shown once. The page it replaced
 * isn't in history, and the cached data of the old session is cleared, so Back shows at most a
 * signed-out page and the next user to sign in on the phone sees only their own data.
 *
 * An automatic logout (the session monitor finds the session gone) also goes to `/`, except on
 * a page that works signed out (here /privacy), where the user stays.
 *
 * The sandbox session, a fake Supabase session and mocked Supabase. The session expiry tests
 * use a real (non-sandbox) saved user, since the monitor skips sandbox sessions.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser, SANDBOX_MOCK_KEY } from './helpers/mapMocks';

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const sessionFor = (id: string) => ({
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: { id, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
});

// What the mocked backend returns for whoever is signed in
interface Account {
  balance: number;
  unread: number;
}
const FIRST: Account = { balance: 23.5, unread: 3 };
const SECOND: Account = { balance: 7.25, unread: 0 };

async function setup(page: Page, { sandbox = true } = {}) {
  const state = { account: FIRST, signOuts: 0 };
  const session = sessionFor(mockUser.uid);
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/logout')) {
      state.signOuts += 1;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ json: session.user });
  });
  await mockMap(page, NEARBY_BUSINESSES);
  await page.route('**/rest/v1/rpc/get_wallet_balance*', (route) => route.fulfill({ json: state.account.balance }));
  await page.route('**/rest/v1/notifications*', (route) =>
    route.request().method() === 'HEAD'
      ? route.fulfill({ status: 200, headers: { 'content-range': `*/${state.account.unread}` } })
      : route.fulfill({ json: [] }),
  );
  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  // A real saved user: the session monitor runs for it (it skips sandbox sessions)
  if (!sandbox) await page.addInitScript((key) => localStorage.removeItem(key), SANDBOX_MOCK_KEY);
  return state;
}

const balance = (page: Page) => page.getByRole('region', { name: 'Avante Maps balance' });
// The landing page opens its sign-in dialog over itself, which hides the page from the accessibility tree
const landingHeading = (page: Page) =>
  page.getByRole('heading', { name: 'A Business Directory Built By One Person, For The Pi Community', includeHidden: true });
const signInDialog = (page: Page) => page.getByRole('dialog', { name: 'Sign in to Avante Maps' });
const loggedOutToast = (page: Page) => page.getByText("You've been logged out", { exact: true });
const path = (page: Page) => new URL(page.url()).pathname;

// Retry until hydrated: a tap on the server-rendered markup does nothing
async function openMenu(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Open menu' }).first().tap();
    await expect(page.getByRole('button', { name: 'Logout' })).toBeInViewport({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('Logout on Discover goes to the landing page, with the toast once', async ({ page }) => {
    const state = await setup(page);
    await page.goto('/recommendations');
    await openMenu(page);
    await page.getByRole('button', { name: 'Logout' }).tap();

    await expect.poll(() => path(page)).toBe('/');
    await expect(landingHeading(page)).toBeAttached();
    await expect(signInDialog(page)).toBeVisible();
    await expect(page.getByText('Sign in to see recommendations')).toHaveCount(0);
    await expect(loggedOutToast(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(loggedOutToast(page)).toHaveCount(1);
    expect(state.signOuts).toBe(1);
  });

  test('Back after Logout shows no signed-in content', async ({ page }) => {
    await setup(page);
    await page.goto('/wallet');
    await expect(balance(page).getByText('23.50')).toBeVisible();
    // In-app to Discover, then Logout there: Discover's history entry becomes `/`
    await page.getByRole('link', { name: 'Discover' }).tap();
    await expect.poll(() => path(page)).toBe('/recommendations');
    await openMenu(page);
    await page.getByRole('button', { name: 'Logout' }).tap();
    await expect.poll(() => path(page)).toBe('/');
    await expect(landingHeading(page)).toBeAttached();
    await expect(signInDialog(page)).toBeVisible();

    await page.goBack();
    await expect.poll(() => path(page)).toBe('/wallet');
    await page.waitForTimeout(1_000);
    await expect(page.getByText('23.50')).toHaveCount(0);
    await expect(page.getByText(mockUser.username)).toHaveCount(0);
    await expect(page.getByText(/unread/)).toHaveCount(0);
  });

  test('a double tap on Logout signs out once', async ({ page }) => {
    const state = await setup(page);
    // Slow sign-out, so the button is still there, busy, for the second tap
    await page.route('**/auth/v1/logout*', async (route) => {
      state.signOuts += 1;
      await new Promise((r) => setTimeout(r, 800));
      await route.fulfill({ status: 204, body: '' });
    });
    await page.goto('/wallet');
    await openMenu(page);
    const button = page.getByRole('button', { name: 'Logout' });
    await button.tap();
    await expect(page.getByRole('button', { name: 'Logging out…' })).toBeDisabled();
    await page.getByRole('button', { name: 'Logging out…' }).tap({ force: true });
    await expect.poll(() => path(page)).toBe('/');
    await page.waitForTimeout(1_000);
    expect(state.signOuts).toBe(1);
    await expect(loggedOutToast(page)).toHaveCount(1);
  });

  test('a background refresh still running at Logout does not sign the old user back in', async ({ page }) => {
    await setup(page);
    // The silent refresh reads roles; hold its answer until after Logout
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let refreshStarted = false;
    await page.route('**/rest/v1/user_roles*', async (route) => {
      refreshStarted = true;
      await held;
      await route.fulfill({ json: [{ role: 'user' }] });
    });
    await page.goto('/wallet');
    await expect.poll(() => refreshStarted, { timeout: 15_000 }).toBe(true);
    await openMenu(page);
    await page.getByRole('button', { name: 'Logout' }).tap();
    await expect.poll(() => path(page)).toBe('/');
    release();
    await page.waitForTimeout(2_000);
    await expect(landingHeading(page)).toBeAttached();
    await expect(page.getByRole('button', { name: 'Logout' })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('avante_maps_auth'))).toBeNull();
  });

  test('after Logout on Wallet, the next user to sign in sees only their own wallet', async ({ page }) => {
    const state = await setup(page);
    await page.goto('/wallet');
    await expect(balance(page).getByText('23.50')).toBeVisible();
    await openMenu(page);
    await page.getByRole('button', { name: 'Logout' }).tap();
    await expect.poll(() => path(page)).toBe('/');

    // Someone else signs in on the same phone, without a reload (a reload would empty the cache anyway)
    state.account = SECOND;
    await page.evaluate((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), sessionFor(mockUser.uid));
    await page.getByRole('button', { name: 'Continue as sandbox user' }).tap();
    await expect(landingHeading(page)).toHaveCount(0);
    await openMenu(page);
    await page.getByRole('link', { name: 'Wallet', exact: true }).tap();
    await expect.poll(() => path(page)).toBe('/wallet');
    await expect(balance(page).getByText('7.25')).toBeVisible();
    await expect(page.getByText('23.50')).toHaveCount(0);
  });

  test('session expired on /privacy: stays on /privacy, with the toast', async ({ page }) => {
    await page.clock.install();
    await setup(page, { sandbox: false });
    await page.goto('/privacy');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_500);
    // Signed in: the monitor is running
    await expect(page.getByRole('button', { name: 'Open menu' }).first()).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('supabase.auth.token'));
    await page.clock.fastForward('10:30');
    await expect(loggedOutToast(page)).toBeVisible();
    expect(path(page)).toBe('/privacy');
    await expect(landingHeading(page)).toHaveCount(0);
  });

  test('session expired on Wallet: goes to the landing page', async ({ page }) => {
    await page.clock.install();
    await setup(page, { sandbox: false });
    await page.goto('/wallet');
    await expect(balance(page).getByText('23.50')).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('supabase.auth.token'));
    await page.clock.fastForward('10:30');
    await expect(loggedOutToast(page)).toBeVisible();
    await expect.poll(() => path(page)).toBe('/');
    await expect(landingHeading(page)).toBeAttached();
    await expect(signInDialog(page)).toBeVisible();
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the desktop sidebar Logout goes to the landing page', async ({ page }) => {
    await setup(page);
    await page.goto('/wallet');
    await expect(balance(page).getByText('23.50')).toBeVisible();
    const logout = page.getByRole('button', { name: 'Logout' });
    await expect(async () => {
      await logout.click();
      await expect.poll(() => path(page), { timeout: 1_000 }).toBe('/');
    }).toPass({ timeout: 15_000 });
    await expect(landingHeading(page)).toBeAttached();
    await expect(signInDialog(page)).toBeVisible();
    await expect(loggedOutToast(page)).toHaveCount(1);
  });
});
