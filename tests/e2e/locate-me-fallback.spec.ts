/**
 * LocateMe taps for a signed-in user: GPS is asked on every tap unless the browser says denied
 * (high accuracy, then once at low accuracy after a timeout or no position); without GPS the map
 * centres on the user's home location, and only without one on the IP location, whose toast
 * offers "Set home location".
 *
 * 375x812 with the sandbox session, a fake Supabase session, a users row for the home location,
 * and scripted geolocation: each getCurrentPosition call takes the next answer.
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

const GPS = { lat: -29.6006, lng: 30.3794 };
const NETWORK = { lat: -29.61, lng: 30.39 };
const HOME = { lat: -29.5833, lng: 30.4167 };
const IP = { lat: -26.2041, lng: 28.0473 };

const APPROXIMATE =
  'Centred on your approximate area (from your internet connection)';
const DENIED =
  'Location is off for Avante Maps. Turn it on in your browser settings to use your exact location.';

type Answer = 'success' | 'network' | 'timeout' | 'unavailable' | 'denied';

interface Options {
  permission: 'granted' | 'prompt' | 'denied';
  /** What each getCurrentPosition call does, in order (the last repeats) */
  answers: Answer[];
  /** users row: a saved home, or skipped (set_at but no position) */
  home: 'saved' | 'none';
}

async function setup(page: Page, options: Options) {
  const counts = { ip: 0 };
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES, { centre: IP });
  for (const url of [
    'https://ipwho.is/**',
    'https://ipapi.co/json/',
    'https://get.geojs.io/v1/ip/geo.json',
  ]) {
    await page.route(url, (route) => {
      counts.ip += 1;
      return route.fulfill({
        json: { success: true, latitude: IP.lat, longitude: IP.lng },
      });
    });
  }
  const row =
    options.home === 'saved'
      ? {
          home_lat: HOME.lat,
          home_lng: HOME.lng,
          home_set_at: '2026-11-11T18:59:00Z',
        }
      : { home_lat: null, home_lng: null, home_set_at: '2026-11-11T18:59:00Z' };
  const patches: Record<string, unknown>[] = [];
  await page.route('**/rest/v1/users*', (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      patches.push(body);
      Object.assign(row, body);
      return route.fulfill({ json: [{ id: mockUser.uid }] });
    }
    const select = new URL(request.url()).searchParams.get('select') ?? '';
    return route.fulfill({ json: select.includes('home_set_at') ? [row] : [] });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  await page.addInitScript(
    ([opts, gps, network]) => {
      const w = window as unknown as {
        __geo: Array<{
          enableHighAccuracy?: boolean;
          timeout?: number;
          maximumAge?: number;
        }>;
        __centers: Array<{ lat: number; lng: number }>;
      };
      w.__geo = [];
      w.__centers = [];
      window.addEventListener('centerMap', (e) => {
        const d = (e as CustomEvent<{ lat: number; lng: number }>).detail;
        w.__centers.push({ lat: d.lat, lng: d.lng });
      });
      const o = opts as { permission: string; answers: string[] };
      Object.defineProperty(navigator, 'permissions', {
        configurable: true,
        value: { query: async () => ({ state: o.permission }) },
      });
      const fix = (at: { lat: number; lng: number }, accuracy: number) => ({
        coords: { latitude: at.lat, longitude: at.lng, accuracy },
      });
      const error = (code: number) => ({
        code,
        message: String(code),
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      });
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition: (
            ok: (p: unknown) => void,
            fail: (e: unknown) => void,
            options: {
              enableHighAccuracy?: boolean;
              timeout?: number;
              maximumAge?: number;
            },
          ) => {
            const answer =
              o.answers[Math.min(w.__geo.length, o.answers.length - 1)];
            w.__geo.push(options);
            setTimeout(() => {
              if (answer === 'success')
                ok(fix(gps as { lat: number; lng: number }, 8));
              else if (answer === 'network')
                ok(fix(network as { lat: number; lng: number }, 900));
              else if (answer === 'timeout') fail(error(3));
              else if (answer === 'unavailable') fail(error(2));
              else fail(error(1));
            }, 20);
          },
          watchPosition: () => 0,
          clearWatch: () => undefined,
        },
      });
    },
    [options, GPS, NETWORK] as const,
  );
  return { counts, patches };
}

const geo = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __geo: Array<Record<string, unknown>> }).__geo,
  );
const lastCentre = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __centers: Array<{ lat: number; lng: number }> }
    ).__centers.at(-1),
  );
const locate = (page: Page) =>
  page.getByRole('button', { name: 'Show my location' });

async function tap(page: Page) {
  await expect(page.locator('.leaflet-container').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  await locate(page).click();
}

test('high accuracy times out, low accuracy finds a network position: centred there', async ({
  page,
}) => {
  await setup(page, {
    permission: 'prompt',
    answers: ['timeout', 'network'],
    home: 'saved',
  });
  await page.goto('/');
  // "prompt": the map load never asks, so every call is the tap's
  await tap(page);
  await expect(
    page.getByText('Centred on your location', { exact: true }),
  ).toBeVisible();
  expect(await lastCentre(page)).toEqual(NETWORK);
  const calls = await geo(page);
  expect(calls).toEqual([
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
  ]);
});

test('no position at all (unavailable twice) with a home: centred on home', async ({
  page,
}) => {
  await setup(page, {
    permission: 'prompt',
    answers: ['unavailable'],
    home: 'saved',
  });
  await page.goto('/');
  await tap(page);
  await expect(
    page.getByText('Centred on your home location', { exact: true }),
  ).toBeVisible();
  expect(await lastCentre(page)).toEqual(HOME);
  expect(await geo(page)).toHaveLength(2);
});

test('denied in the prompt, home set: the "location is off" toast, centred on home, no IP request', async ({
  page,
}) => {
  const { counts } = await setup(page, {
    permission: 'prompt',
    answers: ['denied'],
    home: 'saved',
  });
  await page.goto('/');
  await tap(page);
  await expect(page.getByText(DENIED, { exact: true })).toBeVisible();
  await expect(
    page.getByText('Centred on your home location', { exact: true }),
  ).toBeVisible();
  expect(await lastCentre(page)).toEqual(HOME);
  // Denied isn't retried at low accuracy
  expect(await geo(page)).toHaveLength(1);
  expect(counts.ip).toBe(0);
});

test('permission denied, no home: the IP location, the honest toast and "Set home location", which opens the sheet and saves', async ({
  page,
}) => {
  const { counts, patches } = await setup(page, {
    permission: 'denied',
    answers: ['denied'],
    home: 'none',
  });
  await page.goto('/');
  await tap(page);
  await expect(page.getByText(DENIED, { exact: true })).toBeVisible();
  await expect(page.getByText(APPROXIMATE, { exact: true })).toBeVisible();
  expect(await lastCentre(page)).toEqual(IP);
  // Asked nothing: the browser says denied
  expect(await geo(page)).toHaveLength(0);
  expect(counts.ip).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Set home location' }).click();
  const sheet = page.getByRole('dialog', { name: 'Set your home location' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => patches.length).toBe(1);
  // GPS is denied, so the pin started at the IP location
  expect(patches[0]).toMatchObject({ home_lat: IP.lat, home_lng: IP.lng });
});

test('a home is set but GPS works: GPS wins', async ({ page }) => {
  await setup(page, {
    permission: 'granted',
    answers: ['success'],
    home: 'saved',
  });
  await page.goto('/');
  await tap(page);
  await expect(
    page.getByText('Centred on your location', { exact: true }),
  ).toBeVisible();
  expect(await lastCentre(page)).toEqual(GPS);
});
