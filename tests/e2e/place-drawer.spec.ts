/**
 * Photo-first business drawer (PlaceOverlay).
 *
 * Layout: photo edge to edge under the handle with Close and Save floated
 * over it, title block, description clamped with "Read more", info rows, and
 * the action row in a footer that stays put while the body scrolls.
 * Behaviour kept from #108: a swipe on the photo doesn't close the drawer, a
 * swipe down elsewhere does.
 *
 * Touch input at 375x812. The business list is mocked through the
 * get_public_business_info RPC; the map needs a signed-in user, so the
 * sandbox mock session (honoured on localhost only) is used. Both come from
 * helpers/mapMocks.ts.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, mockUser } from './helpers/mapMocks';

const photo = (n: number) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#1E3A8A"/><text x="400" y="270" font-size="56" fill="#fff" text-anchor="middle">Photo ${n}</text></svg>`,
  );
const open = (o: string, c: string) => ({ open: o, close: c, closed: false });
const everyDay = (value: object) =>
  Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, value]));

const base = {
  keywords: [],
  latitude: 10,
  longitude: 10,
  contact_info: {},
  hours: null,
  images: [],
  city: 'Cape Town',
  country: 'South Africa',
  is_verified: false,
  is_certified: false,
  verification_status: null,
  description: '',
};

const FULL = {
  ...base,
  id: 9201,
  name: 'Harbour Light Coffee Roasters',
  category: 'Coffee Shop',
  business_types: ['Coffee Shop'],
  images: [photo(1), photo(2), photo(3), photo(4)],
  // Same hours every day, so "Today …" doesn't depend on the weekday
  hours: everyDay(open('07:00', '17:00')),
  contact_info: { phone: '+27 21 555 0123', email: 'hello@harbourlight.example' },
  description:
    'Small-batch coffee roasted every morning on the harbour. We accept Pi for every order, from a single espresso to a kilo of beans to take home.\n\nSeating for twelve inside, a bench outside, and free Wi-Fi. Ask about our weekly cupping sessions on Saturday mornings.',
};
const EMPTY = { ...base, id: 9202, name: 'Mzansi Mobile Repairs', category: 'Services', business_types: ['Services'] };
const CLOSED = {
  ...base,
  id: 9203,
  name: 'Table Bay Bookshop',
  category: 'Retail',
  business_types: ['Retail'],
  hours: everyDay({ closed: true }),
  description: 'New and second-hand books.',
};

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const drawer = (page: Page) => page.locator('[role="dialog"]');
const body = (page: Page) => drawer(page).locator('.overflow-y-auto').first();

async function openDrawer(page: Page, row: object) {
  await mockMap(page, [row], { centre: { lat: 10, lng: 10 } });
  await page.goto('/');
  const marker = page.locator('.leaflet-marker-icon').first();
  await marker.waitFor({ state: 'attached' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_500);
  const box = (await marker.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  // A pin tap shows the card strip; its first card (the tapped business) opens the drawer
  const card = (await page.locator('[data-strip-card] p').first().boundingBox())!;
  await page.touchscreen.tap(card.x + card.width / 2, card.y + card.height / 2);
  await expect(drawer(page)).toBeVisible();
  await page.waitForTimeout(900);
}

// Unhurried touch drag straight down from (x, y)
async function swipeDown(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 25 }] });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(900);
}

test('photo first, edge to edge, with Close and Save floated over it', async ({ page }) => {
  await openDrawer(page, FULL);
  const d = (await drawer(page).boundingBox())!;
  const gallery = (await drawer(page).locator('[data-vaul-no-drag]').boundingBox())!;
  const title = (await drawer(page).getByRole('heading', { name: FULL.name }).boundingBox())!;
  expect(gallery.x).toBe(d.x);
  expect(gallery.width).toBe(d.width);
  expect(Math.round(gallery.height)).toBe(248);
  expect(gallery.y).toBeLessThan(title.y);

  const close = (await drawer(page).getByRole('button', { name: 'Close' }).boundingBox())!;
  const save = (await drawer(page).getByRole('button', { name: 'Save business' }).boundingBox())!;
  expect(Math.round(close.x - gallery.x)).toBe(12);
  expect(Math.round(close.y - gallery.y)).toBe(12);
  expect(Math.round(gallery.x + gallery.width - (save.x + save.width))).toBe(12);
  expect(Math.round(save.y - gallery.y)).toBe(12);
  expect([close.width, save.width]).toEqual([44, 44]);

  // Counter sits bottom-right, clear of Save
  const counter = (await drawer(page).getByText('1 / 4').boundingBox())!;
  expect(counter.y).toBeGreaterThan(gallery.y + gallery.height / 2);
});

test('summary line shows the category and today’s hours', async ({ page }) => {
  await openDrawer(page, FULL);
  await expect(drawer(page).getByText('Coffee Shop · Today 07:00–17:00', { exact: true })).toBeVisible();
});

test('hours rows show closed days as "Closed"', async ({ page }) => {
  await openDrawer(page, {
    ...base,
    id: 9204,
    name: 'Sea Point Bakery',
    category: 'Food',
    business_types: ['Food'],
    hours: { ...everyDay(open('07:00', '17:00')), monday: { closed: true } },
  });
  await expect(drawer(page).getByText('Mon Closed', { exact: true })).toBeVisible();
  await expect(drawer(page).getByText('Tue–Sun 07:00–17:00', { exact: true })).toBeVisible();
});

test('closed today: summary says "Closed today"', async ({ page }) => {
  await openDrawer(page, CLOSED);
  await expect(drawer(page).getByText('Retail · Closed today', { exact: true })).toBeVisible();
});

test('no photos, hours or description: muted 248px block, category only, no Read more', async ({ page }) => {
  await openDrawer(page, EMPTY);
  const block = drawer(page).getByRole('img', { name: 'No photos yet' });
  await expect(block).toBeVisible();
  expect(Math.round((await block.boundingBox())!.height)).toBe(248);
  await expect(drawer(page).getByText('Services', { exact: true })).toBeVisible();
  await expect(drawer(page).getByRole('button', { name: 'Read more' })).toHaveCount(0);
});

test('Read more only when the description overflows, and it toggles', async ({ page }) => {
  await openDrawer(page, FULL);
  const more = drawer(page).getByRole('button', { name: 'Read more' });
  await expect(more).toBeVisible();
  await more.tap();
  await expect(drawer(page).getByRole('button', { name: 'Show less' })).toBeVisible();
});

test('the Message button opens that conversation, on Messages, even if Bot was the tab remembered', async ({ page }) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = { id: mockUser.uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const session = {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp, role: 'authenticated', aud: 'authenticated' })}.sig`,
    refresh_token: 'fake-refresh',
    expires_in: 3600,
    expires_at: exp,
    token_type: 'bearer',
    user,
  };
  const CONVERSATION = '11111111-1111-4111-8111-111111111111';
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: user }));
  await page.route('**/rest/v1/conversations*', (route) =>
    route.fulfill({
      json: [{ id: CONVERSATION, business_id: FULL.id, customer_id: mockUser.uid, last_message_at: '2026-11-04T09:00:00Z', last_message_preview: 'Hello there', customer_unread: 0, business_unread: 0 }],
    }),
  );
  // The drawer's owner check and bookmarks, the user row, and the business's name for the inbox
  await page.route('**/rest/v1/businesses*', (route) =>
    route.request().method() === 'HEAD' ? route.fulfill({ status: 200, headers: { 'content-range': '*/0' } }) : route.fulfill({ json: [] }),
  );
  await page.route('**/rest/v1/bookmarks*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/users*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/user_roles*', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/rpc/get_public_business_detail*', (route) => route.fulfill({ json: [{ id: FULL.id, name: FULL.name, images: [] }] }));
  await page.route('**/rest/v1/messages*', (route) =>
    route.fulfill({ json: [{ id: 'm1', conversation_id: CONVERSATION, sender_id: mockUser.uid, sender_role: 'customer', body: 'Hello there', read_at: null, created_at: '2026-11-04T09:00:00Z' }] }),
  );
  await page.addInitScript((s) => {
    localStorage.setItem('supabase.auth.token', JSON.stringify(s));
    sessionStorage.setItem('communicon-tab', 'ai');
  }, session);
  await openDrawer(page, FULL);
  await drawer(page).getByRole('button', { name: 'Message' }).tap();
  await page.waitForURL('**/communicon');
  await expect(page.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
  // The thread itself, not the inbox list
  await expect(page.getByRole('button', { name: 'Back to conversations' })).toBeVisible();
  await expect(page.getByText('Hello there')).toBeVisible();
});

test('short description: no Read more', async ({ page }) => {
  await openDrawer(page, CLOSED);
  await expect(drawer(page).getByText('New and second-hand books.')).toBeVisible();
  await expect(drawer(page).getByRole('button', { name: 'Read more' })).toHaveCount(0);
});

test('footer stays put while the body scrolls, and nothing ends up behind it', async ({ page }) => {
  await openDrawer(page, FULL);
  await drawer(page).getByRole('button', { name: 'Read more' }).tap();
  const message = drawer(page).getByRole('button', { name: 'Message' });
  const before = (await message.boundingBox())!;
  const scrollable = await body(page).evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrollable).toBe(true);

  await body(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(300);
  expect(await message.boundingBox()).toEqual(before);
  const lastRow = (await drawer(page).locator('a[href^="mailto:"]').boundingBox())!;
  const footerTop = (await drawer(page).locator('div.border-t.bg-card').last().boundingBox())!.y;
  expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(footerTop);
});

test('swiping down on the photo does not close the drawer; swiping elsewhere does', async ({ page }) => {
  await openDrawer(page, FULL);
  const gallery = (await drawer(page).locator('[data-vaul-no-drag]').boundingBox())!;
  await swipeDown(page, gallery.x + gallery.width / 2, gallery.y + 120);
  await expect(drawer(page)).toBeVisible();

  const title = (await drawer(page).getByRole('heading', { name: FULL.name }).boundingBox())!;
  await swipeDown(page, title.x + 40, title.y + 10);
  await expect(drawer(page)).toHaveCount(0);
});
