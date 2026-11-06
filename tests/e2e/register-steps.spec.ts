/**
 * Registration as four steps: About your business, Where to find you,
 * Hours, photos and payment, Review.
 *
 * Touch-size viewport 375x812 with the sandbox mock session and a fake,
 * unexpired Supabase session (the submit path needs one). Every request to
 * the Supabase project is answered locally: a catch-all records it, and the
 * calls the submit path makes (business count, name check, geocoding,
 * duplicate check, insert-business) are mocked, so nothing reaches the real
 * backend.
 */
import { test, expect, type Page, type Locator } from './helpers/fixtures';
import { SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser } from './helpers/mapMocks';

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeSession() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp, role: 'authenticated', aud: 'authenticated' })}.sig`,
    refresh_token: 'fake-refresh',
    expires_in: 3600,
    expires_at: exp,
    token_type: 'bearer',
    user: { id: mockUser.uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

interface Calls {
  inserts: string[];
  writes: string[];
}

// ipCountry: what the mocked ipwho.is lookup returns; without it the lookup fails and the user picks
async function openRegistration(page: Page, options: { ipCountry?: { country: string; country_code: string } } = {}): Promise<Calls> {
  const calls: Calls = { inserts: [], writes: [] };
  const session = fakeSession();

  // Registered first, so the specific mocks below take precedence
  await page.route(`${SUPABASE}/**`, (route) => {
    const req = route.request();
    if (req.method() !== 'GET' && req.method() !== 'HEAD') calls.writes.push(`${req.method()} ${new URL(req.url()).pathname}`);
    return route.fulfill({ json: [] });
  });
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await page.route('**/rest/v1/users*', (route) => route.fulfill({ json: [{ subscription: 'organization' }] }));
  // Count (HEAD), name check and duplicate check all find nothing
  await page.route('**/rest/v1/businesses*', (route) =>
    route.fulfill({ json: [], headers: { 'content-range': '*/0' } }),
  );
  await page.route('**/functions/v1/geocode-address', (route) =>
    route.fulfill({ json: { suggestions: [{ lat: -33.92, lon: 18.42, address: {} }] } }),
  );
  await page.route('**/functions/v1/insert-business', (route) => {
    calls.inserts.push(route.request().postData() ?? '');
    return route.fulfill({ json: { success: true, business: { id: 9999 } } });
  });
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route('https://ipwho.is/**', (route) =>
    options.ipCountry
      ? route.fulfill({ json: { success: true, ...options.ipCountry }, headers: { 'access-control-allow-origin': '*' } })
      : route.abort(),
  );

  await page.addInitScript(
    ([mockKey, storageKey, user, s]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(storageKey as string, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }));
      localStorage.setItem('location_banner_seen', '1');
      localStorage.setItem('supabase.auth.token', JSON.stringify(s));
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser, session],
  );
  await page.goto('/registration');
  await expect(page.getByText('Step 1 of 4')).toBeVisible();
  await page.waitForTimeout(500);
  return calls;
}

const title = (page: Page) => page.getByRole('heading', { level: 1 });
const continueButton = (page: Page) => page.getByRole('button', { name: 'Continue' });
const body = (page: Page) => page.locator('[data-register-body]');
const footer = (page: Page) => page.locator('[data-register-footer]');

async function fillStep1(page: Page) {
  await page.locator('#businessName').fill('Harbour Light Coffee');
  await page.getByRole('button', { name: 'Restaurant/Cafe' }).click();
  await page.locator('#businessDescription').fill('Small-batch coffee roasted every morning on the harbour, with seats inside.');
}

async function fillStep2(page: Page) {
  await page.getByRole('combobox').first().click();
  await page.getByPlaceholder('Search countries...').fill('South Africa');
  await page.getByRole('option', { name: 'South Africa' }).first().click();
  await page.locator('#streetAddress').fill('12 Dock Road');
  await page.locator('#city').fill('Cape Town');
  await page.locator('#state').fill('Western Cape');
  await page.locator('#zipCode').fill('8001');
  await page.locator('#phone').fill('215550123');
  await page.locator('#email').fill('hello@harbourlight.example');
}

async function fillStep3(page: Page) {
  await page.locator('#piWalletAddress').fill('GABC1234PIWALLET');
}

async function next(page: Page, expectedTitle: string) {
  await continueButton(page).click();
  await expect(title(page)).toHaveText(expectedTitle);
}

async function toReview(page: Page) {
  await fillStep1(page);
  await next(page, 'Where to find you');
  await fillStep2(page);
  await next(page, 'Hours, photos and payment');
  await fillStep3(page);
  await next(page, 'Review');
}

// After scrolling the body to the end, the last field sits fully above the footer
async function expectLastFieldClearsFooter(page: Page, last: Locator) {
  await body(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(200);
  const field = (await last.boundingBox())!;
  const foot = (await footer(page).boundingBox())!;
  expect(field.y + field.height).toBeLessThanOrEqual(foot.y);
  expect(foot.y + foot.height).toBeLessThanOrEqual(812);
}

test('step 1 shows "Step 1 of 4" and the progress bar', async ({ page }) => {
  await openRegistration(page);
  await expect(title(page)).toHaveText('About your business');
  const bar = page.getByRole('progressbar', { name: 'Registration progress' });
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await expect(bar).toHaveAttribute('aria-valuemax', '4');
  await expect(page.getByText('Next: Where to find you')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close registration' })).toBeVisible();
});

test('a direct load of /registration focuses the step title', async ({ page }) => {
  await openRegistration(page);
  await expect(title(page)).toHaveText('About your business');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('page-title');
  await expect(title(page)).toBeFocused();
});

test('Continue with an empty business name stays on step 1 and focuses it', async ({ page }) => {
  await openRegistration(page);
  await continueButton(page).click();
  await expect(page.getByText('Business name is required')).toBeVisible();
  await expect(page.locator('#businessName')).toBeFocused();
  await expect(page.getByText('Step 1 of 4')).toBeVisible();
  await expect(title(page)).toHaveText('About your business');
});

test('filling steps 1–3 reaches Review with the entered values', async ({ page }) => {
  await openRegistration(page);
  await toReview(page);
  await expect(page.getByText('Step 4 of 4')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  // Continue on step 3 must not also submit the form (no address check dialog yet)
  await page.waitForTimeout(500);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  const review = body(page);
  await expect(review.getByText('Harbour Light Coffee').first()).toBeVisible();
  await expect(review.getByText('Restaurant/Cafe').first()).toBeVisible();
  await expect(review.getByText('12 Dock Road, Cape Town, Western Cape, 8001, South Africa')).toBeVisible();
  await expect(review.getByText('+27215550123 · hello@harbourlight.example')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Register business' })).toBeVisible();
});

test('"Edit" on Review returns to that step with the values kept', async ({ page }) => {
  await openRegistration(page);
  await toReview(page);
  await page.getByRole('button', { name: 'Edit Where to find you' }).click();
  await expect(title(page)).toHaveText('Where to find you');
  await expect(title(page)).toBeFocused();
  await expect(page.locator('#city')).toHaveValue('Cape Town');
  await expect(page.locator('#phone')).toHaveValue('215550123');

  await next(page, 'Hours, photos and payment');
  await next(page, 'Review');
  await page.getByRole('button', { name: 'Edit About your business' }).click();
  await expect(title(page)).toHaveText('About your business');
  await expect(page.locator('#businessName')).toHaveValue('Harbour Light Coffee');
  await expect(page.getByRole('button', { name: 'Restaurant/Cafe' })).toHaveAttribute('aria-pressed', 'true');
});

test('Back keeps the values and does not validate', async ({ page }) => {
  await openRegistration(page);
  await fillStep1(page);
  await next(page, 'Where to find you');
  // Step 2 is empty: Back must not show its errors
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(title(page)).toHaveText('About your business');
  await expect(page.locator('#businessName')).toHaveValue('Harbour Light Coffee');
  await expect(page.locator('#businessDescription')).toHaveValue(/Small-batch coffee/);
  await expect(page.getByRole('button', { name: 'Restaurant/Cafe' })).toHaveAttribute('aria-pressed', 'true');
  await next(page, 'Where to find you');
  await expect(page.getByText('Country is required')).toHaveCount(0);
});

test('the footer stays visible and each step’s last field scrolls fully above it', async ({ page }) => {
  await openRegistration(page);
  await expectLastFieldClearsFooter(page, page.locator('#businessDescription'));
  await fillStep1(page);
  await next(page, 'Where to find you');
  await expectLastFieldClearsFooter(page, page.locator('#website'));
  await fillStep2(page);
  await next(page, 'Hours, photos and payment');
  await expectLastFieldClearsFooter(page, page.locator('#piWalletAddress'));
  await fillStep3(page);
  await next(page, 'Review');
  await expectLastFieldClearsFooter(page, body(page).locator('.max-w-md').last());
});

test('the country is filled in from the IP location (ipwho.is over https)', async ({ page }) => {
  const ipApi: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).hostname === 'ip-api.com') ipApi.push(r.url());
  });
  await openRegistration(page, { ipCountry: { country: 'South Africa', country_code: 'ZA' } });
  await fillStep1(page);
  await next(page, 'Where to find you');
  await expect(page.getByRole('combobox').first()).toHaveText('South Africa');
  await expect(page.getByText('Address search will be filtered to South Africa')).toBeVisible();
  expect(ipApi).toEqual([]);
});

// Every field label on the step: 14px semibold, the title's colour, no icon
async function expectStepLabels(page: Page) {
  const titleColour = await title(page).evaluate((el) => getComputedStyle(el).color);
  // A checkbox's own label (the Hours "Closed" toggles) isn't a field label
  const labels = await body(page).locator('label:not(:has([role="checkbox"]))').evaluateAll((els) =>
    els.map((el) => {
      const cs = getComputedStyle(el);
      return { text: el.textContent?.trim(), size: cs.fontSize, weight: cs.fontWeight, colour: cs.color, icons: el.querySelectorAll('svg:not(.animate-spin)').length };
    }),
  );
  expect(labels.length).toBeGreaterThan(0);
  for (const l of labels) expect(l, l.text).toEqual({ ...l, size: '14px', weight: '600', colour: titleColour, icons: 0 });
  return labels.map((l) => l.text);
}

test('one label style on steps 1–3, sentence case, errors still red', async ({ page }) => {
  await openRegistration(page);
  expect(await expectStepLabels(page)).toEqual([
    'Business name *',
    'Business type (select all that apply) *',
    'Business description *',
    'Pi Network username',
  ]);
  await continueButton(page).click();
  const nameLabel = body(page).locator('label', { hasText: 'Business name *' });
  const errorColour = await page.getByText('Business name is required').evaluate((el) => getComputedStyle(el).color);
  await expect(nameLabel).toHaveCSS('color', errorColour);

  await fillStep1(page);
  await next(page, 'Where to find you');
  expect(await expectStepLabels(page)).toEqual(
    expect.arrayContaining(['Street address', 'Apartment, suite or unit (optional)', 'City', 'Province or state', 'Postal code', 'Contact number *', 'Email address *', 'Pi Network website URL (optional)']),
  );
  // Registration keeps the Apartment box; only Update business hides it
  await expect(page.locator('#apartment')).toBeVisible();
  await fillStep2(page);
  await next(page, 'Hours, photos and payment');
  expect(await expectStepLabels(page)).toEqual(expect.arrayContaining(['Business images', 'Pi wallet address (business)']));
});

test('business type chips toggle with Space and Enter', async ({ page }) => {
  await openRegistration(page);
  const chip = page.getByRole('button', { name: 'Retail Store' });
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.focus();
  await page.keyboard.press('Space');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  // Still on step 1: Enter on a chip toggles it, it doesn't continue
  await expect(title(page)).toHaveText('About your business');
});

test('submit calls the existing registration path once', async ({ page }) => {
  const calls = await openRegistration(page);
  await toReview(page);
  await page.getByRole('button', { name: 'Register business' }).click();
  await page.getByRole('button', { name: 'Confirm & Continue' }).click();
  await page.waitForURL('**/registered-business');
  expect(calls.inserts).toHaveLength(1);
  const payload = JSON.parse(calls.inserts[0]!);
  expect(payload.business_name).toBe('Harbour Light Coffee');
  expect(payload.business_types).toEqual(['Restaurant/Cafe']);
  expect(payload.phone_number).toBe('+27215550123');
  expect(payload.address).toMatchObject({ street: '12 Dock Road', city: 'Cape Town', country: 'South Africa' });
  expect(payload.pi_wallet_address).toBe('GABC1234PIWALLET');
  // No other writes reached the backend mock (no images, so no upload or update)
  expect(calls.writes).toEqual([]);
});
