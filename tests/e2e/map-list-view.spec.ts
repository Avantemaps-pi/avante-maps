/**
 * "List · N" on the map: every business in view as a list.
 *
 * Touch input at 375x812 and 360x780, with the mocked map helpers (sandbox
 * session, business RPC, IP location). The map is moved to zoom 17, where the
 * six businesses round CENTRE each have their own pin and are all in view;
 * FAR is ~2km north, in view only further out.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { CENTRE, mockMap, mockUser, pin, zoomToPins } from './helpers/mapMocks';

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

const open = (o: string, c: string) => ({ open: o, close: c, closed: false });
const everyDay = (value: object) =>
  Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((d) => [d, value]));

const base = {
  keywords: [],
  contact_info: {},
  hours: everyDay(open('07:00', '17:00')),
  images: [],
  city: 'Cape Town',
  country: 'South Africa',
  is_verified: false,
  is_certified: false,
  verification_status: null,
  description: '',
};

// Within ~150m of CENTRE, so all six are in view at zoom 17
const SIX = [
  { ...base, id: 9501, name: 'Harbour Light Coffee', category: 'Coffee Shop', business_types: ['Food'], latitude: -33.92, longitude: 18.421, is_verified: true },
  { ...base, id: 9502, name: 'Table Bay Bookshop', category: 'Retail', business_types: ['Retail'], latitude: -33.9188, longitude: 18.4222, is_certified: true, is_verified: true },
  { ...base, id: 9503, name: 'Mzansi Mobile Repairs', category: 'Services', business_types: ['Services'], latitude: -33.9212, longitude: 18.4199, hours: null },
  { ...base, id: 9504, name: 'Sea Point Bakery', category: 'Food', business_types: ['Food'], latitude: -33.9176, longitude: 18.4204 },
  { ...base, id: 9505, name: 'Kloof Street Florist', category: 'Retail', business_types: ['Retail'], latitude: -33.9224, longitude: 18.4218 },
  { ...base, id: 9506, name: 'Long Street Records', category: 'Entertainment', business_types: ['Entertainment'], latitude: -33.9206, longitude: 18.4228 },
];
const FAR = { ...base, id: 9599, name: 'Gardens Tailor', category: 'Services', business_types: ['Services'], latitude: CENTRE.lat + 0.02, longitude: CENTRE.lng };

// Nearest to CENTRE first (the map centre after zoomToPins)
const byDistance = (rows: typeof SIX) => {
  const kx = Math.cos((CENTRE.lat * Math.PI) / 180);
  const d = (r: (typeof SIX)[number]) => (r.latitude - CENTRE.lat) ** 2 + ((r.longitude - CENTRE.lng) * kx) ** 2;
  return [...rows].sort((a, b) => d(a) - d(b)).map((r) => r.name);
};

const SIZES = [
  { width: 375, height: 812 },
  { width: 360, height: 780 },
] as const;

test.use({ hasTouch: true, isMobile: true });

const listButton = (page: Page) => page.locator('[data-map-list-button]');
const listView = (page: Page) => page.getByRole('dialog', { name: /in this area$/ });
const rows = (page: Page) => listView(page).locator('[data-list-row]');
const strip = (page: Page) => page.getByRole('region', { name: 'Businesses in this area' });

async function openMap(page: Page, all: object[] = [...SIX, FAR], options: { storage?: Record<string, string> } = {}) {
  await page.route(`${SUPABASE}/rest/v1/bookmarks*`, (route) => route.fulfill({ json: [] }));
  await mockMap(page, all, options);
  await page.goto('/');
  await zoomToPins(page, SIX);
}

// Moves the map and lets it settle: Leaflet drops a setView that arrives mid zoom animation
async function centreMap(page: Page, lat: number, lng: number, zoom: number) {
  await page.evaluate((d) => window.dispatchEvent(new CustomEvent('centerMap', { detail: d })), { lat, lng, zoom });
  await page.waitForTimeout(1_000);
}

async function tapCentre(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function openStripOn(page: Page, name: string) {
  await tapCentre(page, pin(page, name));
  await expect(strip(page)).toBeVisible();
  await page.waitForTimeout(500);
}

async function openList(page: Page) {
  await listButton(page).tap();
  await expect(listView(page)).toBeVisible();
  await page.waitForTimeout(300);
}

// Boxes of the bottom controls that are actually showing
const controlBoxes = (page: Page) =>
  page.evaluate(() => {
    const selectors: Record<string, string> = {
      list: '[data-map-list-button]',
      plus: '[data-add-business-fab]',
      osm: '.leaflet-control-attribution',
      locate: 'button[aria-label="Show my location"]',
      zoomIn: 'button[aria-label="Zoom in"]',
      zoomOut: 'button[aria-label="Zoom out"]',
      strip: '[data-map-strip]',
    };
    const shown = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none' || e.getAttribute('aria-hidden') === 'true') return false;
      }
      return true;
    };
    const out: Record<string, { left: number; top: number; right: number; bottom: number }> = {};
    for (const [name, sel] of Object.entries(selectors)) {
      const el = document.querySelector(sel);
      if (!el || !shown(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out[name] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return out;
  });

function expectNoOverlap(boxes: Awaited<ReturnType<typeof controlBoxes>>) {
  const names = Object.keys(boxes);
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = boxes[names[i]!]!;
      const b = boxes[names[j]!]!;
      // Zoom in and out are one group, so they touch
      if (names[i]!.startsWith('zoom') && names[j]!.startsWith('zoom')) continue;
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      expect(overlap, `${names[i]} overlaps ${names[j]}: ${JSON.stringify(a)} / ${JSON.stringify(b)}`).toBe(false);
    }
  }
}

// What a user sees of the map: where each pin sits on screen
const pinPositions = (page: Page) =>
  page.locator('img.leaflet-marker-icon').evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return `${e.getAttribute('alt')}@${Math.round(r.left)},${Math.round(r.top)}`;
    }).sort(),
  );

for (const size of SIZES) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test('"List · N" matches what is in view and follows pans and zooms', async ({ page }) => {
      await openMap(page);
      await expect(listButton(page)).toHaveText('List · 6');
      await expect(listButton(page)).toHaveAttribute('aria-label', 'Show 6 businesses in this area as a list');
      await expect(page.locator('img.leaflet-marker-icon')).toHaveCount(6);

      // Pan to FAR alone
      await centreMap(page, FAR.latitude, FAR.longitude, 17);
      await expect(listButton(page)).toHaveText('List · 1');
      await expect(listButton(page)).toHaveAttribute('aria-label', 'Show 1 business in this area as a list');

      // Zoom out over CENTRE: FAR and the six
      await centreMap(page, CENTRE.lat, CENTRE.lng, 14);
      await expect(listButton(page)).toHaveText('List · 7');

      // Nothing in view
      await centreMap(page, -34.6, 17.2, 17);
      await expect(listButton(page)).toHaveCount(0);
    });

    test('the List button, OSM credit, Locate, zoom, + and strip never overlap', async ({ page }) => {
      for (const fab of ['pill', 'round'] as const) {
        // The "Register business" pill shows for the first 24 hours
        const firstVisit = fab === 'pill' ? new Date().toISOString() : '2020-01-01T00:00:00.000Z';
        await openMap(page, [...SIX, FAR], { storage: { fab_first_visit: firstVisit } });
        await expect(page.locator('[data-add-business-fab]')).toHaveAttribute('aria-label', fab === 'pill' ? 'Register a business' : 'Open quick actions');

        const closed = await controlBoxes(page);
        expect(Object.keys(closed).sort()).toEqual(['list', 'locate', 'osm', 'plus', 'zoomIn', 'zoomOut']);
        expectNoOverlap(closed);
        // Level with the + button, the OSM credit below it
        expect(Math.round(closed.list!.bottom)).toBe(Math.round(closed.plus!.bottom));
        expect(closed.osm!.top).toBeGreaterThanOrEqual(closed.list!.bottom);

        await openStripOn(page, SIX[1]!.name);
        const opened = await controlBoxes(page);
        // The OSM credit has faded where it was, as the strip covers its spot
        expect(Object.keys(opened).sort()).toEqual(['list', 'locate', 'strip', 'zoomIn', 'zoomOut']);
        expectNoOverlap(opened);
        // 12px above the strip
        expect(Math.round(opened.strip!.top - opened.list!.bottom)).toBe(12);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    });

    test('the list shows every business in view, nearest to the map centre first', async ({ page }) => {
      await openMap(page);
      await openList(page);
      await expect(listView(page).getByRole('heading', { name: '6 businesses in this area' })).toBeVisible();
      const names = await rows(page).evaluateAll((els) => els.map((e) => e.querySelector('button[aria-label]')!.getAttribute('aria-label')!.split(', ')[0]));
      expect(names).toEqual(byDistance(SIX));
      for (const r of await rows(page).all()) expect(Math.round((await r.boundingBox())!.height)).toBe(124);
      await expect(listView(page).getByText('Zoom in to see more businesses here.')).toHaveCount(0);
    });
  });
}

test.describe('375x812', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('hidden while loading and with no match', async ({ page }) => {
    // Loading: the business list takes a while (registered after mockMap's, so it runs first)
    await mockMap(page, SIX);
    await page.route('**/rest/v1/rpc/get_public_business_info*', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.fallback();
    });
    await page.goto('/');
    await expect(page.locator('input[aria-label="Search businesses"]')).toHaveAttribute('placeholder', 'Loading businesses…');
    await expect(listButton(page)).toHaveCount(0);
    await zoomToPins(page, SIX);
    await expect(listButton(page)).toHaveText('List · 6');

    // No match: a search nothing matches
    await page.locator('input[aria-label="Search businesses"]').fill('zzzz');
    await expect(page.getByText('No results for "zzzz"')).toBeVisible();
    await expect(listButton(page)).toHaveCount(0);
  });

  test('hidden with the empty state', async ({ page }) => {
    await mockMap(page, []);
    await page.goto('/');
    await expect(page.getByText('No businesses on the map yet')).toBeVisible();
    await expect(listButton(page)).toHaveCount(0);
  });

  test('hidden with the error state', async ({ page }) => {
    await mockMap(page, SIX);
    await page.route('**/rest/v1/rpc/get_public_business_info*', (route) => route.fulfill({ status: 500, json: { message: 'boom' } }));
    await page.goto('/');
    await expect(page.getByText("Couldn't load businesses")).toBeVisible({ timeout: 30_000 });
    await expect(listButton(page)).toHaveCount(0);
  });

  test('a row opens the drawer; closing it returns to the list at the same scroll', async ({ page }) => {
    await openMap(page);
    await openList(page);
    const body = listView(page).locator('.overflow-y-auto').first();
    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(200);
    const scrolled = await body.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);

    const last = rows(page).last();
    const name = (await last.locator('button[aria-label]').first().getAttribute('aria-label'))!.split(', ')[0]!;
    const before = await pinPositions(page);
    await tapCentre(page, last.locator('p').first());
    const drawer = page.locator('[role="dialog"]').filter({ has: page.getByRole('heading', { name }) });
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(600);
    await drawer.getByRole('button', { name: 'Close' }).first().tap();
    await expect(drawer).toHaveCount(0);
    await expect(listView(page)).toBeVisible();
    expect(await body.evaluate((el) => el.scrollTop)).toBe(scrolled);
    // Opening the drawer from a row didn't move the map
    await listView(page).getByRole('button', { name: 'Back to map' }).tap();
    expect(await pinPositions(page)).toEqual(before);
  });

  for (const how of ['Back', 'Escape', 'Map tab'] as const) {
    test(`${how} returns to the map unchanged, the strip still on the same card`, async ({ page }) => {
      await openMap(page);
      await openStripOn(page, SIX[3]!.name);
      const before = await pinPositions(page);
      await openList(page);
      // Opened from the strip: its business is marked in the list
      await expect(listView(page).locator('[data-list-row][aria-current="true"]')).toHaveAttribute('data-list-row', String(SIX[3]!.id));

      if (how === 'Back') await listView(page).getByRole('button', { name: 'Back to map' }).tap();
      else if (how === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('navigation').last().getByRole('link', { name: 'Map' }).tap();

      await expect(listView(page)).toHaveCount(0);
      await expect(strip(page)).toBeVisible();
      await expect(page.locator('[data-strip-card][aria-current="true"]')).toHaveAttribute('data-strip-card', String(SIX[3]!.id));
      await page.waitForTimeout(400);
      expect(await pinPositions(page)).toEqual(before);
    });
  }

  test('focus moves to the list title on open and back to the List button on close', async ({ page }) => {
    await openMap(page);
    await openList(page);
    await expect(listView(page).getByRole('heading', { name: '6 businesses in this area' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(listButton(page)).toBeFocused();
  });

  test('with more than 50 in view the list caps at 50 and says to zoom in', async ({ page }) => {
    const many = Array.from({ length: 56 }, (_, i) => ({
      ...base,
      id: 9700 + i,
      name: `Corner Shop ${i + 1}`,
      category: 'Retail',
      business_types: ['Retail'],
      latitude: CENTRE.lat - 0.0016 + Math.floor(i / 8) * 0.0005,
      longitude: CENTRE.lng - 0.0012 + (i % 8) * 0.0003,
    }));
    await mockMap(page, many);
    await page.goto('/');
    await expect(page.locator('.leaflet-marker-icon').first()).toBeAttached();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_000);
    await centreMap(page, CENTRE.lat, CENTRE.lng, 17);
    await expect(listButton(page)).toHaveText('List · 50+');
    await openList(page);
    await expect(listView(page).getByRole('heading', { name: '56 businesses in this area' })).toBeVisible();
    await expect(rows(page)).toHaveCount(50);
    await expect(listView(page).getByText('Zoom in to see more businesses here.')).toBeAttached();

    // Scrolled, rows pass under the sticky header without their Save showing through it
    const body = listView(page).locator('.overflow-y-auto').first();
    for (const y of [60, 100, 140, 180]) {
      await body.evaluate((el, top) => el.scrollTo(0, top), y);
      const inHeader = await page.evaluate(() => {
        const header = document.querySelector('[data-map-list-view] header')!.getBoundingClientRect();
        const save = document.querySelector('[data-map-list-view] [data-list-row] button[aria-pressed]')!.getBoundingClientRect();
        const hit = document.elementFromPoint(save.left + save.width / 2, header.top + header.height / 2);
        return !!hit?.closest('header');
      });
      expect(inHeader).toBe(true);
    }
  });

  test('Save from a list row shows in the drawer and the strip; one bookmarks load per mount', async ({ page }) => {
    // A signed-in Supabase session (fake, unexpired) so bookmarks really load
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const uid = mockUser.uid;
    const session = {
      access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: uid, exp, role: 'authenticated', aud: 'authenticated' })}.sig`,
      refresh_token: 'fake-refresh',
      expires_in: 3600,
      expires_at: exp,
      token_type: 'bearer',
      user: { id: uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    };
    const saved: number[] = [];
    await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
    await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
    await page.route('**/rest/v1/bookmarks*', (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'POST') {
        const row = req.postDataJSON() as { business_id: number };
        saved.push(row.business_id);
        return route.fulfill({ status: 201, json: [{ id: saved.length, user_id: uid, business_id: row.business_id }] });
      }
      // The pre-check before an add asks for one business: not saved yet
      if (url.searchParams.has('business_id')) return route.fulfill({ json: [] });
      return route.fulfill({ json: saved.map((id, i) => ({ id: i + 1, business_id: id })) });
    });
    await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
    await mockMap(page, [...SIX, FAR]);
    await page.goto('/');
    await zoomToPins(page, SIX);
    await openStripOn(page, SIX[0]!.name);

    const loads: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith('/rest/v1/bookmarks') && r.method() === 'GET' && !u.searchParams.has('business_id')) loads.push(r.url());
    });
    await openList(page);
    await page.waitForLoadState('networkidle');
    // One per mount; the dev server runs React StrictMode, which mounts twice
    expect(loads.length).toBeLessThanOrEqual(2);

    const row = listView(page).locator(`[data-list-row="${SIX[2]!.id}"]`);
    await row.getByRole('button', { name: 'Save business' }).tap();
    await expect(row.getByRole('button', { name: 'Remove from saved' })).toBeVisible();
    expect(saved).toEqual([SIX[2]!.id]);

    // The drawer for that business shows it saved
    await tapCentre(page, row.locator('p').first());
    const drawer = page.locator('[role="dialog"]').filter({ has: page.getByRole('heading', { name: SIX[2]!.name }) });
    await expect(drawer.getByRole('button', { name: 'Remove from saved' })).toBeVisible();
    await drawer.getByRole('button', { name: 'Close' }).first().tap();
    await expect(drawer).toHaveCount(0);

    // And so does the strip, back on the map
    await listView(page).getByRole('button', { name: 'Back to map' }).tap();
    await expect(page.locator(`[data-strip-card="${SIX[2]!.id}"]`).getByRole('button', { name: 'Remove from saved' })).toBeAttached();
  });
});
