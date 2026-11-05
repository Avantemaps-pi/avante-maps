/**
 * Regression tests for four small map and review bugs (25 Oct).
 *
 * 1. Opening /review/<id> directly redirected to "/" before the cached
 *    sign-in was restored.
 * 2. A search centred the map on a business the active category hides.
 * 3. The "Businesses near you" banner never showed, because the IP focus
 *    flag set on every sign-in suppressed it.
 * (4. is a text-only change in AppPreferences.tsx.)
 *
 * Touch input at 375x812. The business list is mocked through the
 * get_public_business_info RPC. Signed-in cases use the sandbox mock session
 * (honoured on localhost only), as in keyboard-open.spec.ts.
 */
import { test, expect, type Page } from './helpers/fixtures';

const SANDBOX_MOCK_KEY = 'avante_sandbox_mock_session';
const STORAGE_KEY = 'avante_maps_auth';

// Mirrors the loginAsSandbox() fallback user in AuthProvider.tsx.
const mockUser = {
  uid: '00000000-0000-0000-0000-000000000001',
  pi_uid: 'sandbox-mock-pi-uid',
  username: 'SandboxUser',
  walletAddress: 'sandbox-mock-wallet',
  roles: ['user'],
  accessToken: 'sandbox-mock-token',
  subscriptionTier: 'organization',
  businessCount: 0,
};

const business = (id: number, name: string, category: string, lat: number, lng: number) => ({
  id,
  name,
  category,
  business_types: [category],
  keywords: [],
  description: `${name} test listing`,
  latitude: lat,
  longitude: lng,
  images: [],
  contact_info: {},
  hours: {},
  city: 'Testville',
  country: 'Testland',
  is_verified: false,
  is_certified: false,
});

const BAKERY = business(9001, 'Sunrise Bakery', 'Food', 10, 10);
const GADGETS = business(9002, 'Zebra Gadgets', 'Technology', -20, 30);

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

type Setup = {
  signedIn?: boolean;
  // 'none': the browser has no Permissions API
  permission?: 'granted' | 'prompt' | 'denied' | 'none';
  storage?: Record<string, string>;
  session?: Record<string, string>;
};

async function setup(page: Page, opts: Setup = {}) {
  const { signedIn = true, permission = 'denied', storage = {}, session = {} } = opts;
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route('**/rest/v1/rpc/get_public_business_info*', (route) =>
    route.fulfill({ json: [BAKERY, GADGETS] }),
  );
  for (const url of ['https://ipwho.is/**', 'https://ipapi.co/json/', 'https://get.geojs.io/v1/ip/geo.json']) {
    await page.route(url, (route) =>
      route.fulfill({ json: { success: true, latitude: 48.8566, longitude: 2.3522 } }),
    );
  }
  await page.addInitScript(
    ([o, user, keys]) => {
      const { signedIn, permission, storage, session } = o as Required<Setup>;
      const [mockKey, storageKey] = keys as string[];
      const w = window as unknown as { __centers: number; __geoCalls: number };
      w.__centers = 0;
      w.__geoCalls = 0;
      if (!sessionStorage.getItem('__seeded')) {
        sessionStorage.setItem('__seeded', '1');
        localStorage.clear();
        if (signedIn) {
          localStorage.setItem(mockKey, '1');
          localStorage.setItem(storageKey, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }));
        }
        for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
        for (const [k, v] of Object.entries(session)) sessionStorage.setItem(k, v);
      }
      window.addEventListener('centerMap', () => { w.__centers += 1; });
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: permission === 'none' ? undefined : { query: async () => ({ state: permission }) },
      });
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) => {
            w.__geoCalls += 1;
            setTimeout(() => ok({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 10 } }), 100);
          },
          watchPosition: () => 0,
          clearWatch: () => {},
        },
      });
    },
    [{ signedIn, permission, storage, session }, mockUser, [SANDBOX_MOCK_KEY, STORAGE_KEY]] as const,
  );
}

const counters = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __centers: number; __geoCalls: number };
    return { centers: w.__centers, geoCalls: w.__geoCalls };
  });

const search = (page: Page) => page.locator('input[aria-label="Search businesses"]');

async function openMap(page: Page) {
  await page.goto('/');
  await expect(search(page)).toBeVisible();
  await expect(page.locator('.leaflet-marker-icon')).toHaveCount(2);
  await page.waitForLoadState('networkidle');
}

test.describe('1. review link opened directly', () => {
  test('signed in: the review form shows and the URL stays', async ({ page }) => {
    await setup(page);
    await page.goto(`/review/${BAKERY.id}`);
    await expect(page.getByRole('tab', { name: 'Write Review' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(BAKERY.name).first()).toBeVisible();
    await page.waitForTimeout(3_500);
    expect(new URL(page.url()).pathname).toBe(`/review/${BAKERY.id}`);
  });

  test('signed out: sign-in prompt, no redirect', async ({ page }) => {
    await setup(page, { signedIn: false });
    await page.goto(`/review/${BAKERY.id}`);
    await expect(page.getByText('Sign in to write a review')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Sign in with Pi' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/review/${BAKERY.id}`);
  });
});

test.describe('2. search with a category active', () => {
  test('a match the category hides does not move the map; its suggestion resets the category', async ({ page }) => {
    await setup(page);
    await openMap(page);
    await page.getByRole('tab', { name: /Food/ }).tap();
    await expect(page.getByRole('tab', { name: /Food/ })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(500);
    const before = (await counters(page)).centers;

    await search(page).tap();
    await search(page).pressSequentially('Zebra', { delay: 50 });
    await page.waitForTimeout(1_000);
    expect((await counters(page)).centers).toBe(before);

    const suggestion = page.getByRole('button', { name: /Zebra Gadgets/ });
    await expect(suggestion).toBeVisible();
    await suggestion.tap();
    // CSS locator: the open (modal) drawer hides the chips from role queries
    const allChip = page.locator('[role="tab"]').filter({ hasText: 'All' });
    await expect(allChip).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(GADGETS.name).first()).toBeVisible();
  });
});

test.describe('3. "Businesses near you" banner', () => {
  const banner = (page: Page) => page.getByText('Businesses near you');

  test('permission "prompt": shows despite the IP focus flag; Allow asks for GPS once; never again', async ({ page }) => {
    await setup(page, { permission: 'prompt', session: { ip_location_focused: '1' } });
    await openMap(page);
    await expect(banner(page)).toBeVisible({ timeout: 6_000 });
    const before = (await counters(page)).geoCalls;

    await page.getByRole('button', { name: 'Allow' }).tap();
    await expect(banner(page)).toHaveCount(0);
    await expect.poll(async () => (await counters(page)).geoCalls - before).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('location_banner_seen'))).toBe('1');

    await page.reload();
    await expect(search(page)).toBeVisible();
    await page.waitForTimeout(3_500);
    await expect(banner(page)).toHaveCount(0);
  });

  test('no Permissions API: shows once; Allow and it does not return', async ({ page }) => {
    await setup(page, { permission: 'none' });
    await openMap(page);
    await expect(banner(page)).toBeVisible({ timeout: 6_000 });
    await page.getByRole('button', { name: 'Allow' }).tap();
    await expect(banner(page)).toHaveCount(0);

    await page.reload();
    await expect(search(page)).toBeVisible();
    await page.waitForTimeout(3_500);
    await expect(banner(page)).toHaveCount(0);
  });

  test('no Permissions API: dismissed with ✕, it does not return', async ({ page }) => {
    await setup(page, { permission: 'none' });
    await openMap(page);
    await expect(banner(page)).toBeVisible({ timeout: 6_000 });
    await page.getByRole('button', { name: 'Dismiss' }).tap();
    await expect(banner(page)).toHaveCount(0);

    await page.reload();
    await expect(search(page)).toBeVisible();
    await page.waitForTimeout(3_500);
    await expect(banner(page)).toHaveCount(0);
  });

  test('no Permissions API, Locate already asked: no banner', async ({ page }) => {
    await setup(page, { permission: 'none', storage: { geolocation_prompted: '1' } });
    await openMap(page);
    await page.waitForTimeout(3_500);
    await expect(banner(page)).toHaveCount(0);
  });

  test('permission "granted": no banner', async ({ page }) => {
    await setup(page, { permission: 'granted' });
    await openMap(page);
    await page.waitForTimeout(3_500);
    await expect(banner(page)).toHaveCount(0);
  });

  test('"Use my location" off: no banner', async ({ page }) => {
    await setup(page, { permission: 'prompt', storage: { use_location_focus: '0' } });
    await openMap(page);
    await page.waitForTimeout(3_500);
    await expect(banner(page)).toHaveCount(0);
  });
});
