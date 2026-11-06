/**
 * The map search takes focus on the first tap after the business drawer is
 * swiped away.
 *
 * The drawer used to have a half-height snap point: a slow swipe down parked
 * it there, still open and modal, so body had pointer-events: none and the
 * first tap on the search only closed the drawer. The snap point is gone, so
 * one swipe down closes it.
 *
 * Touch input throughout (tap, CDP touch drag). The map needs a signed-in
 * user, so the sandbox mock session (honoured on localhost only) is used.
 * Businesses are mocked and the map is moved to zoom 17, where each has its
 * own pin (helpers/mapMocks.ts).
 */
import { test, expect, type Page } from './helpers/fixtures';
import { NEARBY_BUSINESSES, mockMap, zoomToPins } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const search = (page: Page) => page.locator('input[aria-label="Search businesses"]');
const drawer = (page: Page) => page.locator('[role="dialog"]');

async function openMap(page: Page, scheme: 'light' | 'dark') {
  await mockMap(page, NEARBY_BUSINESSES, { storage: { colorScheme: scheme } });
  await page.goto('/');
  await expect(search(page)).toBeVisible();
  await page.waitForLoadState('networkidle');
}

// Taps by coordinates: the map may still be easing, so markers aren't "stable"
async function tapCentre(page: Page, selector: string) {
  const box = (await page.locator(selector).first().boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function openDrawer(page: Page) {
  await zoomToPins(page, NEARBY_BUSINESSES);
  await tapCentre(page, `img.leaflet-marker-icon[alt="${NEARBY_BUSINESSES[0]!.name}"]`);
  // A pin tap shows the card strip; its first card (the tapped business) opens the drawer
  await tapCentre(page, '[data-strip-card] p');
  await expect(drawer(page)).toBeVisible();
  await page.waitForTimeout(800);
}

// One unhurried swipe down from the drag handle (~0.8px/ms, 300px)
async function swipeDrawerDown(page: Page) {
  const box = (await drawer(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y0 = box.y + 8;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + i * 25 }] });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function expectSearchFocusedOnFirstTap(page: Page) {
  await tapCentre(page, 'input[aria-label="Search businesses"]');
  await expect(search(page)).toBeFocused();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} mode`, () => {
    test('fresh load: first tap focuses the search', async ({ page }) => {
      await openMap(page, scheme);
      await expectSearchFocusedOnFirstTap(page);
    });

    test('drawer closed with its Close button: first tap focuses the search', async ({ page }) => {
      await openMap(page, scheme);
      await openDrawer(page);
      await drawer(page).getByRole('button', { name: 'Close' }).first().tap();
      await expect(drawer(page)).toHaveCount(0);
      await expectSearchFocusedOnFirstTap(page);
    });

    test('one swipe down closes the drawer; first tap focuses the search', async ({ page }) => {
      await openMap(page, scheme);
      await openDrawer(page);
      await swipeDrawerDown(page);
      await expect(drawer(page)).toHaveCount(0);
      // Closing a drawer opened from a card returns to the card strip
      await expect(page.locator('[data-map-strip]')).toBeVisible();
      await expectSearchFocusedOnFirstTap(page);
    });

    test('swipe the drawer away, tap Locate, then the search', async ({ page }) => {
      await openMap(page, scheme);
      await openDrawer(page);
      await swipeDrawerDown(page);
      await expect(drawer(page)).toHaveCount(0);
      await tapCentre(page, 'button[aria-label="Show my location"]');
      await page.waitForTimeout(800);
      await expectSearchFocusedOnFirstTap(page);
    });
  });
}
