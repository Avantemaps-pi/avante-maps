/**
 * The Update business form opens with the business's stored contact details, hours and Pi
 * wallet, and saves them back unchanged. It used to open with blanks and defaults (the list's
 * select left those columns out), so saving would overwrite the real data.
 *
 * 375x812 with the sandbox session, a fake Supabase session (the page reads the session user)
 * and mocked Supabase tables.
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
  notify_new_message_email: true, contact_email_verified_for: null,
};

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
    // Only the columns asked for, as PostgREST does: the original bug was a select missing some
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
  const { patches, geocoded } = await setup(page);
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
  // The address is unchanged, so the pin isn't touched
  expect(body['city']).toBe(ROW.city);
  expect(body).not.toHaveProperty('lat');
  expect(body).not.toHaveProperty('lng');
  expect(body).not.toHaveProperty('coordinates');
  expect(geocoded).toEqual([]);
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

for (const search of ['', '?field=nonsense', '?field=constructor']) {
  test(`opened with "${search}": the first tab, and nothing focused or changed`, async ({ page }) => {
    await setup(page);
    await page.goto(`/update-registration/${ID}${search}`);
    await expect(tab(page, 'Owner')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Details')).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#piWalletAddress')).toHaveCount(0);
    expect(new URL(page.url()).search).toBe(search);
  });
}

test('opened directly on the field: Go back has nowhere earlier, so goes to Your businesses', async ({ page }) => {
  await setup(page);
  await page.goto(`/update-registration/${ID}?field=piWalletAddress`);
  await expect(tab(page, 'Details')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#piWalletAddress')).toBeFocused();
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL('**/registered-business');
});

test('a direct load: Go back goes to Your businesses, not out of the app', async ({ page }) => {
  await setup(page);
  await page.goto(`/update-registration/${ID}`);
  await expect(tab(page, 'Contact')).toBeVisible();
  await page.getByRole('button', { name: 'Go back' }).tap();
  await page.waitForURL('**/registered-business');
});

const ADDRESS_UNCHANGED = { street_address: ROW.street_address, state: ROW.state, zip_code: ROW.zip_code, country: ROW.country };

test('changing the city saves it, keeps the other address fields, and moves the pin', async ({ page }) => {
  const { patches, geocoded } = await setup(page);
  await fromList(page);
  await tab(page, 'Address').tap();
  await expect(page.locator('#city')).toHaveValue(ROW.city);
  await page.locator('#city').fill('Stellenbosch');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  const body = patches[0]!;
  console.log(`PATCH (new city): ${JSON.stringify({ street_address: body['street_address'], city: body['city'], state: body['state'], zip_code: body['zip_code'], country: body['country'], lat: body['lat'], lng: body['lng'], coordinates: body['coordinates'] })}`);
  expect(body).toMatchObject({ ...ADDRESS_UNCHANGED, city: 'Stellenbosch', ...NEW_POSITION });
  // As registration stores it
  expect(JSON.parse(body['coordinates'] as string)).toEqual(NEW_POSITION);
  expect(body).not.toHaveProperty('location');
  expect(geocoded).toEqual(['12 Dock Road, Stellenbosch, Western Cape, 8001, South Africa']);
  await expect(page.getByText("couldn't update the map pin")).toHaveCount(0);
});

test('when the geocoder fails: the address is saved, the position stays, a toast says so', async ({ page }) => {
  const { patches, geocoded } = await setup(page, ROW, 'fails');
  await fromList(page);
  await tab(page, 'Address').tap();
  await page.locator('#city').fill('Stellenbosch');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  const body = patches[0]!;
  console.log(`PATCH (geocoder failed): ${JSON.stringify({ street_address: body['street_address'], city: body['city'], state: body['state'], zip_code: body['zip_code'], country: body['country'], lat: body['lat'], lng: body['lng'], coordinates: body['coordinates'] })}`);
  expect(body).toMatchObject({ ...ADDRESS_UNCHANGED, city: 'Stellenbosch' });
  expect(body).not.toHaveProperty('lat');
  expect(body).not.toHaveProperty('lng');
  expect(body).not.toHaveProperty('coordinates');
  expect(geocoded).toHaveLength(1);
  await expect(page.getByText("Address saved, but we couldn't update the map pin")).toBeVisible();
});

const STREET_WITH_UNIT = { ...ROW, street_address: '12 Dock Road, Unit 4' };
const HINT = 'Include the apartment, suite or unit here, e.g. 12 Dock Road, Unit 4';

test('the Address tab has no Apartment box; a hint describes the street input', async ({ page }) => {
  await setup(page);
  await fromList(page);
  await tab(page, 'Address').tap();
  await expect(page.locator('#streetAddress')).toBeVisible();
  await expect(page.locator('#apartment')).toHaveCount(0);
  const hint = page.getByText(HINT, { exact: true });
  await expect(hint).toBeVisible();
  await expect(hint).toHaveCSS('font-size', '13px');
  await expect(page.locator('#streetAddress')).toHaveAttribute('aria-describedby', (await hint.getAttribute('id'))!);
  // Under the input
  expect((await hint.boundingBox())!.y).toBeGreaterThan((await page.locator('#streetAddress').boundingBox())!.y);
});

test('a unit in the stored street stays once: changing only the city leaves the street as it was', async ({ page }) => {
  const { patches } = await setup(page, STREET_WITH_UNIT);
  await fromList(page);
  await tab(page, 'Address').tap();
  await expect(page.locator('#streetAddress')).toHaveValue('12 Dock Road, Unit 4');
  await page.locator('#city').fill('Stellenbosch');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ street_address: '12 Dock Road, Unit 4', city: 'Stellenbosch' });
  expect(patches[0]).not.toHaveProperty('address_components');
});

test('changing the street and unit saves exactly what was typed, and geocodes it', async ({ page }) => {
  const { patches, geocoded } = await setup(page, STREET_WITH_UNIT);
  await fromList(page);
  await tab(page, 'Address').tap();
  await page.locator('#streetAddress').fill('14 Dock Road, Unit 9');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ street_address: '14 Dock Road, Unit 9', ...NEW_POSITION });
  expect(patches[0]).not.toHaveProperty('address_components');
  expect(geocoded).toEqual(['14 Dock Road, Unit 9, Cape Town, Western Cape, 8001, South Africa']);
});

test('an address not loaded is left out of the save, and nothing is geocoded', async ({ page }) => {
  const { city: _city, ...partial } = ROW;
  const { patches, geocoded } = await setup(page, partial);
  await page.goto(`/update-registration/${ID}`);
  await tab(page, 'Address').tap();
  await page.locator('#city').fill('Typed City');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).not.toHaveProperty('city');
  expect(patches[0]).toMatchObject(ADDRESS_UNCHANGED);
  expect(geocoded).toEqual([]);
});

test('an invalid stored website: Submit jumps to Contact, shows the error, focuses the field, sends nothing', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, contact_info: { ...CONTACT, website: 'https://harbour.example' } });
  await fromList(page);
  await submit(page);
  await expect(tab(page, 'Contact')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Website URL must start with https:// and contain a .pinet subdomain', { exact: false })).toBeVisible();
  await expect(page.locator('#website')).toBeFocused();
  await expect(page.locator('#website')).toBeInViewport();
  await expect(page.getByText('Fix the highlighted field to save')).toBeVisible();
  expect(patches).toEqual([]);
});

test('fixing the field then lets the save go through', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, contact_info: { ...CONTACT, website: 'https://harbour.example' } });
  await fromList(page);
  await submit(page);
  await expect(page.locator('#website')).toBeFocused();
  await page.locator('#website').fill(CONTACT.website);
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect((patches[0]!['contact_info'] as { website: string }).website).toBe(CONTACT.website);
});

for (const width of [320, 375]) {
  test.describe(`the Hours step at ${width}px`, () => {
    test.use({ viewport: { width, height: 812 } });

    test('every time fits inside its card, with 44px tap targets', async ({ page }) => {
      await setup(page);
      await fromList(page);
      await tab(page, 'Hours').tap();
      const card = (await page.getByText('Trading Hours').locator('xpath=ancestor::div[contains(@class,"shadow-xs")][1]').boundingBox())!;
      const times = page.locator('input[type="time"]');
      await expect(times).toHaveCount(14);
      for (const input of await times.all()) {
        const box = (await input.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(card.x);
        expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
        expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
      }
      // Opening and closing share a line, with a gap
      const open = (await times.nth(0).boundingBox())!;
      const close = (await times.nth(1).boundingBox())!;
      expect(close.y).toBe(open.y);
      expect(close.x).toBeGreaterThanOrEqual(open.x + open.width);
      // The whole "Closed" label is the tap target, and tapping it toggles the day
      const closed = page.getByRole('checkbox', { name: 'Monday closed' });
      const label = closed.locator('xpath=ancestor::label');
      const hit = (await label.boundingBox())!;
      expect(Math.round(hit.height)).toBeGreaterThanOrEqual(44);
      expect(Math.round(hit.width)).toBeGreaterThanOrEqual(44);
      await label.getByText('Closed').tap();
      await expect(closed).toBeChecked();
      await expect(times.nth(0)).toBeDisabled();
    });
  });
}

test.describe('the Hours step at 1024px', () => {
  test.use({ viewport: { width: 1024, height: 900 } });

  test('stays one row per day', async ({ page }) => {
    await setup(page);
    await fromList(page);
    await tab(page, 'Hours').tap();
    const closed = (await page.getByRole('checkbox', { name: 'Monday closed' }).boundingBox())!;
    const open = (await page.locator('input[type="time"]').nth(0).boundingBox())!;
    const close = (await page.locator('input[type="time"]').nth(1).boundingBox())!;
    expect(Math.abs(closed.y + closed.height / 2 - (open.y + open.height / 2))).toBeLessThanOrEqual(4);
    expect(close.y).toBe(open.y);
    expect(closed.x).toBeLessThan(open.x);
  });
});

// ---- New-message emails switch (Contact tab, under the email)

const emailSwitch = (page: Page) => page.getByRole('switch', { name: 'Email me when a customer messages this business' });
const CONFIRMED = 'Sent to your confirmed contact email.';
const UNCONFIRMED = 'Confirm your contact email in CommuniCon to get these emails.';

test('the new-message email switch loads its stored value, and saving sends the change', async ({ page }) => {
  const { patches } = await setup(page, { ...ROW, notify_new_message_email: false, contact_email_verified_for: CONTACT.email });
  await fromList(page);
  await tab(page, 'Contact').tap();
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(CONFIRMED)).toBeVisible();
  // Under the email field, above the website
  const switchBox = (await emailSwitch(page).boundingBox())!;
  expect(switchBox.y).toBeGreaterThan((await page.locator('#email').boundingBox())!.y);
  expect(switchBox.y).toBeLessThan((await page.locator('#website').boundingBox())!.y);

  await emailSwitch(page).tap();
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]!['notify_new_message_email']).toBe(true);
});

test('the switch defaults to on, and saving unchanged keeps it on', async ({ page }) => {
  const { patches } = await setup(page);
  await page.goto(`/update-registration/${ID}`);
  await tab(page, 'Contact').tap();
  await expect(emailSwitch(page)).toHaveAttribute('aria-checked', 'true');
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]!['notify_new_message_email']).toBe(true);
});

test("an unconfirmed contact email: the helper says to confirm it; a changed email isn't confirmed either", async ({ page }) => {
  await setup(page);
  await page.goto(`/update-registration/${ID}`);
  await tab(page, 'Contact').tap();
  await expect(page.getByText(UNCONFIRMED)).toBeVisible();
  await expect(page.getByText(CONFIRMED)).toHaveCount(0);
});

test('a confirmed email reads as confirmed until a different one is typed', async ({ page }) => {
  await setup(page, { ...ROW, contact_email_verified_for: CONTACT.email });
  await page.goto(`/update-registration/${ID}`);
  await tab(page, 'Contact').tap();
  await expect(page.getByText(CONFIRMED)).toBeVisible();
  await page.locator('#email').fill('new@harbour.example');
  await expect(page.getByText(UNCONFIRMED)).toBeVisible();
  // Same address, different case and spaces: still the confirmed one
  await page.locator('#email').fill(' Hello@Harbour.example ');
  await expect(page.getByText(CONFIRMED)).toBeVisible();
});

test('a business loaded without the switch column: saving leaves it out', async ({ page }) => {
  const { notify_new_message_email: _n, ...partial } = ROW;
  const { patches } = await setup(page, partial);
  await page.goto(`/update-registration/${ID}`);
  await submit(page);
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).not.toHaveProperty('notify_new_message_email');
});

// users.username can't be changed by its user any more (the payer check compares it with Pi's):
// the owner's Pi username is shown as text, never as a field to type in
test('the Owner tab shows the Pi username as text, with no username input', async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/update-registration/${ID}`);
  await expectStoredValues(page);
  await tab(page, 'Owner').tap();
  const owner = page.getByRole('tabpanel', { name: 'Owner' });
  await expect(owner.getByText('Pi Network Username')).toBeVisible();
  await expect(
    owner.getByText(mockUser.username, { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: /username/i })).toHaveCount(0);
});
