/**
 * Pi ecosystem listing checks (docs/listing-readiness-audit.md): no Pi Network logo, an Avante Maps
 * share image, and the listing-facing copy.
 *
 * 375x812 with mocked Supabase. Signed out unless a test signs in with a fake Supabase session.
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

async function setup(page: Page, { loggedIn = false } = {}) {
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(page, NEARBY_BUSINESSES);
  if (!loggedIn) {
    await page.addInitScript(() => localStorage.clear());
    return;
  }
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
}

// Any image (img, or an svg <image>) that points at a Pi Network logo file
const piLogoImages = (page: Page) =>
  page.locator(
    'img[src*="pi-network"], img[alt="Pi Network"], img[src*="816179f9"], image[href*="816179f9"]',
  );

// ---- Branding

test('landing page: no Pi Network logo, the Avante mark above "Made For Pi. Not Made By Pi."', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/');
  await page.keyboard.press('Escape');
  const callout = page.locator('section', {
    has: page.getByRole('heading', { name: 'Made For Pi. Not Made By Pi.' }),
  });
  await expect(callout).toBeVisible();
  await expect(callout.locator('svg')).toHaveCount(1);
  await expect(callout.locator('img')).toHaveCount(0);
  await expect(piLogoImages(page)).toHaveCount(0);
  const year = new Date().getFullYear();
  await expect(
    page.getByText(
      `© ${year} Avante Maps Pty Ltd. An independent app for Pi users.`,
    ),
  ).toBeVisible();
  await expect(page.getByText(/Built on the Pi Network/)).toHaveCount(0);
});

test('sign-in dialog: a user icon in the "Pi Network User" row, not the Pi logo', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Sign in to Avante Maps' });
  await expect(dialog).toBeVisible();
  const row = dialog.locator('div.rounded-xl', { hasText: 'Pi Network User' });
  await expect(row.locator('svg.lucide-user-round')).toHaveCount(1);
  // The only image is the Avante Maps icon in the header
  await expect(dialog.locator('img')).toHaveAttribute(
    'src',
    '/lovable-uploads/Avante-Maps-icon.svg',
  );
  await expect(piLogoImages(page)).toHaveCount(0);
});

test('Contact FAQ: "Is Avante Maps affiliated with Pi Network?" starts with "No."', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/contact');
  const answer = page.getByText(/^No\. Avante Maps is an independent platform/);
  // Retry until hydrated: a tap on the server-rendered markup does nothing
  await expect(async () => {
    await page
      .getByRole('button', {
        name: 'Is Avante Maps affiliated with Pi Network?',
      })
      .tap();
    await expect(answer).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
});

// ---- Share image

test('og-image.png is a 1200x630 PNG, and the page says so', async ({
  page,
  request,
}) => {
  const response = await request.get('/og-image.png');
  expect(response.status()).toBe(200);
  const png = await response.body();
  // PNG signature, then the IHDR chunk: width and height as big-endian 32-bit integers
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
  expect(png.length).toBeLessThanOrEqual(300 * 1024);

  await setup(page);
  await page.goto('/');
  await expect(
    page.locator('meta[property="og:image:width"]').first(),
  ).toHaveAttribute('content', '1200');
  await expect(
    page.locator('meta[property="og:image:height"]').first(),
  ).toHaveAttribute('content', '630');
});

// ---- Privacy, cookies and contact

test('Privacy Policy: support@avantemaps.com, the real processors, and no "Pi Network and other partners"', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/privacy');
  const policy = page.locator('main');
  await expect(policy.getByText('Effective Date:')).toBeVisible();
  await expect(policy).toContainText('November 13, 2026');
  await expect(policy).toContainText('Avante Maps Pty Ltd');
  await expect(policy).toContainText('support@avantemaps.com');
  for (const processor of [
    'Supabase',
    'Vercel',
    'Brevo',
    'Lovable AI gateway',
    'ipwho.is',
    'ipapi.co',
    'geojs.io',
    'OpenStreetMap',
  ]) {
    await expect(policy).toContainText(processor);
  }
  await expect(policy).toContainText("We don't sell your data.");
  await expect(policy).not.toContainText(/other partners|Business Partners/i);
  await expect(policy).not.toContainText('privacy@avantemaps.com');
  await expect(policy).not.toContainText(/Name, email, phone/);
});

test('Cookie Policy: no advertising or tracking cookies, and support@avantemaps.com', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/cookies');
  const policy = page.locator('main');
  await expect(policy).toContainText('uses no advertising cookies');
  await expect(policy).toContainText(
    'Your own location is never saved in your browser',
  );
  await expect(policy).toContainText('support@avantemaps.com');
  await expect(
    policy.getByRole('heading', {
      name: /Advertising Cookies|Social Media Cookies|Web Beacons/,
    }),
  ).toHaveCount(0);
});

test('Contact: support@avantemaps.com shown, no partnerships@ mailbox', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/contact');
  await expect(
    page.getByText('support@avantemaps.com', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText(
    /partnerships@|inquiries@avantemaps\.com/,
  );
});

// ---- Realtime

test("the page's CSP lets the Supabase realtime socket (wss://) connect", async ({
  page,
}) => {
  await setup(page, { loggedIn: true });
  await page.goto('/notifications');
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  const connectSrc = (csp ?? '')
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('connect-src'));
  // https: doesn't cover wss:, so the realtime origin has to be named
  expect(connectSrc?.split(/\s+/)).toContain(
    'wss://xvpwbocwasbtzrzrxyvu.supabase.co',
  );
});

test('signed in: Notifications subscribes to realtime without the "after subscribe()" error', async ({
  page,
}) => {
  const problems: string[] = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (/Content Security Policy|postgres_changes callbacks/.test(text))
      problems.push(text);
  });
  page.on('pageerror', (error) => problems.push(error.message));
  // A local stand-in for Supabase realtime (Playwright replaces the page's WebSocket, so this
  // can't show a CSP block; the test above covers the CSP)
  let sockets = 0;
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    sockets += 1;
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as {
        topic: string;
        event: string;
        ref: string;
        join_ref?: string;
      };
      if (msg.event === 'phx_join' || msg.event === 'heartbeat') {
        ws.send(
          JSON.stringify({
            topic: msg.topic,
            event: 'phx_reply',
            ref: msg.ref,
            join_ref: msg.join_ref,
            payload: { status: 'ok', response: { postgres_changes: [] } },
          }),
        );
      }
    });
  });
  await setup(page, { loggedIn: true });
  await page.goto('/notifications');
  await expect.poll(() => sockets, { timeout: 15_000 }).toBeGreaterThan(0);
  // Long enough for the subscription (and a StrictMode remount in dev) to have run
  await page.waitForTimeout(1_500);
  expect(problems).toEqual([]);
});

// ---- Small cleanups

test('Pricing: no ads lines and no Discord perk in any plan', async ({
  page,
}) => {
  await setup(page);
  await page.route('**/rest/v1/pi_price*', (route) =>
    route.fulfill({
      json: { price_usd: 0.0767, updated_at: '2026-11-04T00:00:00Z' },
    }),
  );
  await page.goto('/pricing');
  await expect(page.getByText('Up to 3 business listings')).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/ads\b|Discord/i);
});

test('About Us: no WhatsApp, X or Facebook links; the email link goes to support@', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/about');
  await expect(
    page.getByRole('link', { name: 'support@avantemaps.com' }),
  ).toHaveAttribute('href', 'mailto:support@avantemaps.com');
  await expect(
    page.locator(
      'a[href*="wa.me"], a[href*="x.com"], a[href*="twitter.com"], a[href*="facebook.com"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /WhatsApp|Twitter|Facebook/ }),
  ).toHaveCount(0);
});

test('landing page: no map screenshot in the hero (the purple-pin image is gone)', async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.keyboard.press('Escape');
  const hero = page.locator('section', {
    has: page.getByRole('heading', { level: 1 }),
  });
  await expect(hero.locator('img')).toHaveCount(0);
  await expect(page.locator('img[src*="map-preview"]')).toHaveCount(0);
});

// Serves the app from another hostname, without leaving the machine
async function asHost(page: Page, origin: string) {
  const local = process.env.PREVIEW_URL ?? 'http://localhost:8080';
  await page.route(`${origin}/**`, async (route) => {
    try {
      const response = await route.fetch({
        url: route.request().url().replace(origin, local),
      });
      await route.fulfill({ response });
    } catch {
      // The test ended while this request was still being forwarded
    }
  });
}

for (const [name, origin, loads] of [
  ['localhost', null, false],
  ['the mainnet host', 'https://mainnet.avantemaps.com', false],
  ['a Lovable preview host', 'https://id-preview--ad58478f.lovable.app', true],
] as const) {
  test(`Lovable's editor script ${loads ? 'loads' : 'is not loaded'} on ${name}`, async ({
    page,
  }) => {
    let requested = 0;
    await page.route('https://cdn.gpteng.co/**', (route) => {
      requested += 1;
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    });
    await setup(page);
    if (origin) await asHost(page, origin);
    await page.goto(origin ? `${origin}/about` : '/about');
    await expect(page.getByRole('heading', { name: 'Map data' })).toBeVisible();
    const tags = page.locator('script[src*="gptengineer"]');
    if (loads) {
      await expect(tags).toHaveCount(1);
      await expect.poll(() => requested).toBe(1);
    } else {
      await page.waitForTimeout(1_000);
      await expect(tags).toHaveCount(0);
      expect(requested).toBe(0);
    }
  });
}

// ---- No home address

for (const path of ['/contact', '/privacy', '/cookies']) {
  test(`${path}: the address is "Pietermaritzburg, South Africa", with no street or postcode`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto(path);
    await expect(
      page.getByText('Pietermaritzburg, South Africa'),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText(/Jabu|Ndlovu|3201/);
  });
}
