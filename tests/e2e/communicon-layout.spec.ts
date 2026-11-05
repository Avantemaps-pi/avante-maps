/**
 * CommuniCon fills the screen: the input sits at the bottom, the messages take
 * the space between the header and the input, and only the message list
 * scrolls (never the page).
 *
 * Bot replies (chat-ai) and the Messages data (conversations, messages) are
 * mocked. The sandbox mock session (honoured on localhost only) signs in, as
 * in keyboard-open.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';

const SANDBOX_MOCK_KEY = 'avante_sandbox_mock_session';
const STORAGE_KEY = 'avante_maps_auth';
const UID = '00000000-0000-0000-0000-000000000001';

// Mirrors the loginAsSandbox() fallback user in AuthProvider.tsx.
const mockUser = {
  uid: UID,
  pi_uid: 'sandbox-mock-pi-uid',
  username: 'SandboxUser',
  walletAddress: 'sandbox-mock-wallet',
  roles: ['user'],
  accessToken: 'sandbox-mock-token',
  subscriptionTier: 'organization',
  businessCount: 0,
};

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const conversations = Array.from({ length: 14 }, (_, i) => ({
  id: `conv-${i + 1}`,
  business_id: 9300 + i,
  customer_id: UID,
  last_message_at: iso(i * 30),
  last_message_preview: `Thanks, see you on ${['Monday', 'Tuesday', 'Friday'][i % 3]}!`,
  customer_unread: i === 0 ? 2 : 0,
  business_unread: 0,
  created_at: iso(5000),
  businesses: { business_name: `Test Business ${i + 1}`, images: [] },
}));
const thread = Array.from({ length: 24 }, (_, i) => ({
  id: `msg-${i + 1}`,
  conversation_id: 'conv-1',
  sender_id: i % 2 ? 'business-owner-id' : UID,
  sender_role: i % 2 ? 'business' : 'customer',
  body: i % 2 ? `Reply ${i + 1}: yes, we accept Pi for that.` : `Question ${i + 1}: do you accept Pi for orders?`,
  read_at: iso(1),
  created_at: iso(240 - i * 10),
}));

const SIZES = [
  { width: 375, height: 812 },
  { width: 375, height: 667 },
];

// A business owner needs a Supabase session (MessagesPanel loads owned businesses
// with it). A fake, unexpired session in the client's storage key does that
// without a network call; the session-dependent requests are mocked.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SESSION_EXP = Math.floor(Date.now() / 1000) + 3600;
const fakeSession = {
  access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, exp: SESSION_EXP, role: 'authenticated', aud: 'authenticated' })}.sig`,
  refresh_token: 'fake-refresh',
  expires_in: 3600,
  expires_at: SESSION_EXP,
  token_type: 'bearer',
  user: { id: UID, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
};

async function setup(page: Page, opts: { owner?: boolean; businessesDelayMs?: number } = {}) {
  await page.route('**/pi-sdk.js', (route) => route.abort());
  if (opts.owner) {
    await page.route('**/auth/v1/**', (route) => route.fulfill({ json: fakeSession.user }));
    await page.route('**/rest/v1/businesses*', async (route) => {
      if (opts.businessesDelayMs) await new Promise((r) => setTimeout(r, opts.businessesDelayMs));
      await route.fulfill({ json: [{ id: 9001, business_name: 'Harbour Light Coffee' }] });
    });
    await page.route('**/rest/v1/users*', (route) => route.fulfill({ json: [] }));
    await page.route('**/rest/v1/user_roles*', (route) => route.fulfill({ json: [] }));
    await page.addInitScript((session) => {
      localStorage.setItem('supabase.auth.token', JSON.stringify(session));
    }, fakeSession);
  }
  await page.route('**/functions/v1/chat-ai', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `data: ${JSON.stringify({ choices: [{ delta: { content: 'Here is what I found about your listing.' } }] })}\n\ndata: [DONE]\n\n`,
    }),
  );
  await page.route('**/rest/v1/conversations*', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: conversations }) : route.fulfill({ json: [] }),
  );
  await page.route('**/rest/v1/messages*', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: thread }) : route.fulfill({ json: [] }),
  );
  await page.addInitScript(
    ([mockKey, storageKey, user]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(storageKey as string, JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }));
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser],
  );
  // These tests start on Bot: as if it was the tab picked earlier in the session
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('communicon-tab')) sessionStorage.setItem('communicon-tab', 'ai');
  });
  await page.goto('/communicon');
  await expect(page.getByRole('tab', { name: 'Bot' })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

const botInput = (page: Page) => page.getByPlaceholder('Ask about your business...');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });

// The page (document and <main>) never scrolls; only lists inside it do
async function expectPageDoesNotScroll(page: Page) {
  const r = await page.evaluate(() => {
    const se = document.scrollingElement!;
    const main = document.querySelector('main')!;
    window.scrollTo(0, 10_000);
    main.scrollTop = 10_000;
    return {
      docOverflow: se.scrollHeight - se.clientHeight,
      mainOverflow: main.scrollHeight - main.clientHeight,
      docScrollTop: se.scrollTop,
      mainScrollTop: main.scrollTop,
    };
  });
  expect(r).toEqual({ docOverflow: 0, mainOverflow: 0, docScrollTop: 0, mainScrollTop: 0 });
}

// The list is scrolled all the way down, i.e. pinned to its newest message
async function expectPinnedToNewest(page: Page, list: ReturnType<Page['locator']>) {
  await expect
    .poll(() => list.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)))
    .toBeLessThanOrEqual(2);
}

// Simulated on-screen keyboard height. 250px, not 300: at 375x667 a 300px keyboard leaves a
// viewport wider than it's tall, which counts as a rotation and resets keyboard detection
// (useKeyboardOpen). 250px is still well over its 150px threshold.
const KEYBOARD = 250;

// The bottom nav. CommuniCon hides it, so the screen's bottom is the edge to measure to
const nav = (page: Page) => page.locator('nav.fixed');
async function navTop(page: Page) {
  if ((await nav(page).count()) === 0) return page.viewportSize()!.height;
  const hidden = await nav(page).evaluate((el) => el.getAttribute('aria-hidden') === 'true');
  return hidden ? page.viewportSize()!.height : (await nav(page).boundingBox())!.y;
}

// Space between the element and the bottom nav (or the screen's bottom when the nav is hidden)
async function bottomGap(page: Page, selector: ReturnType<Page['locator']>) {
  const box = (await selector.boundingBox())!;
  return (await navTop(page)) - (box.y + box.height);
}

for (const size of SIZES) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test('Bot, welcome only: input at the bottom, page does not scroll', async ({ page }) => {
      await setup(page);
      const gap = await bottomGap(page, botInput(page));
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(32);
      await expectPageDoesNotScroll(page);
    });

    test('Bot, long conversation: only the message list scrolls, newest in view', async ({ page }) => {
      await setup(page);
      for (let i = 1; i <= 8; i++) {
        await botInput(page).fill(`Test message number ${i} about my listing`);
        await botInput(page).press('Enter');
        await expect(page.getByText(`Test message number ${i} about my listing`)).toBeVisible();
      }
      await page.waitForTimeout(800);
      const list = page.locator('main .overflow-y-auto').first();
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      expect(await bottomGap(page, botInput(page))).toBeLessThanOrEqual(32);
      await expectPageDoesNotScroll(page);
      await expect(page.getByText('Test message number 8 about my listing')).toBeInViewport();
    });

    test('Messages inbox: the list reaches the bottom of the screen and scrolls on its own', async ({ page }) => {
      await setup(page);
      await page.getByRole('tab', { name: 'Messages' }).click();
      await expect(page.getByText('Test Business 14')).toBeAttached();
      const list = page.locator('main ul').first().locator('xpath=..');
      expect(await bottomGap(page, list)).toBeLessThanOrEqual(32);
      expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await expectPageDoesNotScroll(page);
    });

    test('open conversation: composer at the bottom, only the thread scrolls', async ({ page }) => {
      await setup(page);
      await page.getByRole('tab', { name: 'Messages' }).click();
      await page.getByText('Test Business 1', { exact: true }).click();
      await expect(composer(page)).toBeVisible();
      await expect(page.getByText('Reply 24: yes, we accept Pi for that.')).toBeAttached();
      const gap = await bottomGap(page, composer(page));
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(32);
      const threadList = page.locator('main .overflow-y-auto').last();
      expect(await threadList.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await expectPageDoesNotScroll(page);
    });

    test('keyboard open (viewport shrinks): input stays just above it, newest message in view', async ({ page }) => {
      // ~250px keyboard
      await setup(page);
      for (let i = 1; i <= 6; i++) {
        await botInput(page).fill(`Keyboard test ${i}`);
        await botInput(page).press('Enter');
        await expect(page.getByText(`Keyboard test ${i}`)).toBeVisible();
      }
      await botInput(page).focus();
      await page.setViewportSize({ width: size.width, height: size.height - KEYBOARD });
      await page.waitForTimeout(500);
      const gap = await bottomGap(page, botInput(page));
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(32);
      await expect(botInput(page)).toBeFocused();
      const list = page.locator('main .overflow-y-auto').first();
      await expectPinnedToNewest(page, list);
      // The newest message (the bot's reply to "Keyboard test 6") is on screen
      await expect(list.getByText('Here is what I found about your listing.').last()).toBeInViewport();
      await expectPageDoesNotScroll(page);
    });

    // The thread stays pinned to the newest message. At 375x667 with a ~250px keyboard
    // the stacked headers leave the thread only ~44px tall (header design is out of
    // scope), so this asserts the pinning rather than the bubble being on screen.
    test('keyboard open in a conversation: composer stays above it, thread pinned to the newest message', async ({ page }) => {
      await setup(page);
      await page.getByRole('tab', { name: 'Messages' }).click();
      await page.getByText('Test Business 1', { exact: true }).click();
      await expect(page.getByText('Reply 24: yes, we accept Pi for that.')).toBeInViewport();
      await page.waitForTimeout(800);
      await composer(page).focus();
      await page.setViewportSize({ width: size.width, height: size.height - KEYBOARD });
      await page.waitForTimeout(500);
      const gap = await bottomGap(page, composer(page));
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(32);
      await expectPinnedToNewest(page, page.locator('main .overflow-y-auto').last());
      await expectPageDoesNotScroll(page);
    });
  });
}

test.describe('no bottom nav at 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const inputBar = (page: Page) => page.locator('[data-chat-input-bar]');

  test('the bottom nav is not rendered and the input bar sits at the bottom of the screen', async ({ page }) => {
    await setup(page);
    await expect(nav(page)).toHaveCount(0);
    const bar = (await inputBar(page).boundingBox())!;
    expect(Math.abs(bar.y + bar.height - 812)).toBeLessThanOrEqual(1);
    await expectPageDoesNotScroll(page);
  });

  test('keyboard open: the input bar sits right above the keyboard', async ({ page }) => {
    await setup(page);
    await botInput(page).focus();
    await page.setViewportSize({ width: 375, height: 812 - KEYBOARD });
    await page.waitForTimeout(400);
    await expect(nav(page)).toHaveCount(0);
    const bar = (await inputBar(page).boundingBox())!;
    expect(Math.abs(bar.y + bar.height - (812 - KEYBOARD))).toBeLessThanOrEqual(1);
    await expect(botInput(page)).toBeFocused();
  });
});

// Message-list height with a conversation open at 375x667 on Dev before this
// change (card header + inbox picker above it), measured with the same page.
const DEV_THREAD_HEIGHT_667 = 344;

test.describe('slim header at 375x667', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });

  test('one CommuniCon heading and a slim mode row', async ({ page }) => {
    await setup(page);
    await expect(page.getByRole('heading', { name: 'CommuniCon' })).toHaveCount(1);
    await expect(page.getByText('Avante Maps communication hub')).toHaveCount(0);
    const row = page.getByRole('tablist', { name: 'CommuniCon mode' }).locator('xpath=..');
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
    for (const tab of await page.getByRole('tab').all()) {
      expect(Math.round((await tab.boundingBox())!.height)).toBe(44);
    }
  });

  test('conversation open: no inbox picker, message list at least 80px taller than on Dev', async ({ page }) => {
    await setup(page, { owner: true });
    await page.getByRole('tab', { name: 'Messages' }).click();
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toBeVisible();
    await page.getByText('Test Business 1', { exact: true }).click();
    await expect(composer(page)).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toHaveCount(0);
    const height = await page.locator('main .overflow-y-auto').last().evaluate((el) => el.clientHeight);
    console.log(`thread height at 375x667: ${height}px (Dev: ${DEV_THREAD_HEIGHT_667}px)`);
    expect(height).toBeGreaterThanOrEqual(DEV_THREAD_HEIGHT_667 + 80);

    // Back arrow returns to the list with the picker
    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toBeVisible();
  });

  test('a user who owns no business: no inbox picker row', async ({ page }) => {
    await setup(page);
    await page.getByRole('tab', { name: 'Messages' }).click();
    await expect(page.getByText('Test Business 14')).toBeAttached();
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toHaveCount(0);
  });

  test('keyboard: Tab reaches the mode tabs, arrows switch them, focus is visible', async ({ page }) => {
    await setup(page);
    const bot = page.getByRole('tab', { name: 'Bot' });
    const messages = page.getByRole('tab', { name: 'Messages' });
    await expect(bot).toHaveAttribute('aria-selected', 'true');
    await expect(messages).toHaveAttribute('tabindex', '-1');

    // Tab from the page header reaches the active tab
    for (let i = 0; i < 12 && !(await bot.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(bot).toBeFocused();
    expect(await bot.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');

    await page.keyboard.press('ArrowRight');
    await expect(messages).toBeFocused();
    await expect(messages).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByPlaceholder('Ask about your business...')).toHaveCount(0);

    await page.keyboard.press('ArrowLeft');
    await expect(bot).toBeFocused();
    await expect(bot).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('the Bot/Messages switch at 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  // What a tab looks like once its colour transition has settled. The expected colours come from
  // the theme's tokens, and contrast from the rendered text and pill colours
  const readTab = (el: Element) => {
    const channels = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r, g, b] = channels(color).map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const token = (name: string) => {
      const probe = document.createElement('div');
      probe.style.color = `hsl(${getComputedStyle(document.documentElement).getPropertyValue(name).trim()})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const style = getComputedStyle(el);
    const [lighter, darker] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return {
      background: style.backgroundColor,
      color: style.color,
      weight: style.fontWeight,
      shadow: style.boxShadow,
      height: el.getBoundingClientRect().height,
      contrast: (lighter! + 0.05) / (darker! + 0.05),
      tokens: { background: token('--background'), accent: token('--accent'), primary: token('--primary') },
    };
  };

  for (const scheme of ['light', 'dark'] as const) {
    test(`${scheme}: the selected tab is a ${scheme === 'light' ? 'page-coloured pill with a shadow' : 'flat accent pill'}, with readable text`, async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem('colorScheme', s), scheme);
      await setup(page);
      if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      const bot = page.getByRole('tab', { name: 'Bot' });
      const messages = page.getByRole('tab', { name: 'Messages' });

      const expectSelected = async (tab: typeof bot, other: typeof bot) => {
        await expect(tab).toHaveAttribute('aria-selected', 'true');
        await expect(other).toHaveAttribute('aria-selected', 'false');
        await expect
          .poll(async () => {
            const t = await tab.evaluate(readTab);
            return t.background === (scheme === 'light' ? t.tokens.background : t.tokens.accent) && t.color === t.tokens.primary;
          })
          .toBe(true);
        const selected = await tab.evaluate(readTab);
        expect(selected.weight).toBe('600');
        expect(Math.round(selected.height)).toBe(44);
        // Tailwind's shadow utilities leave fully transparent layers even with no shadow
        const visibleShadow = selected.shadow.replaceAll('rgba(0, 0, 0, 0)', '').includes('rgb');
        expect(visibleShadow).toBe(scheme === 'light');
        console.log(`${scheme} selected-tab contrast: ${selected.contrast.toFixed(2)}:1`);
        expect(selected.contrast).toBeGreaterThanOrEqual(4.5);

        await expect.poll(async () => (await other.evaluate(readTab)).background).toBe('rgba(0, 0, 0, 0)');
        expect((await other.evaluate(readTab)).weight).toBe('500');
      };

      await expectSelected(bot, messages);
      await messages.tap();
      await expectSelected(messages, bot);

      const track = page.getByRole('tablist', { name: 'CommuniCon mode' });
      expect(await track.evaluate((el) => getComputedStyle(el).paddingTop)).toBe('3px');
    });
  }
});

test.describe('text size at 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('quick replies are at least 44px tall with 14px text', async ({ page }) => {
    await setup(page);
    const chips = page.getByRole('button', { name: /^(Check verification status|Check certification status|My listings)$/ });
    await expect(chips).toHaveCount(3);
    const sizes = await chips.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent, top: Math.round(r.top), height: Math.round(r.height), font: getComputedStyle(el).fontSize };
      }),
    );
    console.log(`quick replies: ${JSON.stringify(sizes)}`);
    for (const s of sizes) {
      expect(s.height).toBeGreaterThanOrEqual(44);
      expect(s.font).toBe('14px');
    }
    // The "Powered by CommuniCon" line above the input is gone
    await expect(page.getByText('Powered by CommuniCon')).toHaveCount(0);
  });
});

test.describe('owner inbox picker', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("an owner's second visit shows the picker on the first frame, with no layout jump", async ({ page }) => {
    // First visit fills the per-user cache (sessionStorage survives the reload below)
    await setup(page, { owner: true });
    await page.getByRole('tab', { name: 'Messages' }).click();
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toBeVisible();

    // Second visit: the businesses query is slow, so only the cache can show the picker now
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await setup(page, { owner: true, businessesDelayMs: 1_500 });
    await page.getByRole('tab', { name: 'Messages' }).click();
    const list = page.locator('main ul').first();
    await expect(list).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toBeVisible({ timeout: 300 });
    const topBefore = (await list.boundingBox())!.y;
    await page.waitForTimeout(2_000);
    expect((await list.boundingBox())!.y).toBe(topBefore);
    await expect(page.getByRole('combobox', { name: 'Inbox' })).toBeVisible();
  });
});

test.describe('back to the Bot tab at 375x812', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  // Enough stored bot history to overflow the list
  const history = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    text: `Seeded message ${i + 1}: opening hours, photos and how verification works.`,
    sender: i % 2 ? 'ai' : 'user',
    timestamp: '10:00 AM',
  }));
  const botList = (page: Page) => page.locator('main .overflow-y-auto').first();
  const lastMessage = (page: Page) => page.getByText('Seeded message 30:', { exact: false });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([key, messages]) => localStorage.setItem(key as string, JSON.stringify(messages)),
      [`avante-chat-messages-v2:${UID}`, history],
    );
  });

  test('a fresh load opens at the newest message', async ({ page }) => {
    await setup(page);
    await expect(lastMessage(page)).toBeVisible();
    expect(await botList(page).evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expectPinnedToNewest(page, botList(page));
    await expect(lastMessage(page)).toBeInViewport();
  });

  test('Messages and back to Bot: still at the newest message', async ({ page }) => {
    await setup(page);
    await expect(lastMessage(page)).toBeInViewport();
    await page.getByRole('tab', { name: 'Messages' }).tap();
    await expect(page.getByText('Test Business 1', { exact: true })).toBeAttached();
    await page.getByRole('tab', { name: 'Bot' }).tap();
    await expect(lastMessage(page)).toBeVisible();
    // Straight away, not after a scroll animation
    await page.waitForTimeout(150);
    const gap = await botList(page).evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
    expect(gap).toBeLessThanOrEqual(2);
    await expect(lastMessage(page)).toBeInViewport();
  });
});
