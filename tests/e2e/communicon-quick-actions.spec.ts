/**
 * CommuniCon's + in the message box opens a "Quick actions" sheet, so the bot's
 * actions stay one tap away after the starter chips have gone.
 *
 * Sandbox session plus a fake Supabase session (the verification flow loads the
 * owner's businesses with it); chat-ai and the Supabase tables are mocked.
 */
import { test, expect, type Page } from '@playwright/test';
import { SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser } from './helpers/mapMocks';

const UID = mockUser.uid;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const fakeSession = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: { id: UID, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};

// Requests that reached the real Supabase project: every test ends checking there were none.
// verify-business wasn't mocked, so the check ran against the live function with the fake token,
// got a 401, and the card turned into "Verification failed" whenever that answer came back
// before the test looked
const unmocked = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(unmocked.get(page) ?? [], 'requests to the real Supabase project').toEqual([]);
});

const reply = { verified: false, contactConfirmed: false, reason: 'Contact email not confirmed', totalTransactions: 13, creditedTransactions: 4, uniqueWallets: 9 };

async function setup(page: Page) {
  // Registered first, so it only sees what no other route handles
  const leaked: string[] = [];
  unmocked.set(page, leaked);
  await page.route('https://xvpwbocwasbtzrzrxyvu.supabase.co/**', (route) => {
    const url = new URL(route.request().url());
    leaked.push(`${route.request().method()} ${url.pathname}`);
    return route.abort();
  });
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: fakeSession.user }));
  for (const t of ['users', 'user_roles', 'conversations', 'messages', 'notifications']) {
    await page.route(`**/rest/v1/${t}*`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/rest/v1/businesses*', (route) =>
    route.fulfill({ json: [{ id: 9001, business_name: 'Harbour Light Coffee', verification_status: null, is_verified: false, is_active: true, created_at: '2026-10-01T00:00:00Z' }] }),
  );
  await page.route('**/functions/v1/verify-business', (route) => {
    const { business_id: id } = route.request().postDataJSON() as { business_id: number };
    return route.fulfill({ json: { success: true, results: [{ id, name: 'Harbour Light Coffee', ...reply }] } });
  });
  await page.route('**/functions/v1/chat-ai', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Open Your businesses from the menu and tap Update.' } }] })}\n\ndata: [DONE]\n\n`,
    }),
  );
  await page.addInitScript(
    ([mockKey, storageKey, user, session]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(storageKey as string, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }));
      localStorage.setItem('supabase.auth.token', JSON.stringify(session));
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser, fakeSession],
  );
  // These tests start on Bot: as if it was the tab picked earlier in the session
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('communicon-tab')) sessionStorage.setItem('communicon-tab', 'ai');
  });
  await page.goto('/communicon');
  await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
}

const plus = (page: Page) => page.getByRole('button', { name: 'Quick actions' });
const sheet = (page: Page) => page.getByRole('dialog', { name: 'Quick actions' });
const input = (page: Page) => page.getByPlaceholder('Ask about your business...');

async function sendMessage(page: Page, text: string) {
  await input(page).fill(text);
  await input(page).press('Enter');
  await expect(page.getByText(text)).toBeVisible();
}

async function openSheet(page: Page) {
  await plus(page).tap();
  await expect(sheet(page)).toBeVisible();
  // Let the slide-in finish before tapping inside it
  await sheet(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

interface RecordedAnimation {
  who: 'sheet' | 'overlay';
  state: string | null;
  duration: number;
  easing: string;
  start: { translateY: number; opacity: number };
  middle: { translateY: number; opacity: number };
}

// Records each sheet and overlay animation from inside the page as it starts, since a 150ms one
// could be over before the test could read it: its timing, and where it is at the start and halfway
async function recordAnimations(page: Page) {
  await page.evaluate(() => {
    const records: unknown[] = [];
    (window as unknown as { __animations: unknown[] }).__animations = records;
    document.addEventListener('animationstart', (event) => {
      const el = event.target as HTMLElement;
      const isSheet = el.getAttribute('role') === 'dialog';
      if (!isSheet && !el.classList.contains('bg-slate-900/45')) return;
      const animation = el.getAnimations().find((a) => (a as CSSAnimation).animationName === event.animationName);
      if (!animation) return;
      const duration = animation.effect!.getTiming().duration as number;
      const resumeAt = animation.currentTime;
      const at = (time: number) => {
        animation.currentTime = time;
        const style = getComputedStyle(el);
        return { translateY: new DOMMatrix(style.transform).m42, opacity: Number(style.opacity) };
      };
      records.push({
        who: isSheet ? 'sheet' : 'overlay',
        state: el.getAttribute('data-state'),
        duration,
        easing: getComputedStyle(el).animationTimingFunction,
        start: at(0),
        middle: at(duration / 2),
      });
      animation.currentTime = resumeAt;
    }, true);
  });
}

async function recorded(page: Page, who: RecordedAnimation['who'], state: 'open' | 'closed') {
  const find = () =>
    page.evaluate(
      ([w, s]) =>
        ((window as unknown as { __animations: RecordedAnimation[] }).__animations).find((r) => r.who === w && r.state === s) ?? null,
      [who, state],
    );
  await expect.poll(find).not.toBeNull();
  return (await find())!;
}

test.describe('375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('the + is in the Bot input, not on the Messages tab', async ({ page }) => {
    await setup(page);
    await expect(plus(page)).toBeVisible();
    await expect(plus(page)).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(plus(page)).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('tab', { name: 'Messages' }).tap();
    await expect(page.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
    await expect(plus(page)).toHaveCount(0);
  });

  test('+ opens "Quick actions" with 4 rows; Certification is disabled; the + turns solid', async ({ page }) => {
    await setup(page);
    await openSheet(page);
    await expect(sheet(page).getByRole('heading', { name: 'Quick actions' })).toBeVisible();
    const rows = sheet(page).getByRole('listitem');
    await expect(rows).toHaveCount(4);
    await expect(rows).toContainText(['Check verification status', 'My listings', 'Message a business', 'Certification']);
    const cert = sheet(page).getByRole('button', { name: /Certification/ });
    await expect(cert).toBeDisabled();
    await expect(cert).toHaveAttribute('aria-disabled', 'true');
    await expect(cert).toContainText('Coming soon');
    for (const name of [/Check verification status/, /My listings/, /Message a business/]) {
      await expect(sheet(page).getByRole('button', { name })).toBeEnabled();
    }
    for (const row of await rows.all()) expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(64);
    // Behind the open sheet the page is aria-hidden, so find the + by its label attribute
    const plusBehind = page.locator('button[aria-label="Quick actions"]');
    await expect(plusBehind).toHaveAttribute('aria-expanded', 'true');
    await expect(plusBehind).toHaveClass(/bg-primary/);
  });

  test('after the chips are gone, + → "Check verification status" runs the chip flow and closes the sheet', async ({ page }) => {
    await setup(page);
    await sendMessage(page, 'How do I add photos?');
    await expect(page.getByRole('button', { name: 'Check verification status' })).toHaveCount(0);
    await openSheet(page);
    await sheet(page).getByRole('button', { name: /Check verification status/ }).tap();
    await expect(sheet(page)).toHaveCount(0);
    // One business: the check starts straight away
    await expect(page.getByRole('region', { name: 'Verification progress for Harbour Light Coffee' })).toBeVisible();
  });

  test('after a bot reply, the verification card fills in and stays: the reply does not overwrite it', async ({ page }) => {
    await setup(page);
    await sendMessage(page, 'How do I add photos?');
    await expect(page.getByText('Open Your businesses from the menu and tap Update.')).toBeVisible();
    await openSheet(page);
    await sheet(page).getByRole('button', { name: /Check verification status/ }).tap();
    const card = page.getByRole('region', { name: 'Verification progress for Harbour Light Coffee' });
    await expect(card.getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
    await page.waitForTimeout(2_000);
    await expect(card).toBeVisible();
    await expect(page.getByText(/Verification failed/)).toHaveCount(0);
    // The reply is still there too, before the check
    await expect(page.getByText('Open Your businesses from the menu and tap Update.')).toBeVisible();
  });

  test('+ → "Message a business" switches to the Messages tab', async ({ page }) => {
    await setup(page);
    await openSheet(page);
    await sheet(page).getByRole('button', { name: /Message a business/ }).tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the close button, a scrim tap and Escape all close it, and focus returns to the +', async ({ page }) => {
    await setup(page);

    await openSheet(page);
    await sheet(page).getByRole('button', { name: 'Close' }).tap();
    await expect(sheet(page)).toHaveCount(0);
    await expect(plus(page)).toBeFocused();
    await expect(plus(page)).toHaveAttribute('aria-expanded', 'false');

    await openSheet(page);
    await page.touchscreen.tap(187, 120);
    await expect(sheet(page)).toHaveCount(0);
    await expect(plus(page)).toBeFocused();

    await openSheet(page);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toHaveCount(0);
    await expect(plus(page)).toBeFocused();
  });
});

test.describe('the sheet animation at 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('opens over 650ms with the soft curve, closes over 350ms ease-in; the overlay fades with it', async ({ page }) => {
    await setup(page);
    await recordAnimations(page);
    await openSheet(page);
    const opening = await recorded(page, 'sheet', 'open');
    expect(opening.duration).toBe(650);
    expect(opening.easing).toBe('cubic-bezier(0.32, 0.72, 0, 1)');
    expect(opening.start.translateY).toBeGreaterThan(100);
    expect(opening.start.opacity).toBe(1);
    const overlayOpening = await recorded(page, 'overlay', 'open');
    expect(overlayOpening.duration).toBe(650);
    expect(overlayOpening.start.opacity).toBe(0);

    await page.keyboard.press('Escape');
    const closing = await recorded(page, 'sheet', 'closed');
    expect(closing.duration).toBe(350);
    expect(closing.easing).toBe('cubic-bezier(0.4, 0, 1, 1)');
    expect(closing.middle.translateY).toBeGreaterThan(0);
    const overlayClosing = await recorded(page, 'overlay', 'closed');
    expect(overlayClosing.duration).toBe(350);
    expect(overlayClosing.middle.opacity).toBeLessThan(1);
    await expect(sheet(page)).toHaveCount(0);
  });

  test('reduced motion: no slide, a 150ms fade both ways', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page);
    await recordAnimations(page);
    await openSheet(page);
    const opening = await recorded(page, 'sheet', 'open');
    expect(opening.duration).toBe(150);
    expect(opening.start.translateY).toBe(0);
    expect(opening.middle.translateY).toBe(0);
    expect(opening.start.opacity).toBe(0);
    expect((await recorded(page, 'overlay', 'open')).duration).toBe(150);

    await page.keyboard.press('Escape');
    const closing = await recorded(page, 'sheet', 'closed');
    expect(closing.duration).toBe(150);
    expect(closing.middle.translateY).toBe(0);
    expect(closing.middle.opacity).toBeLessThan(1);
    expect((await recorded(page, 'overlay', 'closed')).duration).toBe(150);
    await expect(sheet(page)).toHaveCount(0);
  });
});

for (const width of [320, 375]) {
  test(`at ${width}px the +, the input and the send button don't overlap`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await setup(page);
    await input(page).fill('Hello');
    const p = (await plus(page).boundingBox())!;
    const i = (await input(page).boundingBox())!;
    const s = (await page.getByRole('button', { name: 'Send' }).boundingBox())!;
    expect(Math.round(p.width)).toBe(44);
    expect(Math.round(p.height)).toBe(44);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(i.x + 0.5);
    expect(i.x + i.width).toBeLessThanOrEqual(s.x + 0.5);
    expect(s.x + s.width).toBeLessThanOrEqual(width);
    expect(i.width).toBeGreaterThan(100);
  });
}
