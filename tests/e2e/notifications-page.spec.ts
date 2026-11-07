/**
 * The Notifications page: one row style for every kind (icon tint, bold name, time, "Also
 * emailed", the action link), unread rows tinted with a dot, All · Account · Activity tabs,
 * Today / Earlier groups, Mark all as read for the current tab, empty states, and tapping a row
 * opening its link and marking it read. Older rows without metadata.kind map from their type.
 *
 * 375x812 with the sandbox session, a fake Supabase session and mocked Supabase.
 */
import { test, expect, type Page, type Locator } from './helpers/fixtures';
import { mockMap, NEARBY_BUSINESSES, mockUser } from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

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
const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60 * 1000).toISOString();
const daysAgo = (d: number) =>
  new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
// Earlier today, but never yesterday: at least a minute after local midnight
const todayAt = (minutes: number) => {
  const sinceMidnight = Date.now() - new Date().setHours(0, 0, 0, 0);
  return minutesAgo(
    Math.min(minutes, Math.max(1, Math.floor(sinceMidnight / 60000) - 1)),
  );
};

interface Row {
  id: string;
  type: string;
  content: string;
  read: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  priority: string;
  click_url: string | null;
}

interface Fixture {
  kind: string;
  tint: 'primary' | 'muted' | 'destructive';
  tab: 'account' | 'activity';
  name: string;
  content: string;
  action: string;
  url: string;
  emailed?: boolean;
}

// One row per kind, as the server PRs will write them
const KINDS: Fixture[] = [
  {
    kind: 'new_message',
    tint: 'primary',
    tab: 'activity',
    name: '@lindiwe_k',
    content:
      '@lindiwe_k messaged Harbour Light Coffee: "Are you open on Sunday afternoon?"',
    action: 'Reply',
    url: '/communicon?conversation=11111111-1111-4111-8111-111111111111',
    emailed: true,
  },
  {
    kind: 'payout_wallet_changed',
    tint: 'primary',
    tab: 'account',
    name: 'Harbour Light Coffee',
    content:
      "Payout wallet changed for Harbour Light Coffee to GD7Q…K2LM. Wasn't you? Check your business now.",
    action: 'Check payout wallet',
    url: '/update-registration/56?field=pi_wallet_address',
    emailed: true,
  },
  {
    kind: 'contact_email_changed',
    tint: 'muted',
    tab: 'account',
    name: 'Harbour Trades',
    content:
      'Contact email changed for Harbour Trades. Verification is paused until you confirm the new email.',
    action: 'Confirm email',
    url: '/communicon',
  },
  {
    kind: 'plan_ending',
    tint: 'primary',
    tab: 'account',
    name: 'Small Business',
    content: 'Your Small Business plan ends in 3 days, on 10 Nov.',
    action: 'Renew plan',
    url: '/wallet',
  },
  {
    kind: 'plan_ended',
    tint: 'primary',
    tab: 'account',
    name: 'Small Business',
    content: 'Your Small Business plan has ended.',
    action: 'Choose a plan',
    url: '/pricing',
  },
  {
    kind: 'listing_deactivated',
    tint: 'muted',
    tab: 'account',
    name: 'Neo Finance',
    content:
      'Neo Finance is no longer listed. Your plan ended, so only one business stays listed.',
    action: 'Choose which stays',
    url: '/registered-business',
  },
  {
    kind: 'verified',
    tint: 'primary',
    tab: 'account',
    name: 'Harbour Light Coffee',
    content:
      'Harbour Light Coffee is now verified. The verified badge shows on your listing.',
    action: 'View verification',
    url: '/registered-business',
  },
  {
    kind: 'certified',
    tint: 'primary',
    tab: 'account',
    name: 'Harbour Light Coffee',
    content: 'Harbour Light Coffee is now certified.',
    action: 'View certification',
    url: '/registered-business',
  },
  {
    kind: 'new_review',
    tint: 'primary',
    tab: 'activity',
    name: 'Thabo M.',
    content:
      'Thabo M. reviewed Harbour Light Coffee: ★★★★★ "Easy to find and quick to reply."',
    action: 'See review',
    url: '/review/56?tab=reviews',
  },
  {
    kind: 'topup_received',
    tint: 'primary',
    tab: 'account',
    name: 'Avante Maps',
    content: '40.00 π added to your Avante Maps balance.',
    action: 'Open wallet',
    url: '/wallet',
  },
  {
    kind: 'plan_paid',
    tint: 'primary',
    tab: 'account',
    name: 'Organization',
    content: 'Your Organization plan is paid and active.',
    action: 'View plan',
    url: '/wallet',
  },
  {
    kind: 'plan_not_activated',
    tint: 'destructive',
    tab: 'account',
    name: 'Small Business',
    content:
      "65.20 π received for Small Business, but the plan wasn't activated. We're on it, or contact support.",
    action: 'Contact support',
    url: '/contact',
  },
  {
    kind: 'business_registered',
    tint: 'muted',
    tab: 'account',
    name: 'Phephe',
    content: 'Phephe is registered and listed on Avante Maps.',
    action: 'View business',
    url: '/registered-business',
  },
];

const kindRow = (f: Fixture, i: number, read = false): Row => ({
  id: `n-${f.kind}`,
  type: 'system',
  content: f.content,
  read,
  metadata: {
    kind: f.kind,
    businessId: 56,
    ...(f.kind === 'new_message' || f.kind === 'new_review'
      ? { userName: f.name }
      : { businessName: f.name }),
    actionLabel: f.action,
    ...(f.emailed ? { emailed: true } : {}),
  },
  // Spread from 2 minutes ago back over two weeks: the first five today, the rest earlier
  created_at: i < 5 ? todayAt(2 + i * 10) : daysAgo(i - 3),
  priority: 'medium',
  click_url: f.url,
});

// A row from before kinds: only a type
const OLD_BUSINESS: Row = {
  id: 'n-old-business',
  type: 'business',
  content:
    'Your business "Phephe" has been successfully registered and is now listed on Avante Maps!',
  read: true,
  metadata: { businessName: 'Phephe' },
  created_at: daysAgo(5),
  priority: 'medium',
  click_url: null,
};

async function setup(
  page: Page,
  rows: Row[],
  options: { scheme?: string } = {},
) {
  const patches: { query: string; body: Record<string, unknown> }[] = [];
  const tracked: Record<string, unknown>[] = [];
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: session.user }),
  );
  await mockMap(
    page,
    NEARBY_BUSINESSES,
    options.scheme ? { storage: { colorScheme: options.scheme } } : {},
  );
  // Answered like PostgREST: PATCH applies to the rows its id filter names
  await page.route('**/rest/v1/notifications*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'HEAD') {
      return route.fulfill({
        status: 200,
        headers: { 'content-range': `*/${rows.filter((r) => !r.read).length}` },
      });
    }
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() as Record<string, unknown>;
      patches.push({ query: url.search, body });
      const filter = url.searchParams.get('id') ?? '';
      const ids = filter.startsWith('eq.')
        ? [filter.slice(3)]
        : filter
            .replace(/^in\.\(|\)$/g, '')
            .split(',')
            .map((id) => id.replace(/"/g, ''));
      for (const r of rows) if (ids.includes(r.id)) Object.assign(r, body);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({
      json: [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)),
    });
  });
  await page.route('**/functions/v1/track-notification', (route) => {
    tracked.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { success: true } });
  });
  await page.addInitScript(
    (s) => localStorage.setItem('supabase.auth.token', JSON.stringify(s)),
    session,
  );
  return { patches, tracked, rows };
}

const row = (page: Page, kind: string) =>
  page.locator(`[data-notification-row="${kind}"]`);
const tab = (page: Page, name: string) =>
  page.getByRole('tab', { name, exact: true });
const allKindRows = () => KINDS.map((f, i) => kindRow(f, i));

// The list loads after hydration (the server's page already shows All and the empty state), so
// wait for it before tapping anything
async function open(page: Page) {
  const loaded = page.waitForResponse(
    (r) =>
      r.url().includes('/rest/v1/notifications') &&
      r.request().method() === 'GET',
  );
  await page.goto('/notifications');
  await loaded;
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
}

const computed = (locator: Locator, prop: 'backgroundColor' | 'color') =>
  locator.evaluate((el, p) => getComputedStyle(el)[p as 'color'], prop);

test('every kind renders its icon tint, the bold name, the action label and link', async ({
  page,
}) => {
  await setup(page, allKindRows());
  await open(page);
  for (const f of KINDS) {
    const r = row(page, f.kind);
    await expect(r, f.kind).toHaveCount(1);
    await expect(r.locator('[data-tint]'), f.kind).toHaveAttribute(
      'data-tint',
      f.tint,
    );
    await expect(r.locator('strong'), f.kind).toHaveText(f.name);
    await expect(r, f.kind).toContainText(f.content.slice(-15));
    const link = r.getByRole('link', { name: f.action, exact: true });
    await expect(link, f.kind).toHaveAttribute('href', f.url);
    const box = (await link.boundingBox())!;
    expect(Math.round(box.height), f.kind).toBeGreaterThanOrEqual(44);
    // 36px round icon
    const icon = (await r.locator('[data-tint]').boundingBox())!;
    expect(Math.round(icon.width), f.kind).toBe(36);
  }
  // Only the emailed ones say so
  await expect(row(page, 'new_message')).toContainText('· Also emailed');
  await expect(row(page, 'payout_wallet_changed')).toContainText(
    '· Also emailed',
  );
  await expect(row(page, 'verified')).not.toContainText('Also emailed');

  // plan_not_activated alone is red; the informational ones are grey; the rest blue
  const red = await computed(
    row(page, 'plan_not_activated').locator('[data-tint]'),
    'color',
  );
  const blue = await computed(
    row(page, 'verified').locator('[data-tint]'),
    'color',
  );
  const grey = await computed(
    row(page, 'contact_email_changed').locator('[data-tint]'),
    'color',
  );
  expect(red).toMatch(/^rgb\((2[0-9]{2}), (\d{1,2}), (\d{1,2})\)$/);
  expect(blue).toMatch(/^rgb\(37, (99|100), 235\)$/);
  expect(grey).not.toBe(blue);
  expect(grey).not.toBe(red);
});

test("an old row with type 'business' and no kind renders as business_registered, with its stored text", async ({
  page,
}) => {
  await setup(page, [{ ...OLD_BUSINESS }]);
  await open(page);
  const r = row(page, 'business_registered');
  await expect(r).toHaveCount(1);
  await expect(r).toContainText(
    'Your business "Phephe" has been successfully registered and is now listed on Avante Maps!',
  );
  await expect(r.locator('strong')).toHaveText('Phephe');
  await expect(r.locator('[data-tint]')).toHaveAttribute('data-tint', 'muted');
  // No click_url: no action link
  await expect(r.getByRole('link')).toHaveCount(0);
});

test('unread rows have the blue background and the dot; read rows neither', async ({
  page,
}) => {
  const rows = allKindRows();
  rows[3]!.read = true; // plan_ending
  await setup(page, rows);
  await open(page);
  const unread = row(page, 'new_message');
  await expect(unread).toHaveAttribute('data-unread', 'true');
  await expect(unread.locator('[data-unread-dot]')).toBeVisible();
  await expect(unread.locator('[data-unread-dot]')).toHaveText('Unread');
  const dotColor = await computed(
    unread.locator('[data-unread-dot]'),
    'backgroundColor',
  );
  expect(dotColor).toMatch(/^rgb\(37, (99|100), 235\)$/);
  // The row tint: the accent token (#EFF6FF) at 40%, so the icon's accent circle still shows on it
  const tinted = unread.locator('[data-tint]').locator('xpath=..');
  await expect(tinted).toHaveClass(/(^|\s)bg-accent\/40(\s|$)/);
  expect(await computed(tinted, 'backgroundColor')).not.toBe(
    'rgba(0, 0, 0, 0)',
  );

  const read = row(page, 'plan_ending');
  await expect(read).not.toHaveAttribute('data-unread', 'true');
  await expect(read.locator('[data-unread-dot]')).toHaveCount(0);
  // No black (or any other) dots
  await expect(
    page.locator(
      '[data-notification-row] .rounded-full.bg-gray-700, [data-notification-row] .bg-black',
    ),
  ).toHaveCount(0);
});

test('Mark all as read clears the current tab only', async ({ page }) => {
  const { patches } = await setup(page, allKindRows());
  await open(page);
  await tab(page, 'Activity').tap();
  await expect(page.locator('[data-notification-row]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Mark all as read' }).tap();
  await expect(page.locator('[data-unread-dot]')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Mark all as read' }),
  ).toHaveCount(0);
  expect(patches).toHaveLength(1);
  expect(patches[0]!.body['read']).toBe(true);
  expect(decodeURIComponent(patches[0]!.query)).toContain('n-new_message');
  expect(decodeURIComponent(patches[0]!.query)).toContain('n-new_review');
  expect(decodeURIComponent(patches[0]!.query)).not.toContain('n-verified');

  // Account's rows are still unread
  await tab(page, 'Account').tap();
  await expect(page.locator('[data-unread-dot]')).toHaveCount(11);
  await expect(
    page.getByRole('button', { name: 'Mark all as read' }),
  ).toBeVisible();
});

test('tabs filter: Account is everything about businesses, plan and payments; Activity is messages and reviews', async ({
  page,
}) => {
  await setup(page, [...allKindRows(), { ...OLD_BUSINESS }]);
  await open(page);
  await expect(page.locator('[data-notification-row]')).toHaveCount(
    KINDS.length + 1,
  );

  await tab(page, 'Activity').tap();
  await expect(tab(page, 'Activity')).toHaveAttribute('aria-selected', 'true');
  const activity = await page
    .locator('[data-notification-row]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-notification-row')),
    );
  expect(activity.sort()).toEqual(['new_message', 'new_review']);

  await tab(page, 'Account').tap();
  const account = await page
    .locator('[data-notification-row]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-notification-row')),
    );
  expect(account.sort()).toEqual(
    [
      ...KINDS.filter((f) => f.tab === 'account').map((f) => f.kind),
      'business_registered',
    ].sort(),
  );
});

test('rows are grouped into Today and Earlier by created_at, newest first', async ({
  page,
}) => {
  await setup(page, allKindRows());
  await open(page);
  const today = page.getByRole('region', { name: 'Today' });
  const earlier = page.getByRole('region', { name: 'Earlier' });
  await expect(today.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(earlier.getByRole('heading', { name: 'Earlier' })).toBeVisible();
  const todayKinds = await today
    .locator('[data-notification-row]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-notification-row')),
    );
  expect(todayKinds).toEqual(KINDS.slice(0, 5).map((f) => f.kind));
  const earlierKinds = await earlier
    .locator('[data-notification-row]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-notification-row')),
    );
  expect(earlierKinds).toEqual(KINDS.slice(5).map((f) => f.kind));
  // Mark all as read sits with the first heading
  await expect(
    today.getByRole('button', { name: 'Mark all as read' }),
  ).toBeVisible();
  await expect(
    earlier.getByRole('button', { name: 'Mark all as read' }),
  ).toHaveCount(0);
});

test('empty states for each tab', async ({ page }) => {
  await setup(page, []);
  await open(page);
  await expect(page.getByText('No notifications yet')).toBeVisible();
  await expect(
    page.getByText(
      "We'll let you know about messages, reviews, your plan and your businesses.",
    ),
  ).toBeVisible();
  await tab(page, 'Account').tap();
  await expect(
    page.getByText(
      'Updates about your businesses, plan and payments show here.',
    ),
  ).toBeVisible();
  await tab(page, 'Activity').tap();
  await expect(page.getByText('Messages and reviews show here.')).toBeVisible();
});

test('a tab with nothing in it shows its empty state while the others have rows', async ({
  page,
}) => {
  await setup(page, [kindRow(KINDS[6]!, 6)]); // verified: Account only
  await open(page);
  await tab(page, 'Activity').tap();
  await expect(page.getByText('Messages and reviews show here.')).toBeVisible();
  await expect(page.locator('[data-notification-row]')).toHaveCount(0);
});

test('tapping a row opens its link, marks it read and records the click', async ({
  page,
}) => {
  const { patches, tracked } = await setup(page, allKindRows());
  await open(page);
  await row(page, 'new_message')
    .getByText('Are you open on Sunday afternoon?', { exact: false })
    .tap();
  await page.waitForURL('**/communicon');
  expect(
    patches.some(
      (p) => p.query.includes('n-new_message') && p.body['read'] === true,
    ),
  ).toBe(true);
  await expect
    .poll(() => tracked.find((t) => t['event_type'] === 'clicked'))
    .toEqual({
      // No click_url: the row already has it, and track-notification would overwrite it
      notification_id: 'n-new_message',
      event_type: 'clicked',
    });
});

test('the action link does the same', async ({ page }) => {
  const { patches, tracked } = await setup(page, allKindRows());
  await open(page);
  await row(page, 'plan_ending')
    .getByRole('link', { name: 'Renew plan' })
    .tap();
  await page.waitForURL('**/wallet');
  expect(
    patches.some(
      (p) => p.query.includes('n-plan_ending') && p.body['read'] === true,
    ),
  ).toBe(true);
  await expect
    .poll(() => tracked.filter((t) => t['event_type'] === 'clicked').length)
    .toBe(1);
});

test('a click_url that is not an in-app path gets no action link, and tapping the row only marks it read', async ({
  page,
}) => {
  const unsafe = [
    'https://example.com',
    'javascript:alert(1)',
    '//evil.example/path',
    '/\\evil.example',
  ];
  const rows = unsafe.map((url, i) => ({
    ...kindRow(KINDS[6]!, 6),
    id: `n-unsafe-${i}`,
    content: `Unsafe link ${i}`,
    created_at: todayAt(2 + i),
    click_url: url,
  }));
  const { patches, tracked } = await setup(page, rows);
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs += 1;
    void dialog.dismiss();
  });
  await open(page);
  for (let i = 0; i < unsafe.length; i++) {
    const r = page
      .locator('[data-notification-row]')
      .filter({ hasText: `Unsafe link ${i}` });
    await expect(r, unsafe[i]).toHaveCount(1);
    await expect(r.getByRole('link'), unsafe[i]).toHaveCount(0);
    await expect(r.locator('a'), unsafe[i]).toHaveCount(0);
    await r.getByText(`Unsafe link ${i}`).tap();
    await expect
      .poll(
        () =>
          patches.some(
            (p) => p.query.includes(`n-unsafe-${i}`) && p.body['read'] === true,
          ),
        { message: unsafe[i] },
      )
      .toBe(true);
    expect(new URL(page.url()).pathname, unsafe[i]).toBe('/notifications');
  }
  await page.waitForTimeout(500);
  expect(dialogs).toBe(0);
  expect(new URL(page.url()).pathname).toBe('/notifications');
  // Nothing was opened, so no click is recorded either
  expect(tracked.filter((t) => t['event_type'] === 'clicked')).toEqual([]);
  expect(tracked.some((t) => 'click_url' in t)).toBe(false);
});
