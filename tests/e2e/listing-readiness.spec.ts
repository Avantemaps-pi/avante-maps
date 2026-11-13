/**
 * Pi ecosystem listing checks (docs/listing-readiness-audit.md): no Pi Network logo, an Avante Maps
 * share image, and the listing-facing copy.
 *
 * 375x812 with mocked Supabase. Signed out unless a test signs in with a fake Supabase session.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const session = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: { id: mockUser.uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};

async function setup(page: Page, { loggedIn = false } = {}) {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await mockMap(page, NEARBY_BUSINESSES);
  if (!loggedIn) {
    await page.addInitScript(() => localStorage.clear());
    return;
  }
  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
}

// Any image (img, or an svg <image>) that points at a Pi Network logo file
const piLogoImages = (page: Page) =>
  page.locator('img[src*="pi-network"], img[alt="Pi Network"], img[src*="816179f9"], image[href*="816179f9"]');

// ---- Branding

test('landing page: no Pi Network logo, the Avante mark above "Made For Pi. Not Made By Pi."', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await page.keyboard.press('Escape');
  const callout = page.locator('section', { has: page.getByRole('heading', { name: 'Made For Pi. Not Made By Pi.' }) });
  await expect(callout).toBeVisible();
  await expect(callout.locator('svg')).toHaveCount(1);
  await expect(callout.locator('img')).toHaveCount(0);
  await expect(piLogoImages(page)).toHaveCount(0);
  const year = new Date().getFullYear();
  await expect(page.getByText(`© ${year} Avante Maps Pty Ltd. An independent app for Pi users.`)).toBeVisible();
  await expect(page.getByText(/Built on the Pi Network/)).toHaveCount(0);
});

test('sign-in dialog: a user icon in the "Pi Network User" row, not the Pi logo', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Sign in to Avante Maps' });
  await expect(dialog).toBeVisible();
  const row = dialog.locator('div.rounded-xl', { hasText: 'Pi Network User' });
  await expect(row.locator('svg.lucide-user-round')).toHaveCount(1);
  // The only image is the Avante Maps icon in the header
  await expect(dialog.locator('img')).toHaveAttribute('src', '/lovable-uploads/Avante-Maps-icon.svg');
  await expect(piLogoImages(page)).toHaveCount(0);
});

test('Contact FAQ: "Is Avante Maps affiliated with Pi Network?" starts with "No."', async ({ page }) => {
  await setup(page);
  await page.goto('/contact');
  const answer = page.getByText(/^No\. Avante Maps is an independent platform/);
  // Retry until hydrated: a tap on the server-rendered markup does nothing
  await expect(async () => {
    await page.getByRole('button', { name: 'Is Avante Maps affiliated with Pi Network?' }).tap();
    await expect(answer).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
});
