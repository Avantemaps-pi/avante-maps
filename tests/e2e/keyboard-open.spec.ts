/**
 * Bottom-anchored controls hide while the on-screen keyboard is open.
 *
 * Pi Browser shrinks the whole window when the keyboard opens, so the bottom
 * nav, Register business FAB, zoom group and Locate button rode up over the
 * map and search field. useKeyboardOpen() reports the keyboard as open only
 * when a text field is focused AND the viewport has shrunk by 150px+, so the
 * keyboard is simulated here by focusing a field and shrinking the viewport.
 *
 * The map needs a signed-in user, so the sandbox mock session (honoured on
 * localhost only) is used, as in reauth-false-success.spec.ts.
 */
import { test, expect, type Page, type Locator } from './helpers/fixtures';

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

const PHONE = { width: 375, height: 812 };
const WITH_KEYBOARD = { width: 375, height: 450 };

test.use({ viewport: PHONE });

test.beforeEach(async ({ page }) => {
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route('https://ipwho.is/**', (route) =>
    route.fulfill({ json: { success: true, latitude: 48.8566, longitude: 2.3522 } }),
  );
  await page.addInitScript(
    ([mockKey, storageKey, user]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(
        storageKey as string,
        JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }),
      );
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser],
  );
});

const nav = (page: Page) => page.locator('nav:has(a[aria-label="Map"])');
const fab = (page: Page) => page.locator('[data-add-business-button]');
const zoom = (page: Page) => page.locator('div:has(> div > button[aria-label="Zoom in"])');
const locate = (page: Page) => page.locator('button[aria-label="Show my location"]');
const search = (page: Page) => page.getByRole('textbox', { name: 'Search businesses' });
const chips = (page: Page) => page.getByRole('tablist', { name: 'Filter businesses by category' });

// Hidden = faded out (or slid below the viewport), inside an inert subtree and not focusable
const hiddenState = (el: Locator) =>
  el.evaluate((node) => {
    const target = (node.querySelector('button, a') as HTMLElement | null) ?? (node as HTMLElement);
    const before = document.activeElement;
    target.focus();
    const focusable = document.activeElement === target;
    (before as HTMLElement | null)?.focus?.();
    const rect = node.getBoundingClientRect();
    return {
      gone: getComputedStyle(node).opacity === '0' || rect.top >= window.innerHeight,
      inert: !!node.closest('[inert]'),
      focusable,
    };
  });

async function expectHidden(el: Locator) {
  await expect.poll(() => hiddenState(el)).toEqual({ gone: true, inert: true, focusable: false });
}

async function expectShown(el: Locator) {
  await expect
    .poll(async () => {
      const { gone, inert } = await hiddenState(el);
      return { gone, inert };
    })
    .toEqual({ gone: false, inert: false });
}

async function openMap(page: Page) {
  await page.goto('/');
  for (const el of [nav(page), fab(page), zoom(page), locate(page)]) {
    await expect(el.first()).toBeVisible();
  }
  // FAB settles from its loading state once the business count resolves
  await page.waitForLoadState('networkidle');
}

const mapControls = (page: Page) => [nav(page), fab(page).first(), zoom(page), locate(page)];

test('keyboard open on map search hides bottom controls; search and chips stay put', async ({ page }) => {
  await openMap(page);
  const searchBox = await search(page).boundingBox();
  const chipsBox = await chips(page).boundingBox();

  await search(page).focus();
  await page.setViewportSize(WITH_KEYBOARD);
  for (const el of mapControls(page)) await expectHidden(el);
  await expect(search(page)).toBeFocused();
  expect(await search(page).boundingBox()).toEqual(searchBox);
  expect(await chips(page).boundingBox()).toEqual(chipsBox);

  // Android Back: keyboard closes, input keeps focus
  await page.setViewportSize(PHONE);
  await expect(search(page)).toBeFocused();
  for (const el of mapControls(page)) await expectShown(el);

  // Blur: stays visible
  await search(page).blur();
  for (const el of mapControls(page)) await expectShown(el);
});

test('keyboard open: OSM attribution fades out and comes back where it was', async ({ page }) => {
  await openMap(page);
  const attribution = page.locator('.leaflet-control-attribution');
  await expect(attribution).toBeVisible();
  const before = (await attribution.boundingBox())!;
  const style = () =>
    attribution.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { opacity: cs.opacity, pointerEvents: cs.pointerEvents };
    });

  await search(page).focus();
  await page.setViewportSize(WITH_KEYBOARD);
  await expect.poll(style).toEqual({ opacity: '0', pointerEvents: 'none' });

  // Keyboard closed: visible again, in its usual spot above the bottom nav
  await page.setViewportSize(PHONE);
  await expect.poll(style).toEqual({ opacity: '1', pointerEvents: 'auto' });
  const after = (await attribution.boundingBox())!;
  expect(after).toEqual(before);
  expect(PHONE.height - (after.y + after.height)).toBeGreaterThan(64);
});

test('focus without a shrinking viewport (hardware keyboard) hides nothing', async ({ page }) => {
  await openMap(page);
  await search(page).focus();
  await page.waitForTimeout(500);
  for (const el of mapControls(page)) await expectShown(el);
});

test('rotation does not leave controls stuck hidden', async ({ page }) => {
  await openMap(page);
  const rotate = async (size: { width: number; height: number }) => {
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await page.setViewportSize(size);
  };
  // The bottom nav only renders below 768px wide, so landscape checks the map controls
  const mapOnly = () => [fab(page).first(), zoom(page), locate(page)];

  await rotate({ width: 812, height: 375 });
  for (const el of mapOnly()) await expectShown(el);
  await rotate(PHONE);
  for (const el of mapControls(page)) await expectShown(el);

  // Rotating with the search focused is not mistaken for a keyboard
  await search(page).focus();
  await rotate({ width: 812, height: 375 });
  await page.waitForTimeout(300);
  for (const el of mapOnly()) await expectShown(el);
  await rotate(PHONE);
  await page.waitForTimeout(1_100);
  for (const el of mapControls(page)) await expectShown(el);

  // And the keyboard is still detected afterwards
  await page.setViewportSize(WITH_KEYBOARD);
  for (const el of mapControls(page)) await expectHidden(el);
});

test('FAB speed dial closes when the keyboard opens', async ({ page }) => {
  await page.addInitScript(() => {
    // Over 24h since first visit: collapsed FAB with a speed dial
    localStorage.setItem('fab_first_visit', new Date(Date.now() - 2 * 86_400_000).toISOString());
  });
  await openMap(page);
  const dial = page.getByRole('button', { name: 'Open quick actions' });
  await dial.click();
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();

  await search(page).focus();
  await page.setViewportSize(WITH_KEYBOARD);
  await expectHidden(fab(page).first());
  await page.setViewportSize(PHONE);
  await expect(dial).toBeVisible();
  await expect(dial).toHaveAttribute('aria-expanded', 'false');
});

test('quick actions open: the scrim dims the bottom nav, and tapping it closes the dial', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('fab_first_visit', new Date(Date.now() - 2 * 86_400_000).toISOString());
  });
  await openMap(page);
  const dial = page.getByRole('button', { name: 'Open quick actions' });
  await dial.click();
  const close = fab(page).getByRole('button', { name: 'Close menu' });
  await expect(close).toBeVisible();

  const topAt = (selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return hit === el || el.contains(hit) ? 'self' : String(hit?.className ?? '');
    });
  // Nav sits under the scrim; the dial's actions and × stay above it
  expect(await topAt('nav a[aria-label="Settings"]')).toContain('bg-overlay');
  expect(await topAt('[data-add-business-button] button[aria-label="CommuniCon"]')).toBe('self');
  expect(await topAt('[data-add-business-button] button[aria-label="Close menu"]')).toBe('self');

  const settings = (await page.locator('nav a[aria-label="Settings"]').boundingBox())!;
  await page.mouse.click(settings.x + settings.width / 2, settings.y + settings.height / 2);
  await expect(dial).toHaveAttribute('aria-expanded', 'false');
  expect(new URL(page.url()).pathname).toBe('/');
});

test('quick actions open: the zoom group stays where it was', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('fab_first_visit', new Date(Date.now() - 2 * 86_400_000).toISOString());
  });
  await openMap(page);
  const zoomGroup = zoom(page);
  await page.waitForTimeout(500);
  const before = await zoomGroup.boundingBox();

  await page.getByRole('button', { name: 'Open quick actions' }).click();
  await expect(fab(page).getByRole('button', { name: 'Close menu' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(await zoomGroup.boundingBox()).toEqual(before);
});

test('Contact message box with the keyboard open hides the bottom nav', async ({ page }) => {
  await page.goto('/contact');
  await expect(nav(page)).toBeVisible();
  await page.waitForLoadState('networkidle');
  const message = page.locator('textarea#message');
  // The nav also hides on scroll-down, so bring the box into view and scroll
  // up a little (nav shown) before focusing without scrolling.
  await message.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollBy(0, -20));
  await expectShown(nav(page));
  const scrollY = await page.evaluate(() => window.scrollY);
  await message.evaluate((el: HTMLTextAreaElement) => el.focus({ preventScroll: true }));

  await page.setViewportSize(WITH_KEYBOARD);
  await expectHidden(nav(page));
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await page.setViewportSize(PHONE);
  await expectShown(nav(page));
});
