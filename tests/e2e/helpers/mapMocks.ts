/**
 * Shared setup for map specs: the sandbox mock session (honoured on localhost
 * only) and mocked business data, so the tests never depend on what's live in
 * Supabase.
 */
import { expect, type Page } from '@playwright/test';

export const SANDBOX_MOCK_KEY = 'avante_sandbox_mock_session';
export const STORAGE_KEY = 'avante_maps_auth';

// Mirrors the loginAsSandbox() fallback user in AuthProvider.tsx.
export const mockUser = {
  uid: '00000000-0000-0000-0000-000000000001',
  pi_uid: 'sandbox-mock-pi-uid',
  username: 'SandboxUser',
  walletAddress: 'sandbox-mock-wallet',
  roles: ['user'],
  accessToken: 'sandbox-mock-token',
  subscriptionTier: 'organization',
  businessCount: 0,
};

export const CENTRE = { lat: -33.92, lng: 18.4212 };

const row = {
  keywords: [],
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

// ~150m apart around CENTRE: one cluster at the start zoom, separate pins at zoom 17
export const NEARBY_BUSINESSES = [
  { ...row, id: 9601, name: 'Harbour Light Coffee', category: 'Coffee Shop', business_types: ['Food'], latitude: -33.92, longitude: 18.421 },
  { ...row, id: 9602, name: 'Table Bay Bookshop', category: 'Retail', business_types: ['Retail'], latitude: -33.9188, longitude: 18.4222 },
  { ...row, id: 9603, name: 'Mzansi Mobile Repairs', category: 'Services', business_types: ['Services'], latitude: -33.9212, longitude: 18.4199 },
];

export interface MockArea {
  level: 'country' | 'state' | 'city' | 'suburb';
  osmId: number;
  name: string;
  /** south, north, west, east; the polygon is this square */
  box: [number, number, number, number];
}

const AREA_ZOOM = { 3: 'country', 5: 'state', 10: 'city', 14: 'suburb' } as const;

// Nested squares well away from CENTRE's businesses. Each area contains its
// parent's centre, so tapping the middle of the screen after each fly goes one
// level deeper.
export const AREA_FIXTURES: MockArea[] = [
  { level: 'country', osmId: 1, name: 'Testland', box: [-32, -28, 22, 28] },
  { level: 'state', osmId: 11, name: 'West Province', box: [-32, -28, 22, 25.5] },
  { level: 'state', osmId: 12, name: 'East Province', box: [-32, -28, 25.5, 28] },
  { level: 'city', osmId: 111, name: 'Riverton', box: [-30.5, -29.5, 23.25, 24.25] },
  { level: 'suburb', osmId: 1111, name: 'Hillcrest', box: [-30.1, -29.9, 23.65, 23.85] },
];

export const areaCentre = (a: MockArea) => ({ lat: (a.box[0] + a.box[1]) / 2, lng: (a.box[2] + a.box[3]) / 2 });

// A Nominatim reverse (jsonv2, polygon_geojson=1) answer for the area, or {} for nothing
const reverseAnswer = (areas: MockArea[], url: URL) => {
  const level = AREA_ZOOM[Number(url.searchParams.get('zoom')) as keyof typeof AREA_ZOOM];
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lon'));
  const a = areas.find((x) => x.level === level && lat >= x.box[0] && lat <= x.box[1] && lng >= x.box[2] && lng <= x.box[3]);
  if (!a) return {};
  const [s, n, w, e] = a.box;
  return {
    osm_type: 'relation',
    osm_id: a.osmId,
    name: a.name,
    address: { [a.level]: a.name },
    boundingbox: [s, n, w, e].map(String),
    geojson: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
};

/** The map's business list, and no review ratings for it */
export async function mockBusinessList(page: Page, rows: object[]) {
  await page.route('**/rest/v1/rpc/get_public_business_info*', (route) => route.fulfill({ json: rows }));
  await page.route('**/rest/v1/business_review_stats*', (route) => route.fulfill({ json: [] }));
}

/**
 * Mocks the map's outside calls (Pi SDK blocked, business list, IP location,
 * reverse geocoding) and signs in with the sandbox mock session. `storage`
 * adds extra localStorage entries, e.g. the colour scheme. `areas`: what the
 * Nominatim reverse lookup finds, by zoom level (nothing by default).
 */
export async function mockMap(
  page: Page,
  rows: object[],
  options: { centre?: { lat: number; lng: number }; storage?: Record<string, string>; areas?: MockArea[] } = {},
) {
  const centre = options.centre ?? CENTRE;
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await mockBusinessList(page, rows);
  await page.route('https://ipwho.is/**', (route) =>
    route.fulfill({ json: { success: true, latitude: centre.lat, longitude: centre.lng } }),
  );
  // Map taps reverse-geocode for the area drill-down
  await page.route('https://nominatim.openstreetmap.org/**', (route) =>
    route.fulfill({ json: reverseAnswer(options.areas ?? [], new URL(route.request().url())) }),
  );
  await page.addInitScript(
    ([mockKey, storageKey, user, extra]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(storageKey as string, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }));
      localStorage.setItem('location_banner_seen', '1');
      for (const [key, value] of Object.entries(extra as Record<string, string>)) localStorage.setItem(key, value);
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser, options.storage ?? {}],
  );
}

/**
 * After mockMap: the sandbox user is an admin (for admin-only pages such as /diagnostics). The
 * roles are re-read from user_roles after sign-in steps, so that answers admin too
 */
export async function makeAdmin(page: Page) {
  await page.route('**/rest/v1/user_roles*', (route) => route.fulfill({ json: [{ role: 'user' }, { role: 'admin' }] }));
  await page.addInitScript(
    ([storageKey, user]) => localStorage.setItem(storageKey as string, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() })),
    [STORAGE_KEY, { ...mockUser, roles: ['user', 'admin'] }],
  );
}

export const pin = (page: Page, name: string) => page.locator(`img.leaflet-marker-icon[alt="${name}"]`);

/**
 * Once the map has loaded, moves it to zoom 17 over CENTRE, where pins stop
 * clustering, and waits for each business's own pin.
 */
export async function zoomToPins(page: Page, rows: { name: string }[], centre = CENTRE) {
  await expect(page.locator('.leaflet-marker-icon').first()).toBeAttached();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
  await page.evaluate(
    (c) => window.dispatchEvent(new CustomEvent('centerMap', { detail: { lat: c.lat, lng: c.lng, zoom: 17 } })),
    centre,
  );
  for (const b of rows) await expect(pin(page, b.name)).toBeVisible();
  await page.waitForTimeout(800);
}
