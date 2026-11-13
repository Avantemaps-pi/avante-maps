/**
 * Tap the map to drill down: country → state → city → suburb.
 *
 * Touch input at 375x812 with the mocked map helpers. Nominatim reverse is
 * mocked by zoom level with nested square areas (AREA_FIXTURES) far from the
 * mocked businesses: Testland holds West and East Province, West holds the
 * city Riverton, Riverton the suburb Hillcrest. Each contains its parent's
 * centre, so tapping the middle of the map after each fly goes one level deeper.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { AREA_FIXTURES, areaCentre, mockMap, NEARBY_BUSINESSES, pin, zoomToPins, CENTRE } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
// Also set in playwright.config.ts. Kept here so a failed run always has its trace. "List · N" used to
// time out waiting for the first pin in long runs: the IP focus raced it (see openMapOverTestland)
test.use({ trace: 'retain-on-failure' });

const COUNTRY = AREA_FIXTURES[0]!;
// The middle of the map, clear of the top stack and the bottom controls
const MIDDLE = { x: 187, y: 420 };
// Inside the map's right edge: after West Province's fly this is East Province
const RIGHT_EDGE = { x: 360, y: 420 };
// Just left of the middle: clear of businesses near Hillcrest, still inside each next area
const LEFT_OF_MIDDLE = { x: 172, y: 420 };
// Below the state cards (which start at 248px), still inside Testland at zoom 7
const BELOW_CARD = { x: 187, y: 560 };

const label = (page: Page) => page.locator('[data-map-area-label]');
const live = (page: Page) => page.locator('p[aria-live="polite"]', { hasText: /^Showing |^$/ }).first();
const outlines = (page: Page) => page.locator('.leaflet-overlay-pane path');

function trackLookups(page: Page) {
  const lookups: { zoom: string; at: number }[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.hostname === 'nominatim.openstreetmap.org') lookups.push({ zoom: u.searchParams.get('zoom')!, at: Date.now() });
  });
  return lookups;
}

// What the map was doing if the first pin never shows. Leaflet's map isn't reachable from the
// page, so the zoom and the area on screen come from the tiles: their URLs are /{z}/{x}/{y}.png
const mapState = (page: Page) =>
  page.evaluate(() => {
    const view = document.querySelector('.leaflet-container')?.getBoundingClientRect();
    const tiles = [...document.querySelectorAll<HTMLImageElement>('img.leaflet-tile')]
      .filter((img) => {
        const r = img.getBoundingClientRect();
        return view && r.right > view.left && r.left < view.right && r.bottom > view.top && r.top < view.bottom;
      })
      .map((img) => /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(img.src))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) }));
    const zoom = tiles.length ? Math.max(...tiles.map((t) => t.z)) : null;
    const atZoom = tiles.filter((t) => t.z === zoom);
    const lng = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
    const lat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
    const bounds =
      zoom === null || !atZoom.length
        ? null
        : {
            north: lat(Math.min(...atZoom.map((t) => t.y)), zoom),
            south: lat(Math.max(...atZoom.map((t) => t.y)) + 1, zoom),
            west: lng(Math.min(...atZoom.map((t) => t.x)), zoom),
            east: lng(Math.max(...atZoom.map((t) => t.x)) + 1, zoom),
          };
    return {
      markers: document.querySelectorAll('.leaflet-marker-icon').length,
      zoomFromTiles: zoom,
      boundsFromTiles: bounds,
      mapPaneTransform: document.querySelector<HTMLElement>('.leaflet-map-pane')?.style.transform ?? null,
      listButton: document.querySelector('[data-map-list-button]')?.textContent ?? null,
      url: location.pathname,
    };
  });

// The wait that times out in long runs: on a timeout, it logs (and attaches) the map's state first.
// 45s, so the log lands before the test's own 60s timeout
async function waitForFirstPin(page: Page, businessesResolved: () => boolean, timeout = 45_000) {
  try {
    await page.locator('.leaflet-marker-icon').first().waitFor({ state: 'attached', timeout });
  } catch (error) {
    const state = { ...(await mapState(page)), businessesRequestResolved: businessesResolved() };
    console.log(`[first pin timed out] ${JSON.stringify(state)}`);
    await test.info().attach('map state when the first pin timed out', {
      body: JSON.stringify(state, null, 2),
      contentType: 'application/json',
    });
    throw error;
  }
}

async function openMapOverTestland(page: Page, rows: object[] = NEARBY_BUSINESSES, pinTimeout?: number) {
  await mockMap(page, rows, { areas: AREA_FIXTURES });
  // No automatic focus on the IP location (CENTRE, zoom 14). It fired ~400 ms after the home read
  // settled, which varies with load: before the first pin it hid Testland's pins (only those on
  // screen are drawn), after centreMap it moved the map from under the taps. The flag is what the
  // app sets once it has focused in this browser session
  await page.addInitScript(() => sessionStorage.setItem('ip_location_focused', '1'));
  let businessesResolved = false;
  page.on('response', (response) => {
    if (response.url().includes('/rest/v1/rpc/get_public_business_info')) businessesResolved = true;
  });
  await page.goto('/');
  await waitForFirstPin(page, () => businessesResolved, pinTimeout);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
  await centreMap(page, areaCentre(COUNTRY), 5);
}

async function centreMap(page: Page, at: { lat: number; lng: number }, zoom: number) {
  await page.evaluate((d) => window.dispatchEvent(new CustomEvent('centerMap', { detail: d })), { ...at, zoom });
  await page.waitForTimeout(1_200);
}

// Tap and let the fly finish; waits out the one-request-per-second gap first
async function tapMap(page: Page, at: { x: number; y: number } = MIDDLE) {
  await page.waitForTimeout(1_100);
  await page.touchscreen.tap(at.x, at.y);
  await page.waitForTimeout(1_300);
}

async function expectArea(page: Page, name: string) {
  await expect(label(page)).toContainText(name);
  await expect(outlines(page)).toHaveCount(1);
}

const mapPaneTransform = (page: Page) => page.locator('.leaflet-map-pane').evaluate((el) => getComputedStyle(el).transform);

test('taps drill down country → state → city → suburb; a fifth tap inside the suburb does nothing', async ({ page }) => {
  const lookups = trackLookups(page);
  await openMapOverTestland(page);

  await tapMap(page);
  await expectArea(page, 'Testland');
  await expect(page.getByRole('button', { name: /^Up to / })).toHaveCount(0);
  await tapMap(page);
  await expectArea(page, 'West Province');
  await tapMap(page);
  await expectArea(page, 'Riverton');
  await tapMap(page);
  await expectArea(page, 'Hillcrest');
  expect(lookups.map((l) => l.zoom)).toEqual(['3', '5', '10', '14']);

  await tapMap(page);
  await expectArea(page, 'Hillcrest');
  expect(lookups).toHaveLength(4);
});

test('a tap in the sibling state switches at the same level', async ({ page }) => {
  await openMapOverTestland(page);
  await tapMap(page);
  await tapMap(page);
  await expectArea(page, 'West Province');
  await tapMap(page, RIGHT_EDGE);
  await expectArea(page, 'East Province');
  await expect(page.getByRole('button', { name: 'Up to Testland' })).toBeVisible();
});

test('"Up" selects the parent area; "Clear" removes the outline and label without moving the map', async ({ page }) => {
  await openMapOverTestland(page);
  await tapMap(page);
  await tapMap(page);
  await tapMap(page);
  await expectArea(page, 'Riverton');

  await page.getByRole('button', { name: 'Up to West Province' }).tap();
  await page.waitForTimeout(1_300);
  await expectArea(page, 'West Province');
  await page.getByRole('button', { name: 'Up to Testland' }).tap();
  await page.waitForTimeout(1_300);
  await expectArea(page, 'Testland');
  await expect(page.getByRole('button', { name: /^Up to / })).toHaveCount(0);

  const before = await mapPaneTransform(page);
  await page.getByRole('button', { name: 'Clear area' }).tap();
  await expect(label(page)).toHaveCount(0);
  await expect(outlines(page)).toHaveCount(0);
  await page.waitForTimeout(800);
  expect(await mapPaneTransform(page)).toBe(before);
});

test('a repeat tap in a cached area makes no network request', async ({ page }) => {
  const lookups = trackLookups(page);
  await openMapOverTestland(page);
  await tapMap(page);
  await expectArea(page, 'Testland');
  await page.getByRole('button', { name: 'Clear area' }).tap();
  await expect(label(page)).toHaveCount(0);
  await tapMap(page);
  await expectArea(page, 'Testland');
  expect(lookups).toHaveLength(1);
});

test('quick taps: at most one request a second, a waiting tap is dropped, the last tap wins', async ({ page }) => {
  const lookups = trackLookups(page);
  await openMapOverTestland(page);
  // Slow answers, so the taps overlap (registered after mockMap's, so it runs first)
  await page.route('https://nominatim.openstreetmap.org/**', async (route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fallback();
  });
  await page.waitForTimeout(1_100);
  // West of Testland (nothing there), further west (dropped while waiting), then Testland
  await page.touchscreen.tap(60, MIDDLE.y);
  await page.waitForTimeout(400);
  await page.touchscreen.tap(100, MIDDLE.y);
  await page.waitForTimeout(400);
  await page.touchscreen.tap(MIDDLE.x, MIDDLE.y);
  await page.waitForTimeout(2_500);

  expect(lookups).toHaveLength(2);
  expect(lookups[1]!.at - lookups[0]!.at).toBeGreaterThanOrEqual(950);
  await expectArea(page, 'Testland');
});

test('with the strip open, a tap only closes it (no lookup)', async ({ page }) => {
  const lookups = trackLookups(page);
  await mockMap(page, NEARBY_BUSINESSES, { areas: AREA_FIXTURES });
  await page.goto('/');
  await zoomToPins(page, NEARBY_BUSINESSES);
  const box = (await pin(page, NEARBY_BUSINESSES[0]!.name).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('region', { name: 'Businesses in this area' })).toBeVisible();
  await page.waitForTimeout(500);
  await page.touchscreen.tap(60, 330);
  await expect(page.getByRole('region', { name: 'Businesses in this area' })).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(lookups).toEqual([]);
});

test('the live region announces the area', async ({ page }) => {
  await openMapOverTestland(page);
  await tapMap(page);
  await expect(live(page)).toHaveText('Showing Testland');
  await tapMap(page);
  await expect(live(page)).toHaveText('Showing West Province');
});

test('"List · N" follows each drill-down fly', async ({ page }) => {
  const row = { keywords: [], contact_info: {}, hours: null, images: [], city: 'Riverton', country: 'Testland', is_verified: false, is_certified: false, verification_status: null, description: '' };
  const rows = [
    // In Riverton, outside Hillcrest
    { ...row, id: 9801, name: 'Riverton Hardware', category: 'Retail', business_types: ['Retail'], latitude: -29.7, longitude: 24.1 },
    // In Hillcrest, off its centre so the middle of the map stays clear
    { ...row, id: 9802, name: 'Hillcrest Deli', category: 'Food', business_types: ['Food'], latitude: -29.95, longitude: 23.8 },
  ];
  await openMapOverTestland(page, rows);
  const listButton = page.locator('[data-map-list-button]');
  // The middle first: at the starting zoom the two businesses' cluster sits left of it
  await tapMap(page);
  await expectArea(page, 'Testland');
  await expect(listButton).toHaveText('List · 2');
  await tapMap(page, LEFT_OF_MIDDLE);
  await tapMap(page, LEFT_OF_MIDDLE);
  await expectArea(page, 'Riverton');
  await expect(listButton).toHaveText('List · 2');
  await tapMap(page, LEFT_OF_MIDDLE);
  await expectArea(page, 'Hillcrest');
  await expect(listButton).toHaveText('List · 1');
});

test.describe('the label hides with the map state cards and the keyboard', () => {
  const expectHidden = async (page: Page) => {
    await expect(label(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(label(page)).toHaveCSS('opacity', '0');
  };
  const expectShown = async (page: Page) => {
    await expect(label(page)).not.toHaveAttribute('aria-hidden', 'true');
    await expect(label(page)).toHaveCSS('opacity', '1');
  };

  test('no match and the keyboard', async ({ page }) => {
    await openMapOverTestland(page);
    await tapMap(page);
    await expectShown(page);

    const search = page.locator('input[aria-label="Search businesses"]');
    await search.fill('zzzz');
    await expect(page.getByText('No results for "zzzz"')).toBeVisible();
    await expectHidden(page);
    await search.fill('');
    await page.keyboard.press('Escape');
    await expect(page.getByText('No results for "zzzz"')).toHaveCount(0);

    // On-screen keyboard: a focused field and a shrunken viewport
    await search.focus();
    await page.setViewportSize({ width: 375, height: 500 });
    await expectHidden(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await search.blur();
    await expectShown(page);
  });

  test('loading', async ({ page }) => {
    await mockMap(page, NEARBY_BUSINESSES, { areas: AREA_FIXTURES });
    await page.route('**/rest/v1/rpc/get_public_business_info*', async (route) => {
      await new Promise((r) => setTimeout(r, 6_000));
      await route.fallback();
    });
    await page.goto('/');
    const search = page.locator('input[aria-label="Search businesses"]');
    await expect(search).toHaveAttribute('placeholder', 'Loading businesses…');
    await page.waitForTimeout(1_000);
    await centreMap(page, areaCentre(COUNTRY), 5);
    await tapMap(page);
    await expectHidden(page);
    await expect(search).toHaveAttribute('placeholder', 'Search businesses', { timeout: 15_000 });
    await expectShown(page);
  });

  test('empty', async ({ page }) => {
    await mockMap(page, [], { areas: AREA_FIXTURES });
    await page.goto('/');
    await expect(page.getByText('No businesses on the map yet')).toBeVisible();
    // No pins to wait for: let the map finish loading before moving it
    await page.locator('.leaflet-container').waitFor();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_000);
    await centreMap(page, areaCentre(COUNTRY), 7);
    await tapMap(page, BELOW_CARD);
    await expect(label(page)).toContainText('Testland');
    await expectHidden(page);
  });

  test('error', async ({ page }) => {
    await mockMap(page, NEARBY_BUSINESSES, { areas: AREA_FIXTURES, centre: CENTRE });
    await page.route('**/rest/v1/rpc/get_public_business_info*', (route) => route.fulfill({ status: 500, json: { message: 'boom' } }));
    await page.goto('/');
    await expect(page.getByText("Couldn't load businesses")).toBeVisible({ timeout: 30_000 });
    await centreMap(page, areaCentre(COUNTRY), 7);
    await tapMap(page, BELOW_CARD);
    await expect(label(page)).toContainText('Testland');
    await expectHidden(page);
  });
});

test('the old country cache keys are removed once; areas are stored under area_focus_v2:', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('country_focus_v1:za', '{"ts":0,"data":{"bbox":[0,0,0,0],"geojson":null}}');
    localStorage.setItem('country_focus_v1_tiles', '[]');
  });
  await openMapOverTestland(page);
  await tapMap(page);
  await expectArea(page, 'Testland');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes('focus')).sort());
  expect(keys).toEqual(['area_focus_v2:country:relation/1', 'area_focus_v2:old_keys_removed', 'area_focus_v2:tiles']);
});
