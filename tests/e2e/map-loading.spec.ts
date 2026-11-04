/**
 * While the map's businesses load, the search bar shows it: a spinner for the magnifier and
 * "Loading businesses…" as the placeholder. There's no floating pill, and the round button waits.
 *
 * 375x812 with mocked map data. The business list is held until the test releases it.
 */
import { test, expect, type Page } from '@playwright/test';
import { mockMap, NEARBY_BUSINESSES } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const OLD_VISIT = '2020-01-01T00:00:00.000Z';

async function holdBusinesses(page: Page, storage: Record<string, string> = {}) {
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await mockMap(page, NEARBY_BUSINESSES, { storage });
  await page.route('**/rest/v1/rpc/get_public_business_info*', async (route) => {
    await held;
    await route.fallback();
  });
  return release;
}

const search = (page: Page) => page.locator('input[aria-label="Search businesses"]');
const bar = (page: Page) => page.locator('[data-search-bar]');
const spinner = (page: Page) => bar(page).locator('svg.lucide-loader-circle');
const magnifier = (page: Page) => bar(page).locator('svg.lucide-search');
const status = (page: Page) => bar(page).getByRole('status');
const fab = (page: Page) => page.locator('[data-add-business-fab]');
const zoomIn = (page: Page) => page.getByRole('button', { name: 'Zoom in' });

async function expectLoading(page: Page) {
  await expect(search(page)).toHaveAttribute('placeholder', 'Loading businesses…');
  await expect(spinner(page)).toBeVisible();
  await expect(magnifier(page)).toHaveCount(0);
  await expect(status(page)).toHaveText('Loading businesses…');
}

async function expectLoaded(page: Page) {
  await expect(search(page)).toHaveAttribute('placeholder', 'Search businesses');
  await expect(magnifier(page)).toBeVisible();
  await expect(spinner(page)).toHaveCount(0);
  await expect(status(page)).toHaveText('');
}

test('while loading: the search bar says so, with no pill and no button', async ({ page }) => {
  await holdBusinesses(page);
  await page.goto('/');
  await expectLoading(page);
  // The status text is for screen readers: only the placeholder and this are left on screen
  await expect(page.getByText('Loading businesses…')).toHaveCount(1);
  await expect(status(page)).toHaveClass(/sr-only/);
  await expect(spinner(page)).toHaveClass(/text-primary/);
  // Its CSS size: a rotating icon's bounding box is bigger
  await expect(spinner(page)).toHaveCSS('width', '18px');
  await expect(spinner(page)).toHaveCSS('height', '18px');
  await expect(fab(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Loading' })).toHaveCount(0);
  // It stays labelled as the search box
  await expect(page.getByRole('textbox', { name: 'Search businesses' })).toBeVisible();
});

test('after loading: the magnifier and placeholder come back, and the button appears', async ({ page }) => {
  const release = await holdBusinesses(page);
  await page.goto('/');
  await expectLoading(page);
  release();
  await expectLoaded(page);
  await expect(fab(page)).toBeVisible();
  await expect(fab(page)).toHaveAttribute('aria-label', 'Register a business');
});

test('after loading, on a later visit: the round button appears', async ({ page }) => {
  const release = await holdBusinesses(page, { fab_first_visit: OLD_VISIT });
  await page.goto('/');
  await expectLoading(page);
  await expect(fab(page)).toHaveCount(0);
  release();
  await expect(fab(page)).toHaveAttribute('aria-label', 'Open quick actions');
  await expect(fab(page)).toBeVisible();
  await expectLoaded(page);
});

test('typing while loading works, and what was typed stays when loading ends', async ({ page }) => {
  const release = await holdBusinesses(page);
  await page.goto('/');
  await expectLoading(page);
  await search(page).click();
  await page.keyboard.type('Harb');
  await expect(search(page)).toHaveValue('Harb');
  await expect(spinner(page)).toBeVisible();
  release();
  await expectLoaded(page);
  await expect(search(page)).toHaveValue('Harb');
});

test('the zoom buttons stay where they are when the button appears', async ({ page }) => {
  const release = await holdBusinesses(page, { fab_first_visit: OLD_VISIT });
  await page.goto('/');
  await expectLoading(page);
  await expect(zoomIn(page)).toBeVisible();
  await expect.poll(async () => Math.round((await zoomIn(page).boundingBox())!.y)).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const before = (await zoomIn(page).boundingBox())!;
  release();
  await expect(fab(page)).toBeVisible();
  await page.waitForTimeout(500);
  const after = (await zoomIn(page).boundingBox())!;
  expect(Math.round(after.y)).toBe(Math.round(before.y));
  expect(Math.round(after.x)).toBe(Math.round(before.x));
  // And clear of the button
  expect(after.y + after.height).toBeLessThan((await fab(page).boundingBox())!.y);
});

// Records the first animation seen on the button's wrapper, from the moment it appears
async function recordFabAnimation(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __fabAnimation?: number | 'none' };
    const check = () => {
      const fabEl = document.querySelector('[data-add-business-fab]');
      if (fabEl) {
        const wrapper = fabEl.closest('[data-add-business-button]')!;
        const animation = wrapper.getAnimations().find((a) => (a as CSSAnimation).animationName === 'enter');
        w.__fabAnimation = animation ? Number(animation.effect!.getTiming().duration) : 'none';
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}
const fabAnimation = (page: Page) => page.evaluate(() => (window as unknown as { __fabAnimation?: number | 'none' }).__fabAnimation);

for (const [name, storage, label] of [
  ['the Register pill', {}, 'Register a business'],
  ['the round +', { fab_first_visit: OLD_VISIT }, 'Open quick actions'],
] as const) {
  test(`${name} fades in over 150ms, and ends fully opaque`, async ({ page }) => {
    await recordFabAnimation(page);
    const release = await holdBusinesses(page, storage);
    await page.goto('/');
    await expectLoading(page);
    release();
    await expect(fab(page)).toHaveAttribute('aria-label', label);
    await expect.poll(() => fabAnimation(page)).toBe(150);
    await expect(page.locator('[data-add-business-button]').first()).toHaveCSS('opacity', '1');
  });
}

test('reduced motion: the spinner stays still, and the button appears with no fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await recordFabAnimation(page);
  const release = await holdBusinesses(page);
  await page.goto('/');
  await expectLoading(page);
  await expect(spinner(page)).toHaveCSS('animation-name', 'none');
  release();
  await expect(fab(page)).toBeVisible();
  await expect.poll(() => fabAnimation(page)).toBe('none');
});

test('with motion: the spinner spins', async ({ page }) => {
  await holdBusinesses(page);
  await page.goto('/');
  await expectLoading(page);
  await expect(spinner(page)).toHaveCSS('animation-name', 'spin');
});

test('if loading fails: the search bar goes back to normal and the error card shows', async ({ page }) => {
  await mockMap(page, NEARBY_BUSINESSES);
  await page.route('**/rest/v1/rpc/get_public_business_info*', (route) => route.fulfill({ status: 500, json: { message: 'boom' } }));
  await page.goto('/');
  await expect(page.getByText("Couldn't load businesses")).toBeVisible({ timeout: 30_000 });
  await expectLoaded(page);
});

test('the keyboard still hides the button after it has faded in', async ({ page }) => {
  const release = await holdBusinesses(page, { fab_first_visit: OLD_VISIT });
  await page.goto('/');
  await expectLoading(page);
  release();
  await expect(fab(page)).toBeVisible();
  await page.waitForTimeout(300);
  // What the keyboard-open spec does: a shrinking visual viewport with the search box focused
  await search(page).click();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 400 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect(page.locator('[data-add-business-button]').first()).toHaveCSS('opacity', '0');
});
