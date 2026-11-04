/**
 * The Update business form opens with the business's stored contact details, hours and Pi
 * wallet, and saves them back unchanged. It used to open with blanks and defaults (the list's
 * select left those columns out), so saving would overwrite the real data.
 *
 * 375x812 with the sandbox session, a fake Supabase session (the page reads the session user)
 * and mocked Supabase tables.
 */
import { test, expect, type Page } from '@playwright/test';
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

const CONTACT = { first_name: 'Thandi', last_name: 'Mokoena', email: 'hello@harbour.example', phone: '+27215550123', website: 'https://harbour.pinet.com' };
const HOURS = {
  monday: { open: '08:00', close: '18:00', closed: false },
  tuesday: { open: '08:30', close: '18:00', closed: false },
  wednesday: { open: '08:00', close: '18:00', closed: false },
  thursday: { open: '08:00', close: '20:00', closed: false },
  friday: { open: '08:00', close: '21:00', closed: false },
  saturday: { open: '09:00', close: '13:00', closed: false },
  sunday: { open: '10:00', close: '16:00', closed: true },
};
const WALLET = 'GBHARBOURLIGHTCOFFEESTOREDWALLETADDRESS0000000000000000';
const ID = 56;
const ROW = {
  id: ID, business_name: 'Harbour Light Coffee', owner_id: mockUser.uid, category: 'Coffee Shop', business_description: 'Coffee by the harbour, roasted in small batches every week.',
  city: 'Cape Town', country: 'South Africa', images: [], is_verified: false, is_certified: false, verification_status: null, is_active: true,
  created_at: '2026-10-01T00:00:00Z', lat: -33.92, lng: 18.421, business_types: ['Food'], keywords: [], location: 'Cape Town',
  street_address: '12 Dock Road', state: 'Western Cape', zip_code: '8001', coordinates: null,
  contact_info: CONTACT, hours: HOURS, pi_wallet_address: WALLET,
};

async function setup(page: Page, row: Record<string, unknown> = ROW) {
  const gets: string[] = [];
  const patches: Record<string, unknown>[] = [];
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: session.user }));
  await mockMap(page, NEARBY_BUSINESSES);
  await page.route('**/rest/v1/businesses*', (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') {
      patches.push(req.postDataJSON() as Record<string, unknown>);
      return route.fulfill({ status: 204, body: '' });
    }
    const url = new URL(req.url());
    gets.push(url.search);
    // As RLS and the filters would: only this owner's row, and only the asked-for id
    const id = url.searchParams.get('id');
    const owner = url.searchParams.get('owner_id');
    const match = (!id || id === `eq.${ID}`) && (!owner || owner === `eq.${mockUser.uid}`);
    // Only the columns asked for, as PostgREST does: the original bug was a select missing some
    const select = url.searchParams.get('select') ?? '*';
    const columns = select.split(',').map((c) => c.trim());
    const picked = select === '*' ? row : Object.fromEntries(Object.entries(row).filter(([key]) => columns.includes(key)));
    return route.fulfill({ json: match ? [picked] : [] });
  });
  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  return { gets, patches };
}

const fromList = async (page: Page) => {
  await page.goto('/registered-business');
  await page.getByRole('button', { name: 'Edit' }).first().tap();
  await page.waitForURL(`**/update-registration/${ID}`);
};
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

async function expectStoredValues(page: Page) {
  await tab(page, 'Contact').tap();
  await expect(page.locator('#email')).toHaveValue(CONTACT.email);
  await expect(page.locator('#phone')).toHaveValue('215550123');
  await expect(page.getByRole('combobox').first()).toContainText('+27');
  await expect(page.locator('#website')).toHaveValue(CONTACT.website);

  await tab(page, 'Hours').tap();
  const times = page.locator('input[type="time"]');
  await expect(times).toHaveCount(14);
  await expect(times.nth(0)).toHaveValue('08:00');
  await expect(times.nth(1)).toHaveValue('18:00');
  await expect(times.nth(2)).toHaveValue('08:30');
  await expect(times.nth(9)).toHaveValue('21:00');
  await expect(times.nth(10)).toHaveValue('09:00');
  await expect(times.nth(11)).toHaveValue('13:00');
  const closed = page.getByRole('checkbox');
  await expect(closed.nth(0)).not.toBeChecked();
  await expect(closed.nth(6)).toBeChecked();

  await tab(page, 'Details').tap();
  await expect(page.locator('#piWalletAddress')).toHaveValue(WALLET);
}

async function submit(page: Page) {
  await tab(page, 'Preview').tap();
  await page.getByRole('button', { name: 'Submit Registration' }).tap();
}

test('from Your businesses → Edit: the stored contact details, hours and wallet are filled in', async ({ page }) => {
  const { gets } = await setup(page);
  await fromList(page);
  await expectStoredValues(page);
  // The list asked for them, so the edit page needed no second load
  const list = gets.find((q) => q.includes('business_name'))!;
  for (const column of ['contact_info', 'hours', 'pi_wallet_address']) expect(list).toContain(column);
  expect(gets.filter((q) => q.includes(`id=eq.${ID}`))).toHaveLength(0);
});

test('a direct load fills in the same values, loading by the route id for the session user', async ({ page }) => {
  const { gets } = await setup(page);
  await page.goto(`/update-registration/${ID}`);
  await expectStoredValues(page);
  expect(gets.some((q) => q.includes(`id=eq.${ID}`) && q.includes(`owner_id=eq.${mockUser.uid}`))).toBe(true);
  await expect(page.getByText('No business data found')).toHaveCount(0);
});

test('a reload keeps working', async ({ page }) => {
  await setup(page);
  await fromList(page);
  await page.reload();
  await expectStoredValues(page);
});

test("someone else's business, or no such id: a message, no form", async ({ page }) => {
  await setup(page);
  await page.goto('/update-registration/999');
  await expect(page.getByText("We couldn't find this business on your account.")).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Contact', exact: true })).toHaveCount(0);
});

test('a direct load with no Supabase session: asks to log in, no form, no business query', async ({ page }) => {
  const { gets } = await setup(page);
  await page.addInitScript(() => localStorage.removeItem('supabase.auth.token'));
  await page.goto(`/update-registration/${ID}`);
  await expect(page.getByText('Please log in to edit your business.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Contact', exact: true })).toHaveCount(0);
  expect(gets.filter((q) => q.includes(`id=eq.${ID}`))).toHaveLength(0);
});

test('changing only the email saves it, with everything else as stored', async ({ page }) => {
  const { patches } = await setup(page);
  await fromList(page);
  await tab(page, 'Contact').tap();
  await page.locator('#email').fill('new@harbour.example');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  const body = patches[0]!;
  expect(body['contact_info']).toEqual({ ...CONTACT, email: 'new@harbour.example' });
  expect(body['hours']).toEqual(HOURS);
  expect(body['pi_wallet_address']).toBe(WALLET);
  // The confirmation stays the server's: a new email reads "Not confirmed" until it's confirmed
  expect(body).not.toHaveProperty('contact_email_verified_for');
  expect(body).not.toHaveProperty('contact_email_verified_at');
});

test('a business loaded without contact_info, hours and wallet: saving leaves them out', async ({ page }) => {
  const { contact_info: _c, hours: _h, pi_wallet_address: _w, ...partial } = ROW;
  const { patches } = await setup(page, partial);
  await page.goto(`/update-registration/${ID}`);
  // The form still needs valid values to submit, but they aren't real data
  await tab(page, 'Contact').tap();
  await page.locator('#email').fill('typed@example.com');
  await page.locator('#phone').fill('215550123');
  await tab(page, 'Details').tap();
  await page.locator('#piWalletAddress').fill('GTYPEDWALLET');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  const body = patches[0]!;
  expect(body).not.toHaveProperty('contact_info');
  expect(body).not.toHaveProperty('hours');
  expect(body).not.toHaveProperty('pi_wallet_address');
  expect(body['business_name']).toBe(ROW.business_name);
  await expect(page.getByText("Some details couldn't be loaded", { exact: false }).first()).toBeVisible();
});

test('the header with Go back stays visible at the top, even scrolled down a long step', async ({ page }) => {
  await setup(page);
  await fromList(page);
  const header = page.locator('header').first();
  await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  await expect(page.locator('#page-title')).toHaveText('Update Business');
  expect((await header.boundingBox())!.y).toBe(0);

  await tab(page, 'Preview').tap();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await header.boundingBox())!.y).toBe(0);
  await expect(page.getByRole('button', { name: 'Go back' })).toBeInViewport();
});

test('other scrolling pages keep their header in view, with no sideways scroll', async ({ page }) => {
  await setup(page);
  await page.goto('/pricing');
  await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect((await page.locator('header').first().boundingBox())!.y).toBe(0);
  const sideways = await page.evaluate(() => {
    window.scrollTo(500, window.scrollY);
    return window.scrollX;
  });
  expect(sideways).toBe(0);
});

test('a direct load: Go back goes to Your businesses, not out of the app', async ({ page }) => {
  await setup(page);
  await page.goto(`/update-registration/${ID}`);
  await expect(tab(page, 'Contact')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL('**/registered-business');
});
