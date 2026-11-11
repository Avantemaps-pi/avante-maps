/**
 * Settings → Profile: the username comes from Pi Network and can't be changed there (the payer
 * check compares users.username with Pi's, and the database refuses a user's own change).
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

async function openProfile(page: Page) {
  const userWrites: string[] = [];
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
  await page.route('**/rest/v1/users*', (route) => {
    const method = route.request().method();
    if (method !== 'GET' && method !== 'HEAD') userWrites.push(method);
    return route.fulfill({ json: method === 'GET' ? [] : {} });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  await page.goto('/settings');
  const username = page.getByRole('textbox', { name: 'Username' });
  // Retry until hydrated: a tap on the SSR markup does nothing
  await expect(async () => {
    if (!(await username.isVisible()))
      await page.getByRole('button', { name: /Profile/ }).click();
    await expect(username).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return { username, userWrites };
}

test('the username is shown read-only, with where it comes from, and is never written', async ({
  page,
}) => {
  const { username, userWrites } = await openProfile(page);
  await expect(username).toHaveValue(mockUser.username);
  await expect(username).not.toBeEditable();
  await expect(
    page.getByText('Username is provided by Pi Network and cannot be changed.'),
  ).toBeVisible();
  // Typing into it changes nothing
  await username.click();
  await page.keyboard.type('Someone');
  await expect(username).toHaveValue(mockUser.username);
  // No editable username field anywhere on the page
  const editable = await page
    .locator('input, textarea, [contenteditable="true"]')
    .evaluateAll((els) =>
      els
        .filter(
          (el) =>
            !(el as HTMLInputElement).readOnly &&
            !(el as HTMLInputElement).disabled,
        )
        .map((el) =>
          `${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase(),
        )
        .filter((label) => label.includes('username')),
    );
  expect(editable).toEqual([]);
  expect(userWrites).toEqual([]);
});
