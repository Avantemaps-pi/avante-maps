/**
 * Home location: the first time a signed-in user reaches the map with users.home_set_at null, a
 * "Set your home location" sheet opens with a draggable pin already at their location (GPS when
 * "Use my location" is on and allowed, else the IP location). "Use this location" saves it, "Skip
 * for now" saves nothing but sets home_set_at; either way it doesn't come back. Without GPS the
 * map centres on the home location before the IP location. Settings changes or removes it.
 *
 * 375x812, with the sandbox session, a fake Supabase session, mocked geolocation and a users row
 * that PATCHes update, like PostgREST.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 } });

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: {
    id: mockUser.uid,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
};

const GPS = { lat: 51.5007, lng: -0.1246 };
const IP = { lat: 48.8566, lng: 2.3522 };
const HOME = { lat: -33.9249, lng: 18.4241 };

interface HomeRow {
  home_lat: number | null;
  home_lng: number | null;
  home_set_at: string | null;
}

interface Options {
  row?: HomeRow;
  /** GPS permission, and what getCurrentPosition does */
  gps?: 'granted' | 'prompt-allow' | 'denied';
  /** "Use my location" off */
  locationOff?: boolean;
  usersFail?: boolean;
}

async function setup(page: Page, options: Options = {}) {
  const state = {
    row: options.row ?? { home_lat: null, home_lng: null, home_set_at: null },
    patches: [] as Record<string, unknown>[],
  };
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES, {
    centre: IP,
    ...(options.locationOff ? { storage: { use_location_focus: '0' } } : {}),
  });
  await page.route('**/rest/v1/users*', (route) => {
    const request = route.request();
    if (options.usersFail)
      return route.fulfill({
        status: 400,
        json: { message: 'column users.home_lat does not exist' },
      });
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.patches.push(body);
      Object.assign(state.row, body);
      return route.fulfill({ json: [{ id: mockUser.uid }] });
    }
    const select = new URL(request.url()).searchParams.get('select') ?? '';
    if (!select.includes('home_set_at')) return route.fulfill({ json: [] });
    return route.fulfill({ json: [state.row] });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  const gps = options.gps ?? 'granted';
  await page.addInitScript(
    ([mode, at]) => {
      const w = window as unknown as {
        __centers: Array<{ lat: number; lng: number }>;
        __geoCalls: number;
      };
      w.__centers = [];
      w.__geoCalls = 0;
      window.addEventListener('centerMap', (e) => {
        const d = (e as CustomEvent<{ lat: number; lng: number }>).detail;
        w.__centers.push({ lat: d.lat, lng: d.lng });
      });
      const state =
        mode === 'granted'
          ? 'granted'
          : mode === 'denied'
            ? 'denied'
            : 'prompt';
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: async () => ({ state }) },
      });
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (
            ok: (p: {
              coords: { latitude: number; longitude: number; accuracy: number };
            }) => void,
            fail: (e: {
              code: number;
              message: string;
              PERMISSION_DENIED: number;
            }) => void,
          ) => {
            w.__geoCalls += 1;
            setTimeout(() => {
              if (mode === 'denied')
                fail({ code: 1, message: 'denied', PERMISSION_DENIED: 1 });
              else
                ok({
                  coords: {
                    latitude: (at as { lat: number }).lat,
                    longitude: (at as { lng: number }).lng,
                    accuracy: 10,
                  },
                });
            }, 20);
          },
          watchPosition: () => 0,
          clearWatch: () => undefined,
        },
      });
    },
    [gps, GPS] as const,
  );
  return state;
}

const sheet = (page: Page) =>
  page.getByRole('dialog', { name: 'Set your home location' });
const centers = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __centers: Array<{ lat: number; lng: number }> })
        .__centers,
  );

test('a new user: the sheet opens with the pin at their GPS position; "Use this location" saves it, and it never comes back', async ({
  page,
}) => {
  const state = await setup(page, { gps: 'granted' });
  await page.goto('/');
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
  await expect(sheet(page).getByText('Drag the pin to adjust.')).toBeVisible();
  const marker = sheet(page).locator('[data-home-picker] .leaflet-marker-icon');
  await expect(marker).toBeVisible();
  // The pin is inside the small map, not clipped below it (map.css sizes the full-screen map)
  await expect
    .poll(() =>
      marker.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return (
          document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          ) === el
        );
      }),
    )
    .toBe(true);

  await sheet(page).getByRole('button', { name: 'Use this location' }).click();
  await expect(sheet(page)).toBeHidden();
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0]).toMatchObject({
    home_lat: GPS.lat,
    home_lng: GPS.lng,
  });
  expect(typeof state.patches[0]!['home_set_at']).toBe('string');
  await expect(page.getByText('Home location saved')).toBeVisible();

  await page.reload();
  await expect(page.locator('.leaflet-container').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(1500);
  await expect(sheet(page)).toHaveCount(0);
});

test('"Skip for now" saves no position but sets home_set_at, and the sheet never comes back', async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto('/');
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
  await sheet(page).getByRole('button', { name: 'Skip for now' }).click();
  await expect(sheet(page)).toBeHidden();
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0]).toMatchObject({ home_lat: null, home_lng: null });
  expect(typeof state.patches[0]!['home_set_at']).toBe('string');

  // A new tab (new session): still not shown
  const second = await page.context().newPage();
  await setup(second, { row: state.row });
  await second.goto('/');
  await expect(second.locator('.leaflet-container').first()).toBeVisible({
    timeout: 20_000,
  });
  await second.waitForTimeout(1500);
  await expect(sheet(second)).toHaveCount(0);
});

test('GPS refused: the pin starts at the IP location', async ({ page }) => {
  const state = await setup(page, { gps: 'denied' });
  await page.goto('/');
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
  await expect(
    sheet(page).locator('[data-home-picker] .leaflet-marker-icon'),
  ).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Use this location' }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toMatchObject({
    home_lat: IP.lat,
    home_lng: IP.lng,
  });
});

test('"Use my location" off: GPS isn\'t asked, the pin starts at the IP location', async ({
  page,
}) => {
  const state = await setup(page, { gps: 'granted', locationOff: true });
  await page.goto('/');
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
  await sheet(page).getByRole('button', { name: 'Use this location' }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.patches[0]).toMatchObject({
    home_lat: IP.lat,
    home_lng: IP.lng,
  });
  expect(
    await page.evaluate(
      () => (window as unknown as { __geoCalls: number }).__geoCalls,
    ),
  ).toBe(0);
});

test('dragging the pin, or tapping the map, moves it before saving', async ({
  page,
}) => {
  const state = await setup(page, { gps: 'granted' });
  await page.goto('/');
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 });
  const marker = sheet(page).locator('[data-home-picker] .leaflet-marker-icon');
  await expect(marker).toBeVisible();
  // Once the sheet has finished sliding up, so the pin is where it will stay
  let last = -1;
  await expect
    .poll(async () => {
      const y = (await marker.boundingBox())?.y ?? -1;
      const settled = y === last;
      last = y;
      return settled;
    })
    .toBe(true);
  const box = (await marker.boundingBox())!;
  // A finger drag (the page is a touch device, where Leaflet drags on touch events)
  const cdp = await page.context().newCDPSession(page);
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const touch = (type: string, x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    });
  await touch('touchStart', from.x, from.y);
  for (let i = 1; i <= 8; i++)
    await touch('touchMove', from.x + (60 * i) / 8, from.y + (30 * i) / 8);
  await touch('touchEnd', from.x + 60, from.y + 30);
  await sheet(page).getByRole('button', { name: 'Use this location' }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  const saved = state.patches[0] as { home_lat: number; home_lng: number };
  // East and south of where it started
  expect(saved.home_lng).toBeGreaterThan(GPS.lng);
  expect(saved.home_lat).toBeLessThan(GPS.lat);
});

test('with a home and no GPS, the map centres on home (not the IP location)', async ({
  page,
}) => {
  await setup(page, {
    row: {
      home_lat: HOME.lat,
      home_lng: HOME.lng,
      home_set_at: '2026-11-11T10:00:00Z',
    },
    locationOff: true,
  });
  await page.goto('/');
  await expect
    .poll(() => centers(page), { timeout: 20_000 })
    .toContainEqual(HOME);
  expect(await centers(page)).not.toContainEqual(IP);
  await expect(sheet(page)).toHaveCount(0);
});

test('with GPS allowed and on, the map still centres on GPS, not home', async ({
  page,
}) => {
  await setup(page, {
    row: {
      home_lat: HOME.lat,
      home_lng: HOME.lng,
      home_set_at: '2026-11-11T10:00:00Z',
    },
    gps: 'granted',
  });
  await page.goto('/');
  await expect
    .poll(() => centers(page), { timeout: 20_000 })
    .toContainEqual(GPS);
  await page.waitForTimeout(800);
  expect(await centers(page)).not.toContainEqual(HOME);
});

test('a read that fails (e.g. before the migration) never shows the sheet', async ({
  page,
}) => {
  await setup(page, { usersFail: true });
  await page.goto('/');
  await expect(page.locator('.leaflet-container').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(1500);
  await expect(sheet(page)).toHaveCount(0);
});

test('Settings: "Home location" shows Set, opens the sheet at the saved home, and Save stores a new one; Remove clears it', async ({
  page,
}) => {
  const state = await setup(page, {
    row: {
      home_lat: HOME.lat,
      home_lng: HOME.lng,
      home_set_at: '2026-11-11T10:00:00Z',
    },
  });
  await page.goto('/settings');
  const row = page.getByRole('button', { name: 'Home location: Set' });
  await expect(async () => {
    if (!(await row.isVisible()))
      await page.getByRole('button', { name: /Appearance/ }).click();
    await expect(row).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await row.click();
  await expect(sheet(page)).toBeVisible();
  // Tap the map away from the pin: the pin moves there
  const picker = sheet(page).locator('[data-home-picker] .leaflet-container');
  await expect(
    sheet(page).locator('[data-home-picker] .leaflet-marker-icon'),
  ).toBeVisible();
  const box = (await picker.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.25);
  await sheet(page).getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => state.patches.length).toBe(1);
  const saved = state.patches[0] as { home_lat: number; home_lng: number };
  expect(saved.home_lng).toBeGreaterThan(HOME.lng);
  expect(saved.home_lat).toBeGreaterThan(HOME.lat);

  await page.getByRole('button', { name: 'Home location: Set' }).click();
  await sheet(page)
    .getByRole('button', { name: 'Remove home location' })
    .click();
  await expect.poll(() => state.patches.length).toBe(2);
  expect(state.patches[1]).toMatchObject({ home_lat: null, home_lng: null });
  await expect(
    page.getByRole('button', { name: 'Home location: Not set' }),
  ).toBeVisible();
});

test('signed out: no sheet (the landing page)', async ({ page }) => {
  await setup(page);
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await page.waitForTimeout(2000);
  await expect(sheet(page)).toHaveCount(0);
});
