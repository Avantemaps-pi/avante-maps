/**
 * Edit listing (/update-registration/$businessId): an overview with one row per section, each
 * opening its own screen (/update-registration/$businessId/$section) with only that section's
 * fields and one Save, which saves only that section's columns.
 *
 * 360x780 with the sandbox session, a fake Supabase session (the page reads the session user)
 * and mocked Supabase tables.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

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
const WALLET = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const ID = 56;
const ROW = {
  id: ID, business_name: 'Harbour Light Coffee', owner_id: mockUser.uid, category: 'Coffee Shop', business_description: 'Coffee by the harbour, roasted in small batches every week.',
  city: 'Cape Town', country: 'South Africa', images: [], is_verified: false, is_certified: false, verification_status: null, is_active: true,
  created_at: '2026-10-01T00:00:00Z', lat: -33.92, lng: 18.421, business_types: ['Food'], keywords: [], location: 'Cape Town',
  street_address: '12 Dock Road', state: 'Western Cape', zip_code: '8001', coordinates: null,
  contact_info: CONTACT, hours: HOURS, pi_wallet_address: WALLET,
  notify_new_message_email: true, contact_email_verified_for: null,
};
const PHOTO = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="%232563EB"/></svg>';

const NEW_POSITION = { lat: -33.9321, lng: 18.8602 };

async function setup(page: Page, row: Record<string, unknown> = ROW, geocoder: 'works' | 'fails' = 'works') {
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
    // Only the columns asked for, as PostgREST does
    const select = url.searchParams.get('select') ?? '*';
    const columns = select.split(',').map((c) => c.trim());
    const picked = select === '*' ? row : Object.fromEntries(Object.entries(row).filter(([key]) => columns.includes(key)));
    return route.fulfill({ json: match ? [picked] : [] });
  });
  await page.addInitScript((s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)), session);
  const geocoded: string[] = [];
  await page.route('**/functions/v1/geocode-address', (route) => {
    geocoded.push((route.request().postDataJSON() as { address: string }).address);
    return geocoder === 'fails'
      ? route.fulfill({ status: 500, json: { error: 'boom' } })
      : route.fulfill({ json: { suggestions: [{ lat: NEW_POSITION.lat, lon: NEW_POSITION.lng, address: {} }] } });
  });
  return { gets, patches, geocoded };
}

const fromList = async (page: Page) => {
  await page.goto('/registered-business');
  await page.getByRole('button', { name: 'Edit' }).first().tap();
  await page.waitForURL(`**/update-registration/${ID}`);
};
const sections = (page: Page) => page.getByRole('list', { name: 'Listing sections' });
const row = (page: Page, title: string) => sections(page).getByRole('link', { name: new RegExp(`^${title}`) });
const summary = (page: Page, id: string) => page.getByTestId(`summary-${id}`);
const save = (page: Page) => page.getByRole('button', { name: 'Save', exact: true });
const overviewUrl = `/update-registration/${ID}`;
const path = (page: Page) => new URL(page.url()).pathname;

async function openSection(page: Page, title: string, slug: string) {
  await row(page, title).tap();
  await page.waitForURL(`**${overviewUrl}/${slug}`);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

const HOURS_SUMMARY = 'Mon 08:00–18:00 · Tue 08:30–18:00 · Wed 08:00–18:00 · Thu 08:00–20:00 · Fri 08:00–21:00 · Sat 09:00–13:00 · Closed Sun';

// ---- The overview

test('the overview: the business, then six section rows with their summaries', async ({ page }) => {
  const { gets } = await setup(page);
  await fromList(page);
  await expect(page.locator('#page-title')).toHaveText('Edit listing');
  await expect(page.getByRole('heading', { name: 'Harbour Light Coffee' })).toBeVisible();
  await expect(page.getByText(`Owner @${mockUser.username}`)).toBeVisible();
  await expect(page.getByText('Not verified yet')).toBeVisible();

  const links = sections(page).getByRole('link');
  await expect(links).toHaveCount(6);
  const titles = await links.evaluateAll((els) => els.map((el) => el.querySelector('span > span')?.textContent));
  expect(titles).toEqual(['Name and category', 'Address', 'Contact', 'Hours', 'Photos and description', 'Payout wallet']);

  await expect(summary(page, 'name')).toHaveText('Harbour Light Coffee · Coffee Shop');
  await expect(summary(page, 'address')).toHaveText('12 Dock Road, Cape Town');
  await expect(summary(page, 'contact')).toHaveText('Phone · Email · Website');
  await expect(summary(page, 'hours')).toHaveText(HOURS_SUMMARY);
  await expect(summary(page, 'photos')).toHaveText('No photos · 10 words');
  await expect(summary(page, 'wallet')).toHaveText('GBRP…OX2H');
  await expect(summary(page, 'wallet')).toHaveCSS('font-family', /mono/i);

  // Bordered list rows at least 56px tall; a long summary ends in an ellipsis on one line
  for (const link of await links.all()) {
    expect(Math.round((await link.boundingBox())!.height)).toBeGreaterThanOrEqual(56);
  }
  await expect(summary(page, 'hours')).toHaveCSS('text-overflow', 'ellipsis');
  await expect(summary(page, 'hours')).toHaveCSS('white-space', 'nowrap');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // No Owner or Preview step, and no step chips
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Submit Registration' })).toHaveCount(0);

  // The list brought everything, so the page needed no second load
  expect(gets.filter((q) => q.includes(`id=eq.${ID}`))).toHaveLength(0);
});

test('the first photo heads the overview; the status reads Verified or Certified', async ({ page }) => {
  await setup(page, { ...ROW, images: [PHOTO, PHOTO, PHOTO], is_verified: true });
  await page.goto(overviewUrl);
  await expect(page.getByText('Verified', { exact: true })).toBeVisible();
  await expect(page.locator('main img').first()).toHaveAttribute('src', PHOTO);
  await expect(summary(page, 'photos')).toHaveText('3 photos · 10 words');
});

test('a certified business reads Certified', async ({ page }) => {
  await setup(page, { ...ROW, is_verified: true, is_certified: true });
  await page.goto(overviewUrl);
  await expect(page.getByText('Certified', { exact: true })).toBeVisible();
});

test('a direct load reads the business by the route id for the session user', async ({ page }) => {
  const { gets } = await setup(page);
  await page.goto(overviewUrl);
  await expect(row(page, 'Hours')).toBeVisible();
  expect(gets.some((q) => q.includes(`id=eq.${ID}`) && q.includes(`owner_id=eq.${mockUser.uid}`))).toBe(true);
});

test("someone else's business, or no such id: the existing message, no rows", async ({ page }) => {
  await setup(page);
  await page.goto('/update-registration/999');
  await expect(page.getByText("We couldn't find this business on your account.")).toBeVisible();
  await expect(sections(page)).toHaveCount(0);
  // Nor a section of it
  await page.goto('/update-registration/999/hours');
  await expect(page.getByText("We couldn't find this business on your account.")).toBeVisible();
  await expect(page.locator('input[type="time"]')).toHaveCount(0);
});

test('no Supabase session: asks to log in, no rows, no business query', async ({ page }) => {
  const { gets } = await setup(page);
  await page.addInitScript(() => localStorage.removeItem('supabase.auth.token'));
  await page.goto(overviewUrl);
  await expect(page.getByText('Please log in to edit your business.')).toBeVisible();
  await expect(sections(page)).toHaveCount(0);
  expect(gets.filter((q) => q.includes(`id=eq.${ID}`))).toHaveLength(0);
});

test('View listing opens the public business page', async ({ page }) => {
  await setup(page);
  await page.goto(overviewUrl);
  const view = page.getByRole('link', { name: 'View listing' });
  await expect(view).toHaveAttribute('href', `/recommendations/${ID}`);
  await view.tap();
  await page.waitForURL(`**/recommendations/${ID}`);
});

test('a direct load: Go back goes to Your businesses, not out of the app', async ({ page }) => {
  await setup(page);
  await page.goto(overviewUrl);
  await expect(row(page, 'Hours')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL('**/registered-business');
});

// ---- A section

test('Hours: only the hours fields; Save → toast → the overview with the new summary, and only hours sent', async ({ page }) => {
  const { patches } = await setup(page);
  await fromList(page);
  await openSection(page, 'Hours', 'hours');
  await expect(page.locator('input[type="time"]')).toHaveCount(14);
  for (const other of ['#businessName', '#streetAddress', '#email', '#piWalletAddress', '#businessDescription']) {
    await expect(page.locator(other)).toHaveCount(0);
  }
  await expect(page.locator('#page-title')).toHaveText('Edit listing');
  await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();

  // Save: full width at the bottom of the section
  const button = (await save(page).boundingBox())!;
  expect(Math.round(button.width)).toBeGreaterThanOrEqual(360 - 2 * 24);

  await page.locator('input[type="time"]').nth(2).fill('08:00'); // Tuesday opens at 08:00
  await save(page).tap();
  await expect(page.getByText('Hours saved')).toBeVisible();
  await page.waitForURL(`**${overviewUrl}`);
  expect(path(page)).toBe(overviewUrl);
  await expect(summary(page, 'hours')).toHaveText('Mon–Wed 08:00–18:00 · Thu 08:00–20:00 · Fri 08:00–21:00 · Sat 09:00–13:00 · Closed Sun');

  expect(patches).toHaveLength(1);
  expect(Object.keys(patches[0]!)).toEqual(['hours']);
  expect(patches[0]!['hours']).toEqual({ ...HOURS, tuesday: { ...HOURS.tuesday, open: '08:00' } });
  // Every other summary as before
  await expect(summary(page, 'contact')).toHaveText('Phone · Email · Website');
  await expect(summary(page, 'wallet')).toHaveText('GBRP…OX2H');

  // Back from the overview leaves Edit listing: the section isn't left in the history
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL('**/registered-business');
});

test('a reload on a section route stays on that section', async ({ page }) => {
  await setup(page);
  await fromList(page);
  await openSection(page, 'Hours', 'hours');
  await page.reload();
  expect(path(page)).toBe(`${overviewUrl}/hours`);
  await expect(page.getByRole('heading', { name: 'Hours' })).toBeVisible();
  await expect(page.locator('input[type="time"]').nth(1)).toHaveValue('18:00');
});

test('a section opened directly: Back goes to the overview', async ({ page }) => {
  await setup(page);
  await page.goto(`${overviewUrl}/address`);
  await expect(page.locator('#city')).toHaveValue('Cape Town');
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL(`**${overviewUrl}`);
  await expect(row(page, 'Address')).toBeVisible();
});

test('unsaved changes + Back: the unsaved-changes dialog; Stay keeps them, Leave drops them', async ({ page }) => {
  const { patches } = await setup(page);
  await fromList(page);
  await openSection(page, 'Name and category', 'name');
  await page.locator('#businessName').fill('Harbour Light Roasters');
  await page.getByRole('button', { name: 'Go back' }).tap();
  const dialog = page.getByRole('alertdialog', { name: 'Unsaved Changes' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Stay on Page' }).tap();
  await expect(dialog).toHaveCount(0);
  expect(path(page)).toBe(`${overviewUrl}/name`);
  await expect(page.locator('#businessName')).toHaveValue('Harbour Light Roasters');

  // Browser Back asks too
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Leave Page' }).tap();
  await page.waitForURL(`**${overviewUrl}`);
  await expect(summary(page, 'name')).toHaveText('Harbour Light Coffee · Coffee Shop');
  expect(patches).toEqual([]);
});

test('no changes: Back leaves without asking', async ({ page }) => {
  await setup(page);
  await fromList(page);
  await openSection(page, 'Contact', 'contact');
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL(`**${overviewUrl}`);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('Name and category: only the name and types, saving only those columns', async ({ page }) => {
  const { patches } = await setup(page);
  await fromList(page);
  await openSection(page, 'Name and category', 'name');
  await expect(page.locator('#businessName')).toHaveValue('Harbour Light Coffee');
  await expect(page.locator('input[type="time"]')).toHaveCount(0);
  await page.locator('#businessName').fill('Harbour Light Roasters');
  await save(page).tap();
  await expect(page.getByText('Name and category saved')).toBeVisible();
  await page.waitForURL(`**${overviewUrl}`);
  await expect(summary(page, 'name')).toHaveText('Harbour Light Roasters · Coffee Shop');
  expect(patches).toEqual([{ business_name: 'Harbour Light Roasters', business_types: ['Food'] }]);
});

// ---- Contact

const emailSwitch = (page: Page) => page.getByRole('switch', { name: 'Email me when a customer messages this business' });
const CONFIRMED = 'Sent to your confirmed contact email.';
const UNCONFIRMED = 'Confirm your contact email in CommuniCon to get these emails.';

test('Contact: changing the email saves contact_info and the switch only, and never the confirmation', async ({ page }) => {
  const { patches, geocoded } = await setup(page);
  await fromList(page);
  await openSection(page, 'Contact', 'contact');
  await expect(page.locator('#phone')).toHaveValue('215550123');
  await expect(page.getByRole('combobox').first()).toContainText('+27');
  await page.locator('#email').fill('new@harbour.example');
  await save(page).tap();
  await expect(page.getByText('Contact saved')).toBeVisible();
  await page.waitForURL(`**${overviewUrl}`);
  expect(patches).toHaveLength(1);
  expect(Object.keys(patches[0]!).sort()).toEqual(['contact_info', 'notify_new_message_email']);
  expect(patches[0]!['contact_info']).toEqual({ ...CONTACT, email: 'new@harbour.example' });
  expect(patches[0]!['notify_new_message_email']).toBe(true);
  expect(geocoded).toEqual([]);
});

test('contact verification: a confirmed email reads verified on the overview and in Contact, until another is typed', async ({ page }) => {
  await setup(page, { ...ROW, contact_email_verified_for: CONTACT.email });
  await page.goto(overviewUrl);
  await expect(summary(page, 'contact')).toHaveText('Phone · Email verified · Website');
  await openSection(page, 'Contact', 'contact');
  await expect(page.getByText(CONFIRMED)).toBeVisible();
  await page.locator('#email').fill('new@harbour.example');
  await expect(page.getByText(UNCONFIRMED)).toBeVisible();
  // Same address, different case and spaces: still the confirmed one
  await page.locator('#email').fill(' Hello@Harbour.example ');
  await expect(page.getByText(CONFIRMED)).toBeVisible();
});

test('the new-message email switch loads its stored value and saves the change', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, notify_new_message_email: false });
  await page.goto(`${overviewUrl}/contact`);
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(UNCONFIRMED)).toBeVisible();
  await emailSwitch(page).tap();
  await save(page).tap();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]!['notify_new_message_email']).toBe(true);
});

test('an invalid stored website: Contact shows the error, focuses it, sends nothing; Hours still saves', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, contact_info: { ...CONTACT, website: 'https://harbour.example' } });
  await page.goto(`${overviewUrl}/contact`);
  await save(page).tap();
  await expect(page.getByText('Website URL must start with https:// and contain a .pinet subdomain', { exact: false })).toBeVisible();
  await expect(page.locator('#website')).toBeFocused();
  await expect(page.getByText('Fix the highlighted field to save')).toBeVisible();
  expect(patches).toEqual([]);

  // Another section's stored value doesn't stop this one
  await page.goto(`${overviewUrl}/hours`);
  await page.locator('input[type="time"]').nth(1).fill('17:00');
  await save(page).tap();
  await expect.poll(() => patches.length).toBe(1);
  expect(Object.keys(patches[0]!)).toEqual(['hours']);
});

// ---- Address

const ADDRESS_UNCHANGED = { street_address: ROW.street_address, state: ROW.state, zip_code: ROW.zip_code, country: ROW.country };

test('Address: no Apartment box; a new city saves the address columns only, and moves the pin', async ({ page }) => {
  const { patches, geocoded } = await setup(page);
  await fromList(page);
  await openSection(page, 'Address', 'address');
  await expect(page.locator('#apartment')).toHaveCount(0);
  await page.locator('#city').fill('Stellenbosch');
  await save(page).tap();
  await expect(page.getByText('Address saved', { exact: true })).toBeVisible();
  await page.waitForURL(`**${overviewUrl}`);
  await expect(summary(page, 'address')).toHaveText('12 Dock Road, Stellenbosch');
  expect(patches).toHaveLength(1);
  expect(patches[0]).toEqual({ ...ADDRESS_UNCHANGED, city: 'Stellenbosch', ...NEW_POSITION, coordinates: JSON.stringify(NEW_POSITION) });
  expect(geocoded).toEqual(['12 Dock Road, Stellenbosch, Western Cape, 8001, South Africa']);
});

test('when the geocoder fails: the address is saved, the position stays, a toast says so', async ({ page }) => {
  const { patches } = await setup(page, ROW, 'fails');
  await page.goto(`${overviewUrl}/address`);
  await page.locator('#city').fill('Stellenbosch');
  await save(page).tap();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ ...ADDRESS_UNCHANGED, city: 'Stellenbosch' });
  await expect(page.getByText("Address saved, but we couldn't update the map pin")).toBeVisible();
});

// Nothing ties the Verified badge to the address today (verify-business checks the wallet and the
// confirmed contact email; no trigger resets it), so no business gets a warning before saving
for (const [kind, flags] of [
  ['verified', { is_verified: true, verification_status: 'verified' }],
  ['unverified', {}],
] as const) {
  test(`a ${kind} business changing its address: no warning, it saves straight away`, async ({ page }) => {
    const { patches } = await setup(page, { ...ROW, ...flags });
    await page.goto(`${overviewUrl}/address`);
    await page.locator('#streetAddress').fill('14 Dock Road');
    await save(page).tap();
    await expect(page.getByText('Address saved', { exact: true })).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(patches).toHaveLength(1);
    expect(patches[0]).not.toHaveProperty('is_verified');
    expect(patches[0]).toMatchObject({ street_address: '14 Dock Road' });
  });
}

// ---- Photos and description

test('Photos: three photos already, so no more can be added', async ({ page }) => {
  await setup(page, { ...ROW, images: [PHOTO, PHOTO, PHOTO] });
  await page.goto(overviewUrl);
  await openSection(page, 'Photos and description', 'photos');
  await expect(page.getByText('(3/3)')).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await expect(page.locator('input[type="file"]')).toBeDisabled();
  await expect(page.getByText('Add Image')).toHaveCount(0);
  await expect(page.locator('#businessDescription')).toBeVisible();
});

test('Photos: removing one saves the other two and the description, nothing else', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, images: [PHOTO, `${PHOTO}#2`, `${PHOTO}#3`] });
  await page.goto(`${overviewUrl}/photos`);
  await page.getByRole('button', { name: 'Remove photo' }).first().tap();
  await expect(page.getByText('(2/3)')).toBeVisible();
  await save(page).tap();
  await expect(page.getByText('Photos and description saved')).toBeVisible();
  expect(patches).toEqual([{ business_description: ROW.business_description, images: [`${PHOTO}#2`, `${PHOTO}#3`] }]);
  await page.waitForURL(`**${overviewUrl}`);
  await expect(summary(page, 'photos')).toHaveText('2 photos · 10 words');
});

// ---- Payout wallet

test('Payout wallet: at 360px the whole 56-character address wraps in the field', async ({ page }) => {
  expect(WALLET).toHaveLength(56);
  await setup(page);
  await page.goto(overviewUrl);
  await openSection(page, 'Payout wallet', 'wallet');
  const field = page.locator('#piWalletAddress');
  await expect(field).toHaveValue(WALLET);
  const fit = await field.evaluate((el) => ({
    sideways: el.scrollWidth <= el.clientWidth,
    downwards: el.scrollHeight <= el.clientHeight + 1,
    lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)),
    font: getComputedStyle(el).fontFamily,
  }));
  expect(fit).toMatchObject({ sideways: true, downwards: true, font: expect.stringMatching(/mono/i) });
  expect(fit.lines).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Payout wallet: a pasted address with spaces is saved without them, and only the wallet is sent', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, pi_wallet_address: '' });
  await page.goto(overviewUrl);
  await expect(summary(page, 'wallet')).toHaveText('Not set');
  await openSection(page, 'Payout wallet', 'wallet');
  const field = page.locator('#piWalletAddress');
  await field.click();
  await page.keyboard.insertText(`${WALLET.slice(0, 20)} ${WALLET.slice(20, 40)}  ${WALLET.slice(40)}\n`);
  await expect(field).toHaveValue(WALLET);
  await save(page).tap();
  await expect(page.getByText('Payout wallet saved')).toBeVisible();
  expect(patches).toEqual([{ pi_wallet_address: WALLET }]);
  await page.waitForURL(`**${overviewUrl}`);
  await expect(summary(page, 'wallet')).toHaveText('GBRP…OX2H');
});

// ---- Old links to a field

for (const field of ['piWalletAddress', 'pi_wallet_address']) {
  test(`?field=${field} opens the Payout wallet section, focused on the field`, async ({ page }) => {
    await setup(page);
    await page.goto(`${overviewUrl}?field=${field}`);
    await page.waitForURL(`**${overviewUrl}/wallet`);
    await expect(page.locator('#piWalletAddress')).toBeFocused();
  });
}

test('?field=nonsense: the overview, unchanged', async ({ page }) => {
  await setup(page);
  await page.goto(`${overviewUrl}?field=nonsense`);
  await expect(row(page, 'Hours')).toBeVisible();
  expect(path(page)).toBe(overviewUrl);
});

// ---- Loaded without a section's column: that section isn't saved

test('a business loaded without its hours: saving Hours sends nothing and says so', async ({ page }) => {
  const { hours: _h, ...partial } = ROW;
  const { patches } = await setup(page, partial);
  await page.goto(`${overviewUrl}/hours`);
  await save(page).tap();
  await expect(page.getByText("Some details couldn't be loaded", { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(patches).toEqual([]);
});
