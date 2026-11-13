/**
 * The side menu ends with Logout: no legal links or © at its foot. Plans and pricing is a menu item
 * after Wallet; Terms, Privacy, Cookies and Contact are in Settings → Legal and help, and the ©
 * line is at the bottom of About Us.
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

async function setup(page: Page) {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
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

test('the side menu has no legal links or ©, ends with Logout, and lists Plans and pricing after Wallet', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/wallet');
  await openMenu(page);
  const side = menu(page);
  for (const name of [
    'Privacy Policy',
    'Terms of Service',
    'Cookie Policy',
    'Contact Us',
    'Pricing',
  ]) {
    await expect(side.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  await expect(side.getByText(/©/)).toHaveCount(0);
  await expect(side.getByText(/Pty Ltd/)).toHaveCount(0);

  // Plans and pricing straight after Wallet
  const labels = await side
    .getByRole('navigation')
    .getByRole('link')
    .allInnerTexts();
  const names = labels.map((l) => l.trim());
  expect(names.indexOf('Plans and pricing')).toBe(names.indexOf('Wallet') + 1);

  // Nothing after Logout
  const logout = side.getByRole('button', { name: 'Logout' });
  await expect(logout).toBeVisible();
  const lastButton = await side
    .locator('button, a')
    .evaluateAll((els) => els[els.length - 1]?.textContent?.trim());
  expect(lastButton).toBe('Logout');
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
