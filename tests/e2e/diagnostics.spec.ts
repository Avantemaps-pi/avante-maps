/**
 * /diagnostics: what this browser supports for notifications, for checking the Pi Browser on a
 * phone. Not linked from anywhere, not in the sitemap, and noindex.
 *
 * Admins only: everyone else gets the 404 page.
 *
 * 375x812, signed in as an admin with the sandbox session (Supabase mocked) unless a test says
 * otherwise. The real Pi SDK is blocked; some tests stub window.Pi instead.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { test, expect, type Page } from './helpers/fixtures';
import { SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser } from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

const LABELS = [
  'User agent',
  'Pi Browser (user agent)',
  'window.Pi',
  'Host',
  'Pi nativeFeaturesList()',
  "'serviceWorker' in navigator",
  "'PushManager' in window",
  "'Notification' in window",
  'Notification.permission',
  "permissions.query('notifications')",
  'display-mode: standalone',
  "'setAppBadge' in navigator",
];

async function setup(
  page: Page,
  options: {
    pi?: boolean;
    clipboardFails?: boolean;
    as?: 'admin' | 'user' | 'signed-out';
  } = {},
) {
  await page.route('**/pi-sdk.js', (route) => route.abort());
  const as = options.as ?? 'admin';
  if (as !== 'signed-out') {
    await page.route('https://xvpwbocwasbtzrzrxyvu.supabase.co/**', (route) =>
      route.fulfill({ json: [] }),
    );
    // Roles are re-read from user_roles after sign-in steps
    await page.route('**/rest/v1/user_roles*', (route) =>
      route.fulfill({
        json:
          as === 'admin'
            ? [{ role: 'user' }, { role: 'admin' }]
            : [{ role: 'user' }],
      }),
    );
    await page.addInitScript(
      ([mockKey, storageKey, user]) => {
        localStorage.setItem(mockKey as string, '1');
        localStorage.setItem(storageKey as string, JSON.stringify(user));
      },
      [
        SANDBOX_MOCK_KEY,
        STORAGE_KEY,
        {
          ...mockUser,
          roles: as === 'admin' ? ['user', 'admin'] : ['user'],
          lastAuthenticated: Date.now(),
        },
      ],
    );
  }
  await page.addInitScript(
    ({ pi, clipboardFails }) => {
      const w = window as unknown as {
        Pi?: object;
        __copied: string[];
        __piCopied: string[];
        __piInitialized?: boolean;
      };
      w.__copied = [];
      w.__piCopied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text: string) => {
            if (clipboardFails) return Promise.reject(new Error('denied'));
            w.__copied.push(text);
            return Promise.resolve();
          },
        },
      });
      if (pi) {
        w.__piInitialized = true;
        w.Pi = {
          init: () => undefined,
          nativeFeaturesList: () => Promise.resolve(['a', 'b']),
          requestPermission: () =>
            Promise.reject(new Error('Permission not supported')),
          copyText: (text: string) => {
            w.__piCopied.push(text);
          },
        };
      }
    },
    {
      pi: options.pi ?? false,
      clipboardFails: options.clipboardFails ?? false,
    },
  );
}

const row = (page: Page, label: string) =>
  page.locator(`[data-row="${label}"] dd`);

async function openPage(page: Page) {
  await page.goto('/diagnostics');
  await expect(row(page, "'setAppBadge' in navigator")).toBeVisible();
}

test('every row renders in a normal browser with Pi absent', async ({
  page,
}) => {
  await setup(page);
  await openPage(page);
  await expect(page.locator('#page-title')).toHaveText('Diagnostics');
  for (const label of LABELS)
    await expect(page.locator(`[data-row="${label}"]`), label).toBeVisible();
  await expect(row(page, 'window.Pi')).toHaveText('no');
  await expect(row(page, 'Pi Browser (user agent)')).toHaveText('no');
  await expect(row(page, 'Pi nativeFeaturesList()')).toHaveText(
    'not available',
  );
  await expect(row(page, 'Host')).toHaveText(new URL(page.url()).host);
  await expect(row(page, "'serviceWorker' in navigator")).toHaveText(
    /^(true|false)$/,
  );
  await expect(row(page, 'User agent')).toHaveCSS('font-family', /mono/i);
  // A task page: back arrow, no bottom nav
  await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  await expect(page.locator('nav').filter({ hasText: 'Discover' })).toHaveCount(
    0,
  );
});

test('noindex, and no link to it anywhere on the map or in the menu', async ({
  page,
}) => {
  await setup(page);
  await openPage(page);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow',
  );
  await page.goto('/');
  await expect(page.locator('a[href="/diagnostics"]')).toHaveCount(0);
});

test('with a stubbed window.Pi: the features, and the Pi permission error', async ({
  page,
}) => {
  await setup(page, { pi: true });
  await openPage(page);
  await expect(row(page, 'window.Pi')).toHaveText('yes');
  await expect(row(page, 'Pi nativeFeaturesList()')).toHaveText('["a","b"]');
  await page.getByRole('button', { name: 'Try Pi permission' }).tap();
  await expect(row(page, "Pi requestPermission('notifications')")).toHaveText(
    'error: Permission not supported',
  );
});

test('Try Pi permission with Pi absent: not available', async ({ page }) => {
  await setup(page);
  await openPage(page);
  await page.getByRole('button', { name: 'Try Pi permission' }).tap();
  await expect(row(page, "Pi requestPermission('notifications')")).toHaveText(
    'not available',
  );
});

test('notification permission granted: the result and a local test notification', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications']);
  await setup(page);
  await openPage(page);
  await page
    .getByRole('button', { name: 'Ask for notification permission' })
    .tap();
  await expect(row(page, 'Notification.requestPermission()')).toHaveText(
    'granted',
  );
  // Notification.permission isn't checked: with Playwright's grant, headless Chromium still
  // reports it as "denied" right after requestPermission() resolves "granted"
  await expect(row(page, 'Test notification')).toHaveText(/^shown|^error/);
});

test('buttons are 44px tall', async ({ page }) => {
  await setup(page);
  await openPage(page);
  for (const name of [
    'Ask for notification permission',
    'Try Pi permission',
    'Copy results',
  ]) {
    expect(
      Math.round(
        (await page.getByRole('button', { name }).boundingBox())!.height,
      ),
      name,
    ).toBe(44);
  }
});

test('Copy results puts every label on the clipboard', async ({ page }) => {
  await setup(page);
  await openPage(page);
  await page.getByRole('button', { name: 'Copy results' }).tap();
  await expect(page.getByText('Copied')).toBeVisible();
  const copied = await page.evaluate(
    () => (window as unknown as { __copied: string[] }).__copied,
  );
  expect(copied).toHaveLength(1);
  for (const label of LABELS) expect(copied[0], label).toContain(`${label}: `);
});

test('Copy results falls back to Pi copyText when the clipboard refuses', async ({
  page,
}) => {
  await setup(page, { pi: true, clipboardFails: true });
  await openPage(page);
  await page.getByRole('button', { name: 'Copy results' }).tap();
  await expect(page.getByText('Copied')).toBeVisible();
  const piCopied = await page.evaluate(
    () => (window as unknown as { __piCopied: string[] }).__piCopied,
  );
  expect(piCopied[0]).toContain('window.Pi: yes');
});

test('/diagnostics is not in public/sitemap.xml', () => {
  // predev regenerates it when the test server starts (scripts/generate-sitemap.ts, which lists
  // every page by hand); its output has no dates, so the committed file matches
  const sitemap = readFileSync(resolve('public/sitemap.xml'), 'utf8');
  expect(sitemap).toContain('<loc>https://mainnet.avantemaps.com/about</loc>');
  expect(sitemap).not.toContain('diagnostics');
});

for (const as of ['signed-out', 'user'] as const) {
  test(`${as === 'user' ? 'a signed-in non-admin' : 'signed out'}: the 404 page, and none of the diagnostics`, async ({
    page,
  }) => {
    await setup(page, { as });
    await page.goto('/diagnostics');
    await expect(page.getByRole('heading', { name: '404' })).toBeVisible();
    await expect(page.getByText('Location Not Found')).toBeVisible();
    await expect(page.locator('[data-row]')).toHaveCount(0);
    await expect(page.getByText('Access denied')).toHaveCount(0);
  });
}
