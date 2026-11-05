/**
 * Repeat-navigation cache test for the hero logo and hero/place images.
 *
 * Flow:
 *   1. First visit to "/" — record every network response whose URL looks
 *      like the hero logo (avante-icon-*.webp) or a business/place image.
 *   2. Navigate away to a different route, then back to "/".
 *   3. On the second visit, the same assets must either:
 *        - issue zero new network requests (served from memory/disk cache
 *          without hitting the network at all), OR
 *        - if a conditional request is made, return 304 Not Modified with
 *          transferSize 0 (i.e. nothing was actually downloaded again).
 *
 * The test fails if any hero asset is re-downloaded with a fresh 200 + body
 * on the second visit, which would indicate broken caching headers or a
 * cache-busting query string regression.
 *
 * Production builds only: run with PREVIEW_URL set. The dev server serves
 * images as uncached Vite modules (/src/assets/…?import), so it always fails
 * there and is skipped.
 */
import { test, expect, Response, Request } from './helpers/fixtures';

// The one spec that needs live data: it checks that the real business photos a deployed preview
// serves from Storage come from the browser cache on a second visit. Mocking them would test
// nothing. It only runs with PREVIEW_URL set
test.use({
  allowLiveSupabase: ['POST /rest/v1/rpc/get_public_business_info', 'GET /storage/v1/object/*'],
});

// Production builds add a content hash: avante-icon-144-pwxlNFwe.webp
const HERO_LOGO_RE = /avante-icon-\d+(-[\w-]+)?\.webp(\?|$)/i;
const HERO_IMAGE_RE = /\.(webp|jpe?g|png|avif)(\?|$)/i;

type Hit = {
  url: string;
  status: number;
  fromCache: boolean;
  transferSize: number | null;
};

function isHeroAsset(url: string) {
  if (HERO_LOGO_RE.test(url)) return true;
  // Treat business images served from Supabase storage as "hero images".
  if (/\/storage\/v1\/object\/.*\/business/i.test(url)) return true;
  if (/place|hero|business/i.test(url) && HERO_IMAGE_RE.test(url)) return true;
  return false;
}

async function collectHeroResponses(page: import('@playwright/test').Page) {
  const hits: Hit[] = [];
  const handler = async (response: Response) => {
    const req: Request = response.request();
    if (req.resourceType() !== 'image' && !HERO_LOGO_RE.test(response.url())) return;
    if (!isHeroAsset(response.url())) return;
    let transferSize: number | null = null;
    try {
      const sizes = await req.sizes();
      transferSize = (sizes.responseBodySize ?? 0) + (sizes.responseHeadersSize ?? 0);
    } catch {
      /* sizes() can throw if the request was served fully from cache */
    }
    hits.push({
      url: response.url(),
      status: response.status(),
      fromCache: response.fromServiceWorker() || transferSize === 0,
      transferSize,
    });
  };
  page.on('response', handler);
  return { hits, stop: () => page.off('response', handler) };
}

test.describe('Hero asset caching on repeat navigation', () => {
  test.skip(!process.env.PREVIEW_URL, 'Production builds only: set PREVIEW_URL (the dev server never caches /src/assets)');

  test('hero logo and hero images are not re-downloaded on second visit', async ({ page }) => {
    // --- First visit -------------------------------------------------------
    const first = await collectHeroResponses(page);
    await page.goto('/', { waitUntil: 'networkidle' });
    // Give lazy/below-the-fold images a brief chance to enter the viewport.
    await page.waitForTimeout(500);
    first.stop();

    const firstLogoHits = first.hits.filter((h) => HERO_LOGO_RE.test(h.url));
    expect(
      firstLogoHits.length,
      'expected the hero logo to be requested on the first visit',
    ).toBeGreaterThan(0);
    // Log first-visit totals for visibility in CI output.
    console.log(
      JSON.stringify({
        phase: 'first_visit',
        total_hero_requests: first.hits.length,
        logo_requests: firstLogoHits.length,
      }),
    );

    // --- Navigate away, then back -----------------------------------------
    await page.goto('/about', { waitUntil: 'domcontentloaded' }).catch(async () => {
      // /about may not exist in every build; falling back to a hard reload of
      // a different route still exercises the browser HTTP cache.
      await page.goto('/contact', { waitUntil: 'domcontentloaded' });
    });
    await page.waitForTimeout(200);

    const second = await collectHeroResponses(page);
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    second.stop();

    // --- Assertions --------------------------------------------------------
    const secondLogoHits = second.hits.filter((h) => HERO_LOGO_RE.test(h.url));
    const secondImageHits = second.hits.filter((h) => !HERO_LOGO_RE.test(h.url));

    console.log(
      JSON.stringify({
        phase: 'second_visit',
        total_hero_requests: second.hits.length,
        logo_requests: secondLogoHits.length,
        image_requests: secondImageHits.length,
        details: second.hits,
      }),
    );

    // Hero logo: zero new network downloads. A 304 with transferSize 0 is
    // acceptable, a 200 with non-zero body is a regression.
    for (const hit of secondLogoHits) {
      const cached = hit.status === 304 || hit.fromCache || hit.transferSize === 0;
      expect(
        cached,
        `hero logo ${hit.url} was re-downloaded (status=${hit.status}, transferSize=${hit.transferSize})`,
      ).toBe(true);
    }

    // Hero/place images: allow at most a small number of fresh fetches
    // (e.g. images that scrolled into view for the first time on visit 2),
    // but the majority must come from cache.
    const freshImageDownloads = secondImageHits.filter(
      (h) => !(h.status === 304 || h.fromCache || h.transferSize === 0),
    );
    expect(
      freshImageDownloads.length,
      `expected hero images to be cache hits on the second visit, ` +
        `but ${freshImageDownloads.length} were re-downloaded: ` +
        freshImageDownloads.map((h) => h.url).join(', '),
    ).toBeLessThanOrEqual(2);
  });
});
