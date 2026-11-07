/**
 * The review page's tabs: /review/<id>?tab=reviews (the new-review notification's "See review"
 * link) opens on View Reviews and keeps it on reload; /review/<id> still opens on Write Review.
 *
 * 375x812 with the sandbox session and mocked Supabase.
 */
import { test, expect, type Page } from './helpers/fixtures';
import { SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser } from './helpers/mapMocks';

test.use({
  viewport: { width: 375, height: 812 },
  hasTouch: true,
  isMobile: true,
});

const SUPABASE = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';
const BAKERY = {
  id: 9001,
  name: 'Sunrise Bakery',
  category: 'Food',
  business_types: ['Food'],
  keywords: [],
  description: 'Sunrise Bakery test listing',
  latitude: 10,
  longitude: 10,
  images: [],
  contact_info: {},
  hours: {},
  city: 'Testville',
  country: 'Testland',
  is_verified: false,
  is_certified: false,
};
const REVIEW = {
  id: 'r-1',
  business_id: BAKERY.id,
  user_id: '00000000-0000-0000-0000-0000000000aa',
  rating: 5,
  content: 'Best sourdough in town.',
  created_at: '2026-11-06T10:00:00Z',
  updated_at: '2026-11-06T10:00:00Z',
};

async function setup(page: Page) {
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.route(`${SUPABASE}/**`, (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/rpc/get_public_business_info*', (route) =>
    route.fulfill({ json: [BAKERY] }),
  );
  await page.route('**/rest/v1/reviews*', (route) =>
    route.fulfill({ json: [REVIEW] }),
  );
  await page.addInitScript(
    ([mockKey, storageKey, user]) => {
      localStorage.setItem(mockKey as string, '1');
      localStorage.setItem(
        storageKey as string,
        JSON.stringify({ ...(user as object), lastAuthenticated: Date.now() }),
      );
    },
    [SANDBOX_MOCK_KEY, STORAGE_KEY, mockUser] as const,
  );
}

const tab = (page: Page, name: 'Write Review' | 'View Reviews') =>
  page.getByRole('tab', { name });

test('?tab=reviews opens on View Reviews, and keeps it on reload', async ({
  page,
}) => {
  await setup(page);
  await page.goto(`/review/${BAKERY.id}?tab=reviews`);
  await expect(tab(page, 'View Reviews')).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 10_000 },
  );
  await expect(tab(page, 'Write Review')).toHaveAttribute(
    'aria-selected',
    'false',
  );
  await expect(page.getByText(REVIEW.content)).toBeVisible();
  // Left in the URL
  expect(new URL(page.url()).search).toBe('?tab=reviews');
  await page.reload();
  await expect(tab(page, 'View Reviews')).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 10_000 },
  );
});

test('without it, the page still opens on Write Review', async ({ page }) => {
  await setup(page);
  await page.goto(`/review/${BAKERY.id}`);
  await expect(tab(page, 'Write Review')).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 10_000 },
  );
  await expect(tab(page, 'View Reviews')).toHaveAttribute(
    'aria-selected',
    'false',
  );
});

test('any other tab value keeps the default', async ({ page }) => {
  await setup(page);
  await page.goto(`/review/${BAKERY.id}?tab=nonsense`);
  await expect(tab(page, 'Write Review')).toHaveAttribute(
    'aria-selected',
    'true',
    { timeout: 10_000 },
  );
});
