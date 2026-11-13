/**
 * The phone side menu ends with Logout, then a small footer (Privacy · Terms · Contact and the ©
 * line) whose top border lines up with the bottom nav's. Plans and pricing is a menu item after
 * Wallet; Terms, Privacy, Cookies and Contact are also in Settings → Legal and help, and the ©
 * line is at the bottom of About Us and Contact.
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

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

async function setup(page: Page, { loggedIn = true } = {}) {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
  if (!loggedIn) {
    // No saved sandbox user or session
    await page.addInitScript(() => localStorage.clear());
    return;
  }
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
}

const menu = (page: Page) =>
  page.locator('div.fixed.inset-y-0', {
    has: page.getByRole('button', { name: 'Close sidebar' }),
  });

// Retry until hydrated: a tap on the server-rendered markup does nothing
async function openMenu(page: Page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Open menu' }).first().tap();
    await expect(
      menu(page).getByRole('link', { name: 'Wallet', exact: true }),
    ).toBeInViewport({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

const footer = (page: Page) => menu(page).locator('footer');
const bottomNav = (page: Page) => page.locator('nav.fixed.bottom-0');

test('the side menu ends with Logout, then the footer, and lists Plans and pricing after Wallet', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/wallet');
  await openMenu(page);
  const side = menu(page);
  const year = new Date().getFullYear();
  await expect(footer(page).getByRole('link')).toHaveText([
    'Privacy',
    'Terms',
    'Contact',
  ]);
  await expect(footer(page)).toContainText(`© ${year} Avante Maps Pty Ltd`);
  // Pricing is a menu item and Cookie Policy stays in Settings
  for (const name of ['Pricing', 'Cookie Policy', 'Cookies']) {
    await expect(footer(page).getByRole('link', { name })).toHaveCount(0);
  }

  // Plans and pricing straight after Wallet
  const labels = await side
    .getByRole('navigation')
    .getByRole('link')
    .allInnerTexts();
  const names = labels.map((l) => l.trim());
  expect(names.indexOf('Plans and pricing')).toBe(names.indexOf('Wallet') + 1);

  // Logout is the last control above the footer, and sits above its border
  const logout = side.getByRole('button', { name: 'Logout' });
  await expect(logout).toBeVisible();
  const lastAboveFooter = await side.locator('button, a').evaluateAll((els) =>
    els
      .filter((el) => !el.closest('footer'))
      .pop()
      ?.textContent?.trim(),
  );
  expect(lastAboveFooter).toBe('Logout');
  const logoutBox = (await logout.boundingBox())!;
  const footerBox = (await footer(page).boundingBox())!;
  expect(logoutBox.y + logoutBox.height).toBeLessThanOrEqual(footerBox.y);
});

for (const [name, path] of [
  ['Privacy', '/privacy'],
  ['Terms', '/terms'],
  ['Contact', '/contact'],
] as const) {
  test(`the side menu footer's ${name} opens ${path} and closes the menu`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/wallet');
    await openMenu(page);
    const link = footer(page).getByRole('link', { name, exact: true });
    // Tap area at least 24 px high
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await link.tap();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(menu(page)).not.toBeInViewport();
  });
}

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
]) {
  test(`${viewport.width}x${viewport.height}: the footer's top border is on the bottom nav's, two lines, no menu scroll`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto('/wallet');
    await openMenu(page);
    const footerBox = (await footer(page).boundingBox())!;
    const navBox = (await bottomNav(page).boundingBox())!;
    expect(Math.abs(footerBox.y - navBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(footerBox.height - navBox.height)).toBeLessThanOrEqual(1);

    // Two lines: the links on one, the © on the other
    const lines = footer(page).locator('div > div, p');
    const linksBox = (await lines.first().boundingBox())!;
    const copyrightBox = (await footer(page).locator('p').boundingBox())!;
    expect(linksBox.height).toBeLessThanOrEqual(26);
    expect(copyrightBox.height).toBeLessThanOrEqual(18);

    // Logout above the border, and the menu's list doesn't scroll
    const logoutBox = (await menu(page)
      .getByRole('button', { name: 'Logout' })
      .boundingBox())!;
    expect(logoutBox.y + logoutBox.height).toBeLessThanOrEqual(footerBox.y);
    const scrolls = await menu(page)
      .locator('.overflow-y-auto')
      .evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls).toBe(false);
  });
}

test('logged out: no Logout, and the footer still at the bottom, on the bottom nav line', async ({
  page,
}) => {
  await setup(page, { loggedIn: false });
  await page.goto('/wallet');
  await openMenu(page);
  await expect(menu(page).getByRole('button', { name: 'Logout' })).toHaveCount(
    0,
  );
  const footerBox = (await footer(page).boundingBox())!;
  const navBox = (await bottomNav(page).boundingBox())!;
  expect(Math.abs(footerBox.y - navBox.y)).toBeLessThanOrEqual(1);
  expect(footerBox.y + footerBox.height).toBeCloseTo(812, 0);
});

test('Plans and pricing opens /pricing', async ({ page }) => {
  await setup(page);
  await page.goto('/wallet');
  await openMenu(page);
  await menu(page)
    .getByRole('link', { name: 'Plans and pricing', exact: true })
    .tap();
  await expect(page).toHaveURL(/\/pricing$/);
});

for (const [name, path] of [
  ['Terms of Service', '/terms'],
  ['Privacy Policy', '/privacy'],
  ['Cookie Policy', '/cookies'],
  ['Contact us', '/contact'],
] as const) {
  test(`Settings → Legal and help → ${name} opens ${path}`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/settings');
    const row = page.getByRole('link', { name, exact: true });
    await expect(async () => {
      if (!(await row.isVisible()))
        await page.getByRole('button', { name: /Legal and help/ }).click();
      await expect(row).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await row.tap();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  });
}

test('Settings → Legal and help lists the four rows in order, each with a chevron', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/settings');
  const group = page.getByRole('region', { name: /Legal and help/ });
  await expect(async () => {
    if (!(await group.isVisible()))
      await page.getByRole('button', { name: /Legal and help/ }).click();
    await expect(group).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  const rows = group.getByRole('link');
  await expect(rows).toHaveText([
    'Terms of Service',
    'Privacy Policy',
    'Cookie Policy',
    'Contact us',
  ]);
  for (const row of await rows.all()) {
    await expect(row.locator('svg.lucide-chevron-right')).toHaveCount(1);
  }
});

test('the © line is at the bottom of About Us', async ({ page }) => {
  await setup(page);
  await page.goto('/about');
  const year = new Date().getFullYear();
  const line = page.getByText(
    `© ${year} Avante Maps Pty Ltd. All rights reserved.`,
  );
  await expect(line).toBeVisible();
});

test('the © line on Contact has the current year', async ({ page }) => {
  await setup(page);
  await page.goto('/contact');
  const year = new Date().getFullYear();
  await expect(
    page.getByText(`© ${year} Avante Maps Pty Ltd. All rights reserved.`),
  ).toBeVisible();
  await expect(page.getByText('© 2025 Avante Maps.')).toHaveCount(0);
});
