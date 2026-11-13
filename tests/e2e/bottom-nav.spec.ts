/**
 * Navigation: CommuniCon is a bottom-nav tab (Wallet moved to the side menu).
 * The CommuniCon page itself hides the bottom nav; its header has a back arrow
 * instead of ☰ (to the map when there's no earlier page in the app).
 * On phones the side menu shows Wallet but not CommuniCon (it's in the bottom
 * nav); the desktop side menu, with no bottom nav, lists both.
 *
 * Sandbox mock session; the map's outside calls are mocked.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test.beforeEach(async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await mockMap(page, NEARBY_BUSINESSES);
  });

  test('the bottom nav has CommuniCon and no Wallet; tapping it opens CommuniCon, without the nav', async ({ page }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation').last();
    await expect(nav.getByRole('link')).toHaveText(['Discover', 'Saved', 'Map', 'CommuniCon', 'Settings']);
    await expect(nav.getByRole('link', { name: 'Wallet' })).toHaveCount(0);

    await nav.getByRole('link', { name: 'CommuniCon' }).tap();
    await page.waitForURL('**/communicon');
    await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
    await expect(page.locator('nav.fixed')).toHaveCount(0);
  });

  test('CommuniCon has "Go back" (44x44) instead of the menu, title centred', async ({ page }) => {
    await page.goto('/communicon');
    await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
    const back = page.getByRole('button', { name: 'Go back' });
    await expect(back).toBeVisible();
    const box = (await back.boundingBox())!;
    expect(Math.round(box.width)).toBe(44);
    expect(Math.round(box.height)).toBe(44);
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
    const title = (await page.locator('#page-title').boundingBox())!;
    expect(Math.abs(title.x + title.width / 2 - 375 / 2)).toBeLessThanOrEqual(30);
  });

  test('map → CommuniCon tab → Go back returns to the map', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('navigation').last().getByRole('link', { name: 'CommuniCon' }).tap();
    await page.waitForURL('**/communicon');
    await page.getByRole('button', { name: 'Go back' }).tap();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });

  test('Discover → CommuniCon → Go back returns to Discover', async ({ page }) => {
    await page.goto('/recommendations');
    await page.getByRole('navigation').last().getByRole('link', { name: 'CommuniCon' }).tap();
    await page.waitForURL('**/communicon');
    await page.getByRole('button', { name: 'Go back' }).tap();
    await page.waitForURL('**/recommendations');
  });

  test('CommuniCon loaded directly: Go back lands on the map', async ({ page }) => {
    await page.goto('/communicon');
    await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
    await page.getByRole('button', { name: 'Go back' }).tap();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
    await expect(page.getByRole('navigation').last().getByRole('link', { name: 'Map' })).toBeVisible();
  });

  for (const width of [320, 375]) {
    test(`"CommuniCon" fits on one line at ${width}px without touching its neighbours`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto('/');
      await expect(page.getByRole('navigation').last().getByRole('link', { name: 'CommuniCon' })).toBeVisible();
      const labels = await page.getByRole('navigation').last().locator('a > span:last-child').evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent, left: r.left, right: r.right, height: r.height, lineHeight: parseFloat(getComputedStyle(el).lineHeight) || r.height };
        }),
      );
      const cc = labels.find((l) => l.text === 'CommuniCon')!;
      expect(cc.height).toBeLessThanOrEqual(cc.lineHeight + 1);
      for (let i = 1; i < labels.length; i++) expect(labels[i]!.left).toBeGreaterThanOrEqual(labels[i - 1]!.right);
    });
  }

  test('the mobile side menu shows Wallet and not CommuniCon', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).first().tap();
    const menu = page.getByRole('link', { name: 'Wallet' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('href', '/wallet');
    // Only the bottom nav's CommuniCon, none in the menu
    await expect(page.getByRole('link', { name: 'CommuniCon' })).toHaveCount(1);
    await expect(page.getByRole('navigation').last().getByRole('link', { name: 'CommuniCon' })).toHaveCount(1);
  });
});

test.describe('tablet (700px)', () => {
  test.use({ viewport: { width: 700, height: 900 } });

  test('the menu button opens the side menu', async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await mockMap(page, NEARBY_BUSINESSES);
    await page.goto('/settings');
    const menu = page.getByRole('button', { name: 'Open menu' }).filter({ visible: true });
    await expect(menu).toHaveCount(1);
    // The server-rendered page answers clicks once it has hydrated
    await expect(async () => {
      await menu.click();
      await expect(page.getByRole('link', { name: 'Wallet' })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the desktop side menu lists Wallet and CommuniCon', async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await mockMap(page, NEARBY_BUSINESSES);
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Wallet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'CommuniCon' })).toBeVisible();
    // No bottom nav on desktop
    await expect(page.locator('nav.fixed')).toHaveCount(0);
  });

  // Since #135 pages with a back button leave out the menu button, but that button never shows
  // at desktop width on any page. The sidebar's only collapse control is the keyboard shortcut
  // (no visible trigger anywhere in the app), and it works on CommuniCon too, so nothing is lost
  test('on CommuniCon the sidebar works, and the shortcut that collapses it brings it back', async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await page.goto('/settings');
    await expect(page.getByRole('link', { name: 'Wallet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' }).filter({ visible: true })).toHaveCount(0);

    await page.goto('/communicon');
    await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' }).filter({ visible: true })).toHaveCount(0);
    const wallet = page.getByRole('link', { name: 'Wallet' });
    await expect(wallet).toBeInViewport();

    await page.keyboard.press('Control+b');
    await expect(wallet).not.toBeInViewport();
    await page.keyboard.press('Control+b');
    await expect(wallet).toBeInViewport();

    await wallet.click();
    await page.waitForURL('**/wallet');
  });

  test('on CommuniCon the desktop side menu is still there', async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await page.goto('/communicon');
    await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Wallet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'CommuniCon' })).toBeVisible();
  });
});

// Task pages (fill something in, finish, leave) hide the bottom nav and show the back arrow;
// main destinations keep the nav
test.describe('task pages and main destinations at 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  // A fake Supabase session for pages that read the session user (Your businesses)
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const session = {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp, role: 'authenticated', aud: 'authenticated' })}.sig`,
    refresh_token: 'fake-refresh',
    expires_in: 3600,
    expires_at: exp,
    token_type: 'bearer',
    user: { id: mockUser.uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
  const OWNED = {
    id: 9601, business_name: 'Harbour Light Coffee', owner_id: mockUser.uid, category: 'Coffee Shop', business_description: 'Coffee by the harbour.',
    city: 'Cape Town', country: 'South Africa', images: [], is_verified: false, is_certified: false, verification_status: null, is_active: true,
    created_at: '2026-10-01T00:00:00Z', lat: -33.92, lng: 18.421, business_types: ['Food'], keywords: [], location: 'Cape Town',
    street_address: '12 Dock Road', state: 'Western Cape', zip_code: '8001', contact_info: { email: 'hello@harbour.example', phone: '+27215550123' },
  };

  test.beforeEach(async ({ page }) => {
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
    await page.route('**/rest/v1/businesses*', (route) => route.fulfill({ json: [OWNED] }));
    await mockMap(page, NEARBY_BUSINESSES);
    await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  });

  const nav = (page: Page) => page.locator('nav.fixed');
  const back = (page: Page) => page.getByRole('button', { name: 'Go back' });

  async function expectTaskPage(page: Page) {
    await expect(back(page)).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);
  }

  // Scrolls to the very end, then checks the button is on screen and nothing covers it
  async function expectReachableAtBottom(page: Page, button: ReturnType<Page['locator']>) {
    await button.scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const main = document.querySelector('main');
      if (main) main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(300);
    const box = (await button.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(812);
    const hit = await button.evaluate((el) => {
      // A disabled button (Submit before a rating) has pointer-events: none; check what's on top of it
      (el as HTMLElement).style.pointerEvents = 'auto';
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && (top === el || el.contains(top));
    });
    expect(hit).toBe(true);
  }

  for (const path of ['/pricing', '/verification-info', '/analytics', '/review/9601']) {
    test(`${path}: no bottom nav, Go back, no menu`, async ({ page }) => {
      await page.goto(path);
      await expectTaskPage(page);
    });
  }

  test('/update-registration (from Your businesses → Edit): no bottom nav, Go back, Save reachable in a section', async ({ page }) => {
    await page.goto('/registered-business');
    await page.getByRole('button', { name: 'Edit' }).first().tap();
    await page.waitForURL('**/update-registration/9601');
    await expectTaskPage(page);
    await page.getByRole('link', { name: /^Hours/ }).tap();
    await page.waitForURL('**/update-registration/9601/hours');
    await expectTaskPage(page);
    await expectReachableAtBottom(page, page.getByRole('button', { name: 'Save', exact: true }));
  });

  test('/review: the header has the only back control, and Submit Review is reachable', async ({ page }) => {
    await page.goto('/review/9601');
    await expect(page.getByText('Harbour Light Coffee').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Back$/ })).toHaveCount(0);
    await expect(page.locator('#page-title')).toHaveText('Write a Review');
    await expectReachableAtBottom(page, page.getByRole('button', { name: /Submit Review|Update Review/ }));
  });

  for (const path of ['/', '/recommendations', '/bookmarks', '/settings', '/wallet', '/notifications', '/registered-business', '/about']) {
    test(`${path} keeps the bottom nav`, async ({ page }) => {
      await page.goto(path);
      await expect(nav(page)).toBeVisible();
    });
  }

  test('Wallet → Pricing (from the menu) → Go back returns to Wallet', async ({ page }) => {
    await page.goto('/wallet');
    await expect(nav(page)).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).first().tap();
    await page.getByRole('link', { name: 'Plans and pricing', exact: true }).tap();
    await page.waitForURL('**/pricing');
    await back(page).tap();
    await page.waitForURL('**/wallet');
  });

  test('/pricing loaded directly: Go back lands on the map (one back control)', async ({ page }) => {
    await page.goto('/pricing');
    await expect(back(page)).toHaveCount(1);
    // The server-rendered page answers taps once it has hydrated (slow on a cold dev server)
    await expect(async () => {
      await back(page).tap();
      await expect(page).toHaveURL(/localhost:\d+\/$/, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
  });
});
