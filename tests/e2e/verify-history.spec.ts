/**
 * CommuniCon's verification history: Check again updates its card in place, each business has
 * one full card, older results fold into a row that opens read-only, and the saved bot chat
 * keeps its last 50 messages.
 *
 * 375x812 with the sandbox session and a fake Supabase session. verify-business and contact-otp
 * are mocked.
 */
import { test, expect, type Page, type Request } from '@playwright/test';
import { SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser } from './helpers/mapMocks';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const EXP = Math.floor(Date.now() / 1000) + 3600;
const fakeSession = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: mockUser.uid, exp: EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: EXP,
  token_type: 'bearer',
  user: { id: mockUser.uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};

const HARBOUR = { id: 9001, business_name: 'Harbour Light Coffee', verification_status: null, is_verified: false, is_active: true, created_at: '2026-10-01T00:00:00Z' };
const TABLE_BAY = { ...HARBOUR, id: 9002, business_name: 'Table Bay Bookshop' };
const STORAGE_MESSAGES = `avante-chat-messages-v2:${mockUser.uid}`;

const reply = (totalTransactions: number, creditedTransactions: number, uniqueWallets: number, extra: object = {}) => ({
  verified: false,
  contactConfirmed: false,
  reason: 'Contact email not confirmed',
  totalTransactions,
  creditedTransactions,
  uniqueWallets,
  ...extra,
});

async function setup(page: Page, opts: { businesses?: object[]; replies?: object[]; failFrom?: number; history?: object[]; verifyDelayMs?: number; businessLoadFailures?: number } = {}) {
  const verifyCalls: Request[] = [];
  let businessLoadFailures = opts.businessLoadFailures ?? 0;
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route('**/auth/v1/**', (route) => route.fulfill({ json: fakeSession.user }));
  for (const t of ['users', 'user_roles', 'conversations', 'messages', 'notifications']) {
    await page.route(`**/rest/v1/${t}*`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/rest/v1/businesses*', (route) => {
    const req = route.request();
    if ((req.headers()['accept'] ?? '').includes('vnd.pgrst.object')) {
      return route.fulfill({ json: { contact_info: { email: 'hello@harbour.example' }, contact_email_verified_for: null } });
    }
    if (businessLoadFailures > 0) {
      businessLoadFailures -= 1;
      return route.fulfill({ status: 500, json: { message: 'boom' } });
    }
    return route.fulfill({ json: opts.businesses ?? [HARBOUR] });
  });
  await page.route('**/functions/v1/chat-ai', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n` }),
  );
  await page.route('**/functions/v1/contact-otp', (route) => route.fulfill({ json: { success: true } }));
  await page.route('**/functions/v1/verify-business', async (route) => {
    verifyCalls.push(route.request());
    const call = verifyCalls.length - 1;
    if (opts.verifyDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.verifyDelayMs));
    if (opts.failFrom !== undefined && call >= opts.failFrom) return route.fulfill({ status: 500, json: { error: 'The check failed' } });
    const { business_id: id } = route.request().postDataJSON() as { business_id: number };
    const result = opts.replies?.[call] ?? reply(13, 4, 9);
    return route.fulfill({ json: { success: true, results: [{ id, name: 'x', ...result }] } });
  });
  await page.addInitScript(
    ([mockKey, storageKey, user, session, messagesKey, history]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(storageKey as string, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }));
      localStorage.setItem('supabase.auth.token', JSON.stringify(session));
      // Only seeded once, so a reload keeps what the app saved
      if (history && !sessionStorage.getItem('seeded')) {
        localStorage.setItem(messagesKey as string, JSON.stringify(history));
        sessionStorage.setItem('seeded', '1');
      }
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser, fakeSession, STORAGE_MESSAGES, opts.history ?? null],
  );
  await page.goto('/communicon');
  await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
  return { verifyCalls };
}

const cardFor = (page: Page, name = HARBOUR.business_name) => page.getByRole('region', { name: `Verification progress for ${name}` });
const foldedRows = (page: Page) => page.getByRole('button', { name: /Earlier check/ });
const checkAgainButtons = (page: Page) => page.getByRole('button', { name: 'Check again' });
const savedMessages = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]') as Array<Record<string, unknown>>, STORAGE_MESSAGES);

// A fresh "Check verification status" run, from the + sheet (the starter chips go after the first)
async function runCheck(page: Page, calls: Request[], name = HARBOUR.business_name, choose = false) {
  const before = calls.length;
  await page.getByRole('button', { name: 'Quick actions' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Quick actions' });
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await sheet.getByRole('button', { name: /Check verification status/ }).tap();
  await expect(sheet).toHaveCount(0);
  // With one business the check starts straight away
  if (choose) await page.getByRole('button', { name: new RegExp(name) }).last().tap();
  await expect.poll(() => calls.length).toBe(before + 1);
  await expect(cardFor(page, name)).toBeVisible();
  // The card reveals its rows one by one
  await page.waitForTimeout(1_800);
}

test('two runs for the same business: one full card, one folded row above it, one Check again', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9), reply(40, 20, 9)] });
  await runCheck(page, verifyCalls);
  await runCheck(page, verifyCalls);

  await expect(cardFor(page)).toHaveCount(1);
  await expect(cardFor(page).getByText('40 of 100')).toBeVisible();
  await expect(checkAgainButtons(page)).toHaveCount(1);
  await expect(foldedRows(page)).toHaveCount(1);
  await expect(foldedRows(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(foldedRows(page)).toContainText(`${HARBOUR.business_name} · 0 of 3 done`);
  await expect(foldedRows(page)).toContainText('Earlier check · today, ');
  const row = (await foldedRows(page).boundingBox())!;
  const card = (await cardFor(page).boundingBox())!;
  expect(row.y + row.height).toBeLessThanOrEqual(card.y);
  expect(Math.round(row.height)).toBeGreaterThanOrEqual(56);
});

test('Check again: same messages, no Processing bubble, new numbers and "Last checked"', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9), reply(40, 20, 12)] });
  await runCheck(page, verifyCalls);
  await expect(cardFor(page).getByText('Last checked today, ')).toBeVisible();
  const before = await savedMessages(page);
  const processing = page.getByText(/Processing verification request/);

  await cardFor(page).getByRole('button', { name: 'Check again' }).tap();
  await expect(cardFor(page).getByText('40 of 100')).toBeVisible();

  expect(verifyCalls).toHaveLength(2);
  await expect(cardFor(page).getByText('Received: 20 of 50')).toBeVisible();
  await expect(cardFor(page).getByText('12 of 10')).toBeVisible();
  await expect(cardFor(page)).toHaveCount(1);
  await expect(foldedRows(page)).toHaveCount(0);
  await expect(processing).toHaveCount(0);
  await expect.poll(async () => (await savedMessages(page)).length).toBe(before.length);
  const metrics = (await savedMessages(page)).find((m) => m['verificationMetrics'])!['verificationMetrics'] as { checkedAt: string };
  expect(Number.isNaN(Date.parse(metrics.checkedAt))).toBe(false);
});

test('a card updating in place shows its rows at once, without the reveal', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9), reply(40, 20, 12)] });
  await runCheck(page, verifyCalls);
  await cardFor(page).getByRole('button', { name: 'Check again' }).tap();
  await expect(cardFor(page).getByText('40 of 100')).toBeVisible();
  await expect(cardFor(page).locator('.animate-spin')).toHaveCount(0);
});

test('Check again failing: the card stays as it was, a toast, no bubble', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9)], failFrom: 1 });
  await runCheck(page, verifyCalls);
  const before = (await savedMessages(page)).length;
  await cardFor(page).getByRole('button', { name: 'Check again' }).tap();
  await expect(page.getByText("Couldn't check again").first()).toBeVisible();
  await expect(page.getByText('The check failed').first()).toBeVisible();
  await expect(cardFor(page).getByText('13 of 100')).toBeVisible();
  await expect(page.getByText(/Verification failed for/)).toHaveCount(0);
  expect((await savedMessages(page)).length).toBe(before);
  await expect(cardFor(page).getByRole('button', { name: 'Check again' })).toBeEnabled();
});

// The chat after the welcome message, read from what's on screen, oldest first
const chatLines = (page: Page) =>
  page.locator('main .overflow-y-auto').first().evaluate((list) =>
    [...list.children]
      .map((el) => {
        const heading = el.querySelector('section h4')?.textContent;
        if (heading) return `card: ${heading}`;
        return (el.querySelector('p, .prose')?.textContent ?? el.textContent ?? '').trim();
      })
      .filter((line) => line && !line.startsWith('Hi! I can help')),
  );

test('one business: no question, no Selected or Processing bubble; user message, then pending card, then result', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9)], verifyDelayMs: 800 });
  await page.getByRole('button', { name: 'Check verification status' }).tap();

  // Pending: same card, spinners, no Check again
  const card = cardFor(page);
  await expect(card.getByRole('heading', { name: `Checking ${HARBOUR.business_name}…` })).toBeVisible();
  await expect(card.locator('.animate-spin')).toHaveCount(3);
  await expect(checkAgainButtons(page)).toHaveCount(0);
  await expect(card).toHaveAttribute('aria-busy', 'true');

  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(card.getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
  // The reveal runs once, when the result fills in
  await expect(card.locator('.animate-spin')).not.toHaveCount(0);
  await expect(card.getByText('Last checked today, ')).toBeVisible();
  await expect(card.getByText('9 of 10')).toBeVisible();
  await expect(card.locator('.animate-spin')).toHaveCount(0);
  await expect(checkAgainButtons(page)).toHaveCount(1);

  expect(await chatLines(page)).toEqual(['Check verification status', 'card: Not verified yet']);
  for (const gone of [/Which business/, /Selected business/, /Processing verification/, /\/verification/, /Select your business/]) {
    await expect(page.getByText(gone)).toHaveCount(0);
  }
});

test('two businesses: one question with both buttons; after the result it is gone', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [HARBOUR, TABLE_BAY], verifyDelayMs: 500 });
  await page.getByRole('button', { name: 'Check verification status' }).tap();

  const question = page.getByText('Which business should I check?');
  await expect(question).toBeVisible();
  expect(await chatLines(page)).toEqual(['Check verification status', 'Which business should I check?']);
  const harbour = page.getByRole('button', { name: HARBOUR.business_name });
  const tableBay = page.getByRole('button', { name: TABLE_BAY.business_name });
  await expect(harbour).toBeEnabled();
  await expect(tableBay).toBeEnabled();
  expect(Math.round((await harbour.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
  // The buttons are inside the question's bubble, which has no separate one
  const bubble = (await question.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').boundingBox())!;
  const button = (await harbour.boundingBox())!;
  expect(button.y).toBeGreaterThanOrEqual(bubble.y);
  expect(button.y + button.height).toBeLessThanOrEqual(bubble.y + bubble.height);
  expect(verifyCalls).toHaveLength(0);

  await tableBay.tap();
  await expect(cardFor(page, TABLE_BAY.business_name).getByRole('heading', { name: `Checking ${TABLE_BAY.business_name}…` })).toBeVisible();
  await expect(cardFor(page, TABLE_BAY.business_name).getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
  await expect(question).toHaveCount(0);
  expect(await chatLines(page)).toEqual(['Check verification status', 'card: Not verified yet']);
  await expect(page.getByText(/Selected business/)).toHaveCount(0);
  expect((verifyCalls[0]!.postDataJSON() as { business_id: number }).business_id).toBe(TABLE_BAY.id);
});

test('a typed /verification shows the friendly user message, and still works', async ({ page }) => {
  const { verifyCalls } = await setup(page);
  const input = page.getByPlaceholder('Ask about your business...');
  await expect(async () => {
    await input.fill('/verification');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await input.press('Enter');
  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(cardFor(page).getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
  expect(await chatLines(page)).toEqual(['Check verification status', 'card: Not verified yet']);
  await expect(page.getByText('/verification', { exact: true })).toHaveCount(0);
});

test('verify-business failing: the pending card becomes the error message, and the question goes', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [HARBOUR, TABLE_BAY], failFrom: 0 });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await page.getByRole('button', { name: HARBOUR.business_name }).tap();
  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(page.getByText(/Verification failed for "Harbour Light Coffee"\. The check failed/)).toBeVisible();
  await expect(cardFor(page)).toHaveCount(0);
  await expect(page.getByText('Which business should I check?')).toHaveCount(0);
  const lines = await chatLines(page);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe('Check verification status');
});

test('an already verified business: no card, today\'s message, no question left', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [{ ...HARBOUR, is_verified: true }, TABLE_BAY] });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await page.getByRole('button', { name: HARBOUR.business_name }).tap();
  await expect(page.getByText('"Harbour Light Coffee" is already verified! ✓')).toBeVisible();
  await expect(page.getByText('Which business should I check?')).toHaveCount(0);
  expect(verifyCalls).toHaveLength(0);
});

test('an old saved picker: its buttons are disabled and do nothing', async ({ page }) => {
  const { verifyCalls } = await setup(page, {
    history: [{ id: 1, text: 'Select your business:', sender: 'business-selection', timestamp: '10:00 AM', businesses: [HARBOUR, TABLE_BAY] }],
  });
  const old = page.getByRole('button', { name: HARBOUR.business_name });
  await expect(old).toBeDisabled();
  await expect(old).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('button', { name: TABLE_BAY.business_name })).toBeDisabled();
  await old.tap({ force: true });
  await page.waitForTimeout(300);
  expect(verifyCalls).toHaveLength(0);
});

test('a question left unanswered: starting again replaces it, with one tappable picker', async ({ page }) => {
  await setup(page, { businesses: [HARBOUR, TABLE_BAY] });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await expect(page.getByText('Which business should I check?')).toHaveCount(1);
  await page.getByRole('button', { name: 'Quick actions' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Quick actions' });
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await sheet.getByRole('button', { name: /Check verification status/ }).tap();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('Which business should I check?')).toHaveCount(1);
  await expect(page.getByRole('button', { name: HARBOUR.business_name })).toBeEnabled();
});

test('My listings keeps its picker, and a choice runs the same check', async ({ page }) => {
  const { verifyCalls } = await setup(page);
  await page.getByRole('button', { name: 'My listings' }).tap();
  await page.getByRole('button', { name: HARBOUR.business_name }).tap();
  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(cardFor(page).getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
  await expect(page.getByText('Select one to request or recheck verification:')).toHaveCount(0);
});

const LOAD_ERROR = "Couldn't load your businesses. Try again.";
const INACTIVE = { ...HARBOUR, id: 9003, business_name: 'Dock Road Deli', is_active: false };

for (const [flow, start] of [['the verification check', 'Check verification status'], ['My listings', 'My listings']] as const) {
  test(`a failed load in ${flow}: the error with a retry, and no redirect to Registration`, async ({ page }) => {
    await setup(page, { businessLoadFailures: 1 });
    await page.getByRole('button', { name: start }).tap();
    await expect(page.getByText(LOAD_ERROR)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByText(/don't have any registered businesses/)).toHaveCount(0);
    // Longer than the 1.5 to 2s redirect of the no-businesses case
    await page.waitForTimeout(2_600);
    await expect(page).toHaveURL(/\/communicon$/);
  });
}

test('Try again in the verification check: the error goes and the check runs, with one user message', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businessLoadFailures: 1 });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await page.getByRole('button', { name: 'Try again' }).tap();
  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(cardFor(page).getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
  await expect(page.getByText(LOAD_ERROR)).toHaveCount(0);
  expect(await chatLines(page)).toEqual(['Check verification status', 'card: Not verified yet']);
});

test('Try again in My listings: the error goes and the listings show', async ({ page }) => {
  await setup(page, { businessLoadFailures: 1 });
  await page.getByRole('button', { name: 'My listings' }).tap();
  await page.getByRole('button', { name: 'Try again' }).tap();
  await expect(page.getByText('Here are your listings:')).toBeVisible();
  await expect(page.getByText(LOAD_ERROR)).toHaveCount(0);
});

test('Try again failing again: one error, still with a retry, and it can still recover', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businessLoadFailures: 2 });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await page.getByRole('button', { name: 'Try again' }).tap();
  await expect(page.getByText(LOAD_ERROR)).toHaveCount(1);
  await page.getByRole('button', { name: 'Try again' }).tap();
  await expect.poll(() => verifyCalls.length).toBe(1);
  await expect(page.getByText(LOAD_ERROR)).toHaveCount(0);
});

for (const [flow, start] of [['the verification check', 'Check verification status'], ['My listings', 'My listings']] as const) {
  test(`genuinely no businesses in ${flow}: today's message, then Registration`, async ({ page }) => {
    await setup(page, { businesses: [] });
    await page.getByRole('button', { name: start }).tap();
    await expect(page.getByText(/You don't have any registered businesses yet/)).toBeVisible();
    await expect(page.getByText(LOAD_ERROR)).toHaveCount(0);
    await page.waitForURL('**/registration');
  });
}

test('one active business and a deactivated one: no question, the check starts for the active one', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [INACTIVE, HARBOUR] });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await expect.poll(() => verifyCalls.length).toBe(1);
  expect((verifyCalls[0]!.postDataJSON() as { business_id: number }).business_id).toBe(HARBOUR.id);
  await expect(page.getByText('Which business should I check?')).toHaveCount(0);
  await expect(cardFor(page, HARBOUR.business_name)).toBeVisible();
});

test('two active businesses and a deactivated one: the question offers only the active two', async ({ page }) => {
  await setup(page, { businesses: [HARBOUR, INACTIVE, TABLE_BAY] });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await expect(page.getByText('Which business should I check?')).toBeVisible();
  await expect(page.getByRole('button', { name: HARBOUR.business_name })).toBeVisible();
  await expect(page.getByRole('button', { name: TABLE_BAY.business_name })).toBeVisible();
  await expect(page.getByRole('button', { name: INACTIVE.business_name })).toHaveCount(0);
});

test('every business deactivated: says so, no check, and no redirect to Registration', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [INACTIVE] });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await expect(page.getByText(/None of your businesses are active right now/)).toBeVisible();
  await expect(page.getByText(/don't have any registered businesses/)).toHaveCount(0);
  await page.waitForTimeout(2_600);
  await expect(page).toHaveURL(/\/communicon$/);
  expect(verifyCalls).toHaveLength(0);
});

test('My listings shows a deactivated business with an "Inactive" label, and offers only active ones to check', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [HARBOUR, INACTIVE] });
  await page.getByRole('button', { name: 'My listings' }).tap();
  const rows = page.getByRole('listitem').filter({ hasText: /—/ });
  await expect(rows).toHaveCount(2);
  const deactivated = rows.filter({ hasText: INACTIVE.business_name });
  const active = rows.filter({ hasText: HARBOUR.business_name });
  const label = deactivated.getByText('Inactive', { exact: true });
  await expect(label).toBeVisible();
  await expect(label).toHaveCSS('font-size', '12px');
  await expect(label).toHaveClass(/text-muted-foreground/);
  await expect(active.getByText('Inactive', { exact: true })).toHaveCount(0);

  await expect(page.getByRole('button', { name: INACTIVE.business_name })).toHaveCount(0);
  await page.getByRole('button', { name: HARBOUR.business_name }).tap();
  await expect.poll(() => verifyCalls.length).toBe(1);
  expect((verifyCalls[0]!.postDataJSON() as { business_id: number }).business_id).toBe(HARBOUR.id);
});

test('My listings with every business deactivated: shows them, with nothing to pick', async ({ page }) => {
  await setup(page, { businesses: [INACTIVE] });
  await page.getByRole('button', { name: 'My listings' }).tap();
  await expect(page.getByText('Here are your listings:')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: INACTIVE.business_name }).getByText('Inactive', { exact: true })).toBeVisible();
  await expect(page.getByText('Select one to request or recheck verification:')).toHaveCount(0);
});

test('a reload during a check leaves no card stuck on its spinners, and the reveal doesn\'t replay', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9)], verifyDelayMs: 4_000 });
  await page.getByRole('button', { name: 'Check verification status' }).tap();
  await expect(cardFor(page).getByRole('heading', { name: /Checking/ })).toBeVisible();
  await expect.poll(async () => (await savedMessages(page)).some((m) => m['text'] === 'Check verification status')).toBe(true);
  expect((await savedMessages(page)).some((m) => m['verificationMetrics'])).toBe(false);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
  await expect(page.getByText('Check verification status', { exact: true }).last()).toBeVisible();
  await expect(cardFor(page)).toHaveCount(0);

  await runCheck(page, verifyCalls);
  await expect(cardFor(page).getByRole('heading', { name: 'Not verified yet' })).toBeVisible();
  await page.reload();
  await expect(cardFor(page).getByText('13 of 100')).toBeVisible();
  await expect(cardFor(page).locator('.animate-spin')).toHaveCount(0);
});

test('a folded row opens read-only with its old numbers, and folds again', async ({ page }) => {
  const { verifyCalls } = await setup(page, { replies: [reply(13, 4, 9), reply(40, 20, 12)] });
  await runCheck(page, verifyCalls);
  await runCheck(page, verifyCalls);

  const note = page.getByText("Earlier result. Check the latest card below for today's numbers.");
  await expect(note).toHaveCount(0);
  await foldedRows(page).tap();
  await expect(foldedRows(page)).toHaveAttribute('aria-expanded', 'true');
  const panel = foldedRows(page).locator('xpath=following-sibling::div');
  await expect(note).toBeVisible();
  await expect(note).toBeInViewport();
  await expect(panel.getByText('13 of 100')).toBeVisible();
  await expect(panel.getByText('Received: 4 of 50')).toBeVisible();
  await expect(panel.getByText('9 of 10')).toBeVisible();
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.getByRole('link')).toHaveCount(0);
  // Grey bars, not primary
  await expect(panel.getByRole('progressbar', { name: 'Transactions' }).locator('div')).toHaveClass(/bg-muted-foreground/);
  // Still one Check again and one Confirm, on the latest card
  await expect(checkAgainButtons(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(1);

  await foldedRows(page).tap();
  await expect(foldedRows(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(note).toHaveCount(0);
});

test('folded rows start folded after a reload', async ({ page }) => {
  const { verifyCalls } = await setup(page);
  await runCheck(page, verifyCalls);
  await runCheck(page, verifyCalls);
  await foldedRows(page).tap();
  await expect(foldedRows(page)).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await expect(foldedRows(page)).toHaveAttribute('aria-expanded', 'false');
});

test('two businesses each keep their own full card', async ({ page }) => {
  const { verifyCalls } = await setup(page, { businesses: [HARBOUR, TABLE_BAY] });
  await runCheck(page, verifyCalls, HARBOUR.business_name, true);
  await runCheck(page, verifyCalls, TABLE_BAY.business_name, true);
  await expect(cardFor(page, HARBOUR.business_name)).toHaveCount(1);
  await expect(cardFor(page, TABLE_BAY.business_name)).toHaveCount(1);
  await expect(foldedRows(page)).toHaveCount(0);
  await expect(checkAgainButtons(page)).toHaveCount(2);
});

test('Check again on a card higher up updates that one, without scrolling to the bottom', async ({ page }) => {
  const { verifyCalls } = await setup(page, {
    businesses: [HARBOUR, TABLE_BAY],
    replies: [reply(13, 4, 9), reply(20, 5, 3), reply(55, 30, 9)],
  });
  await runCheck(page, verifyCalls, HARBOUR.business_name, true);
  await runCheck(page, verifyCalls, TABLE_BAY.business_name, true);
  const button = cardFor(page, HARBOUR.business_name).getByRole('button', { name: 'Check again' });
  await button.scrollIntoViewIfNeeded();
  const list = page.locator('main .overflow-y-auto').first();
  await page.waitForTimeout(300);
  const before = await list.evaluate((el) => el.scrollTop);
  await button.tap();
  await expect(cardFor(page, HARBOUR.business_name).getByText('55 of 100')).toBeVisible();
  await expect(cardFor(page, TABLE_BAY.business_name).getByText('20 of 100')).toBeVisible();
  await page.waitForTimeout(600);
  expect(Math.abs((await list.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(40);
});

const oldCard = (id: number, extra: object = {}) => ({
  id,
  text: '',
  sender: 'support',
  timestamp: '01:37 AM',
  verificationMetrics: { contactInfoConfirmed: true, totalTransactions: 13, creditedTransactions: 4, uniqueWallets: 9, verified: false, businessName: HARBOUR.business_name, ...extra },
});

test('old saved cards: no "Last checked" line, and the folded row uses the message time', async ({ page }) => {
  await setup(page, {
    history: [
      { ...oldCard(1, { businessId: HARBOUR.id }), contactVerification: { email: 'hello@harbour.example', businessId: HARBOUR.id } },
      { ...oldCard(2, { businessId: HARBOUR.id, totalTransactions: 20 }), contactVerification: { email: 'hello@harbour.example', businessId: HARBOUR.id } },
    ],
  });
  await expect(foldedRows(page)).toContainText('Earlier check · 01:37 AM');
  await expect(foldedRows(page)).toContainText(`${HARBOUR.business_name} · 1 of 3 done`);
  await expect(cardFor(page)).toHaveCount(1);
  await expect(cardFor(page).getByText('20 of 100')).toBeVisible();
  await expect(cardFor(page).getByText(/Last checked/)).toHaveCount(0);
});

test('very old saved cards with no business id stay full cards', async ({ page }) => {
  await setup(page, { history: [oldCard(1), oldCard(2)] });
  await expect(cardFor(page)).toHaveCount(2);
  await expect(foldedRows(page)).toHaveCount(0);
});

test('a saved chat of 70 messages keeps 50, after loading and after a new message', async ({ page }) => {
  const history = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, text: `Saved message ${i + 1}`, sender: i % 2 ? 'ai' : 'user', timestamp: '10:00 AM' }));
  await setup(page, { history });
  await expect.poll(async () => (await savedMessages(page)).length).toBe(50);
  await expect(page.getByText('Saved message 70', { exact: true })).toBeAttached();
  await expect(page.getByText('Saved message 20', { exact: true })).toHaveCount(0);

  const input = page.getByPlaceholder('Ask about your business...');
  await expect(async () => {
    await input.fill('One more');
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await input.press('Enter');
  await expect(page.getByText('One more', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const saved = await savedMessages(page);
    return saved.some((m) => m['text'] === 'One more') ? saved.length : -1;
  }).toBe(50);
});

test('confirming the email on the latest card auto-checks in place, and it turns Verified', async ({ page }) => {
  const { verifyCalls } = await setup(page, {
    replies: [
      reply(120, 80, 14),
      reply(120, 80, 14),
      reply(120, 80, 14, { verified: true, contactConfirmed: true, reason: null }),
    ],
  });
  await runCheck(page, verifyCalls);
  await runCheck(page, verifyCalls);
  const before = (await savedMessages(page)).length;

  await cardFor(page).getByRole('button', { name: 'Confirm', exact: true }).tap();
  await page.getByRole('button', { name: 'Send Verification Code' }).tap();
  await page.getByRole('dialog').locator('input').first().focus();
  await page.keyboard.type('123456');

  await expect.poll(() => verifyCalls.length).toBe(3);
  await expect(cardFor(page).getByRole('heading', { name: 'Verified' })).toBeVisible();
  await expect(cardFor(page)).toHaveCount(1);
  await expect(checkAgainButtons(page)).toHaveCount(0);
  await expect.poll(async () => (await savedMessages(page)).length).toBe(before);
  // The older result keeps what it showed then
  await expect(foldedRows(page)).toContainText('2 of 3 done');
});
