/**
 * After every navigation AppLayout moves focus to #page-title so screen
 * readers announce the new page. The title is tabIndex=-1 and never a
 * control, so it shows no focus ring (it used to draw a blue box on every
 * page change on phones). Real controls keep their rings.
 *
 * Touch input at 375x812 with the sandbox mock session; every request to the
 * Supabase project is answered locally.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES } from './helpers/mapMocks';

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const focusedElement = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      id: el.id,
      tag: el.tagName,
      text: el.textContent?.trim().slice(0, 40) ?? '',
      outlineStyle: cs.outlineStyle,
      outlineWidth: parseFloat(cs.outlineWidth),
      outlineColour: cs.outlineColor,
      boxShadow: cs.boxShadow,
    };
  });

async function expectTitleFocusedWithoutRing(page: Page, title: string) {
  await expect(page.locator('#page-title')).toHaveText(title);
  await expect.poll(async () => (await focusedElement(page))?.id).toBe('page-title');
  expect((await focusedElement(page))?.outlineStyle).toBe('none');
}

test('the page title takes focus after each navigation, with no ring; Tab still reaches a ringed control', async ({ page }) => {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await mockMap(page, NEARBY_BUSINESSES);
  await page.goto('/');
  await expect(page.locator('.leaflet-marker-icon').first()).toBeAttached();
  await page.waitForLoadState('networkidle');

  const nav = page.getByRole('navigation').last();
  await nav.getByRole('link', { name: 'Discover' }).tap();
  await expectTitleFocusedWithoutRing(page, 'Discover');

  await nav.getByRole('link', { name: 'Saved' }).tap();
  await expectTitleFocusedWithoutRing(page, 'Saved');

  await page.getByRole('button', { name: 'Open menu' }).first().tap();
  await page.getByRole('link', { name: 'CommuniCon' }).first().tap();
  await expectTitleFocusedWithoutRing(page, 'CommuniCon');

  // Keyboard users still see where they are
  await page.keyboard.press('Tab');
  const next = (await focusedElement(page))!;
  expect(next.id).not.toBe('page-title');
  const outline = next.outlineStyle !== 'none' && next.outlineWidth > 0 && !next.outlineColour.endsWith(', 0)');
  const ring = next.boxShadow !== 'none';
  expect(outline || ring, JSON.stringify(next)).toBe(true);
});

test('the other focus targets show no ring: <main> on the map, the registration step title', async ({ page }) => {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('https://ipwho.is/**', (route) => route.abort());
  await mockMap(page, NEARBY_BUSINESSES);
  await page.goto('/recommendations');
  await expectTitleFocusedWithoutRing(page, 'Discover');

  // The map has no header title: AppLayout falls back to <main>
  await page.getByRole('navigation').last().getByRole('link', { name: 'Map' }).tap();
  await expect.poll(async () => (await focusedElement(page))?.id).toBe('main-content');
  expect((await focusedElement(page))?.outlineStyle).toBe('none');

  // RegisterStepper's step title is the other #page-title (opened from the map's + button)
  await page.locator('a[href="/registration"]').first().tap();
  await expectTitleFocusedWithoutRing(page, 'About your business');
});
