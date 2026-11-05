/**
 * Locate button uses device GPS whenever "Use my location" is on.
 *
 * The separate "Use device GPS (precise)" setting was removed, so a tap on
 * the locate button must always try GPS (asking once), then fall back to IP
 * location. Before the removal, users who had never opted in to that setting
 * only ever got IP location.
 *
 * Geolocation, the Permissions API and the IP providers are mocked, so no
 * real location or network lookup is involved. The map needs a signed-in
 * user, so the sandbox mock session (honoured on localhost only) is used,
 * as in reauth-false-success.spec.ts.
 */
import { test, expect, type Page } from './helpers/fixtures';

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

const GPS = { lat: 51.5007, lng: -0.1246 };
const IP = { lat: 48.8566, lng: 2.3522 };

type GeoMock = {
  // 'none': the browser has no Permissions API (state reads as 'unknown')
  permission: 'granted' | 'prompt' | 'denied' | 'none';
  // What getCurrentPosition does when called
  result: 'success' | 'denied' | 'timeout';
  storage?: Record<string, string>;
  auth?: Record<string, string>;
};

// Requests to the IP providers, per page
const ipRequests = new WeakMap<Page, number>();

async function setup(page: Page, mock: GeoMock) {
  await page.route('**/pi-sdk.js', (route) => route.abort());
  ipRequests.set(page, 0);
  // Every IP provider (sign-in focus and the locate fallback) returns IP
  for (const url of ['https://ipapi.co/json/', 'https://get.geojs.io/v1/ip/geo.json', 'https://ipwho.is/**']) {
    await page.route(url, (route) => {
      ipRequests.set(page, (ipRequests.get(page) ?? 0) + 1);
      return route.fulfill({ json: { success: true, latitude: IP.lat, longitude: IP.lng } });
    });
  }
  await page.addInitScript((m: GeoMock) => {
    const w = window as unknown as {
      __geoCalls: number;
      __centers: Array<{ lat: number; lng: number }>;
      __toasts: string[];
    };
    w.__geoCalls = 0;
    w.__centers = [];
    w.__toasts = [];
    if (!sessionStorage.getItem('__seeded')) {
      sessionStorage.setItem('__seeded', '1');
      localStorage.clear();
      for (const [k, v] of Object.entries({ ...m.auth, ...m.storage })) localStorage.setItem(k, v);
    }
    window.addEventListener('centerMap', (e) => {
      const d = (e as CustomEvent<{ lat: number; lng: number }>).detail;
      w.__centers.push({ lat: d.lat, lng: d.lng });
    });
    new MutationObserver(() => {
      document.querySelectorAll('[data-sonner-toast] [data-title]').forEach((el) => {
        const t = el.textContent ?? '';
        if (w.__toasts[w.__toasts.length - 1] !== t) w.__toasts.push(t);
      });
    }).observe(document, { childList: true, subtree: true, characterData: true });

    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: m.permission === 'none' ? undefined : { query: async () => ({ state: m.permission }) },
    });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          ok: (p: { coords: { latitude: number; longitude: number; accuracy: number } }) => void,
          fail: (e: { code: number; message: string; PERMISSION_DENIED: number; POSITION_UNAVAILABLE: number; TIMEOUT: number }) => void,
        ) => {
          w.__geoCalls += 1;
          setTimeout(() => {
            if (m.result === 'success') {
              ok({ coords: { latitude: 51.5007, longitude: -0.1246, accuracy: 10 } });
            } else if (m.result === 'timeout') {
              fail({ code: 3, message: 'timeout', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
            } else {
              fail({ code: 1, message: 'denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
            }
          }, 300);
        },
        watchPosition: () => 0,
        clearWatch: () => {},
      },
    });
  }, {
    ...mock,
    auth: {
      [SANDBOX_MOCK_KEY]: '1',
      [STORAGE_KEY]: JSON.stringify({ ...mockUser, lastAuthenticated: Date.now() }),
    },
  });
}

const state = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __geoCalls: number;
      __centers: Array<{ lat: number; lng: number }>;
      __toasts: string[];
    };
    return { geoCalls: w.__geoCalls, centers: w.__centers, toasts: w.__toasts };
  });

const locate = (page: Page) => page.getByRole('button', { name: 'Show my location' });

// The map can also call getCurrentPosition on load (LeafletMap.tsx, when
// permission is already granted), so only calls from the tap onwards count.
async function tapLocate(page: Page) {
  await page.waitForLoadState('networkidle');
  const before = (await state(page)).geoCalls;
  await locate(page).click();
  return async () => (await state(page)).geoCalls - before;
}

test('permission granted: centres on device GPS', async ({ page }) => {
  await setup(page, { permission: 'granted', result: 'success' });
  await page.goto('/');
  const calls = await tapLocate(page);
  await expect(page.getByText('Centred on your location', { exact: true })).toBeVisible();
  expect(await calls()).toBe(1);
  expect((await state(page)).centers.at(-1)).toEqual(GPS);
});

test('permission denied in the prompt: toast, then IP location', async ({ page }) => {
  await setup(page, { permission: 'prompt', result: 'denied' });
  await page.goto('/');
  const calls = await tapLocate(page);
  await expect(page.getByText('Centred on your approximate location', { exact: true })).toBeVisible();
  expect(await calls()).toBe(1);
  const s = await state(page);
  expect(s.toasts).toContain('Location permission denied');
  expect(s.centers.at(-1)).toEqual(IP);
});

test('prompt already dismissed once: IP location without a new prompt', async ({ page }) => {
  await setup(page, { permission: 'prompt', result: 'success', storage: { geolocation_prompted: '1' } });
  await page.goto('/');
  const calls = await tapLocate(page);
  await expect(page.getByText('Centred on your approximate location', { exact: true })).toBeVisible();
  expect(await calls()).toBe(0);
  expect((await state(page)).centers.at(-1)).toEqual(IP);
});

test('"Use my location" off hides the button; turning it on asks once on the next tap', async ({ page }) => {
  await setup(page, {
    permission: 'prompt',
    result: 'success',
    storage: { use_location_focus: '0', geolocation_prompted: '1', use_device_gps: '1', location_gps_autoenabled: '1' },
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(locate(page)).toHaveCount(0);

  await page.goto('/settings');
  const toggle = page.getByRole('switch', { name: 'Use my location' });
  // Retry until hydrated: a click on the SSR markup does nothing
  await expect(async () => {
    await page.getByRole('button', { name: /Appearance/ }).click();
    await expect(toggle).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch')).toHaveCount(1);
  // Dead keys from the removed GPS setting are cleaned up on mount
  expect(await page.evaluate(() => [localStorage.getItem('use_device_gps'), localStorage.getItem('location_gps_autoenabled')])).toEqual([null, null]);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  expect(await page.evaluate(() => localStorage.getItem('geolocation_prompted'))).toBeNull();

  await page.goto('/');
  const calls = await tapLocate(page);
  await expect(page.getByText('Centred on your location', { exact: true })).toBeVisible();
  expect(await calls()).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('geolocation_prompted'))).toBe('1');
});

// Map load (LeafletMap.tsx) auto-centres only with permission already granted
// and the setting on, once per session, and never shows a prompt.
const mapLoaded = async (page: Page) => {
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
};

test('map load with permission "prompt": no getCurrentPosition call', async ({ page }) => {
  await setup(page, { permission: 'prompt', result: 'success' });
  await page.goto('/');
  await mapLoaded(page);
  expect((await state(page)).geoCalls).toBe(0);
});

test('map load with permission granted and setting on: centres once per session', async ({ page }) => {
  await setup(page, { permission: 'granted', result: 'success' });
  await page.goto('/');
  await mapLoaded(page);
  const s = await state(page);
  expect(s.geoCalls).toBe(1);
  expect(s.centers).toContainEqual(GPS);

  // Coming back to the map in the same session doesn't re-centre
  await page.goto('/settings');
  await page.goto('/');
  await mapLoaded(page);
  expect((await state(page)).geoCalls).toBe(0);
});

test('map load with "Use my location" off: no getCurrentPosition call', async ({ page }) => {
  await setup(page, { permission: 'granted', result: 'success', storage: { use_location_focus: '0' } });
  await page.goto('/');
  await mapLoaded(page);
  expect((await state(page)).geoCalls).toBe(0);
});

// Browsers without a Permissions API: the GPS grant is remembered
// (geolocation_granted), so later taps keep using GPS without a new prompt.
test('no Permissions API, allowed: second tap uses GPS again', async ({ page }) => {
  await setup(page, { permission: 'none', result: 'success' });
  await page.goto('/');
  const first = await tapLocate(page);
  await expect(page.getByText('Centred on your location', { exact: true })).toBeVisible();
  expect(await first()).toBe(1);
  await expect(locate(page)).not.toHaveAttribute('aria-busy', 'true');

  const second = await tapLocate(page);
  await expect.poll(second).toBe(1);
  await expect(locate(page)).not.toHaveAttribute('aria-busy', 'true');
  expect((await state(page)).centers.at(-1)).toEqual(GPS);
});

test('no Permissions API, denied: IP location, and the next tap does not prompt', async ({ page }) => {
  await setup(page, { permission: 'none', result: 'denied' });
  await page.goto('/');
  const first = await tapLocate(page);
  await expect(page.getByText('Centred on your approximate location', { exact: true })).toBeVisible();
  expect(await first()).toBe(1);
  expect((await state(page)).toasts).toContain('Location permission denied');
  await expect(locate(page)).not.toHaveAttribute('aria-busy', 'true');

  const second = await tapLocate(page);
  await expect(locate(page)).not.toHaveAttribute('aria-busy', 'true');
  expect(await second()).toBe(0);
  expect((await state(page)).centers.at(-1)).toEqual(IP);
});

test('no Permissions API, GPS already allowed: the toast says "Getting your location…"', async ({ page }) => {
  await setup(page, {
    permission: 'none',
    result: 'success',
    storage: { geolocation_prompted: '1', geolocation_granted: '1' },
  });
  await page.goto('/');
  const calls = await tapLocate(page);
  await expect(page.getByText('Centred on your location', { exact: true })).toBeVisible();
  expect(await calls()).toBe(1);
  const { toasts } = await state(page);
  expect(toasts).toContain('Getting your location…');
  expect(toasts).not.toContain('Requesting location permission…');
});

// Sign-in centring: GPS when it's already allowed (no IP request, no city→street
// jump), otherwise the IP location as before; never a prompt on load.
async function signInCentring(page: Page) {
  await page.goto('/');
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_500);
  return { ...(await state(page)), ipRequests: ipRequests.get(page) ?? 0 };
}

test('sign-in, permission granted: centres on GPS, no IP request', async ({ page }) => {
  await setup(page, { permission: 'granted', result: 'success' });
  const s = await signInCentring(page);
  expect(s.geoCalls).toBe(1);
  expect(s.centers).toEqual([GPS]);
  expect(s.ipRequests).toBe(0);
});

test('sign-in, no Permissions API but GPS allowed before: centres on GPS, no IP request', async ({ page }) => {
  await setup(page, { permission: 'none', result: 'success', storage: { geolocation_granted: '1' } });
  const s = await signInCentring(page);
  expect(s.geoCalls).toBe(1);
  expect(s.centers).toEqual([GPS]);
  expect(s.ipRequests).toBe(0);
});

test('sign-in, GPS not allowed (prompt): IP centring, no prompt', async ({ page }) => {
  await setup(page, { permission: 'prompt', result: 'success' });
  const s = await signInCentring(page);
  expect(s.geoCalls).toBe(0);
  expect(s.centers).toEqual([IP]);
  expect(s.ipRequests).toBe(1);
});

test('sign-in, no Permissions API and never allowed: IP centring, no prompt', async ({ page }) => {
  await setup(page, { permission: 'none', result: 'success' });
  const s = await signInCentring(page);
  expect(s.geoCalls).toBe(0);
  expect(s.centers).toEqual([IP]);
});

test('sign-in, GPS times out: falls back to IP centring once', async ({ page }) => {
  await setup(page, { permission: 'granted', result: 'timeout' });
  const s = await signInCentring(page);
  expect(s.geoCalls).toBe(1);
  expect(s.centers).toEqual([IP]);
  expect(s.ipRequests).toBe(1);
});
