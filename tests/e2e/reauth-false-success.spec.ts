/**
 * Regression test for the re-auth false-success gap in reAuthAndRetry()
 * (src/hooks/useMessages.ts).
 *
 * Scenario: the user has a cached local PiUser but NO Supabase session.
 * Tapping "Message" on a business card triggers reAuthAndRetry
 * ('missing-session') → login(). login() always resolves — even when
 * authentication genuinely fails — so the old code fired a false
 * "Signed back in — resuming…" success toast and the queued conversation
 * request hung until the 15s in-flight timeout produced "Couldn't open
 * the conversation."
 *
 * The fix re-checks supabase.auth.getSession() after login() resolves;
 * with no session it shows an honest "Sign-in failed" toast and resolves
 * the queued request promptly via resolvePendingConversation().
 *
 * The genuinely-failing login is simulated without live Pi auth: the real
 * SDK script is blocked and window.Pi is stubbed with an authenticate()
 * that rejects immediately (isPiBrowser() treats a present window.Pi as
 * Pi Browser, so performLogin() proceeds and fails fast through its retry
 * loop). The sandbox mock session (honored on localhost / Lovable preview
 * hosts only) provides the "local user without a Supabase session"
 * starting state. Businesses are mocked and the map is moved to zoom 17, where
 * each has its own pin (helpers/mapMocks.ts).
 */
import { test, expect } from './helpers/fixtures';
import { NEARBY_BUSINESSES, mockMap, pin, zoomToPins } from './helpers/mapMocks';

test('failed re-auth on Message tap shows honest failure, not false success', async ({ page }) => {
  // Mocked businesses and the sandbox session; the real Pi SDK is blocked so
  // it can't overwrite the stub below.
  await mockMap(page, NEARBY_BUSINESSES);

  await page.addInitScript(() => {
    // Stub Pi SDK: present (so the login flow proceeds) but authentication
    // always fails fast — the "genuine auth failure" this test exercises.
    (window as unknown as { Pi: object }).Pi = {
      init: () => undefined,
      authenticate: () => Promise.reject(new Error('User cancelled the authentication request')),
    };
    (window as unknown as { __piInitialized: boolean }).__piInitialized = true;
  });

  await page.goto('/');
  await zoomToPins(page, NEARBY_BUSINESSES);

  const marker = pin(page, NEARBY_BUSINESSES[0]!.name);
  await marker.click({ force: true });
  // A pin tap shows the card strip; its first card opens the drawer with Message
  await page.locator('[data-strip-card] button').first().click({ force: true });

  const messageButton = page.getByRole('button', { name: 'Message' }).first();
  await messageButton.waitFor({ state: 'visible', timeout: 15_000 });
  await messageButton.click();

  // Sanity anchor: we must have entered the re-auth path (cached user with
  // no Supabase session), not the plain "Sign in to message businesses"
  // signed-out branch.
  await expect(page.getByText('Signing you back in…')).toBeVisible({ timeout: 10_000 });

  // login() resolves without a session (stubbed authenticate rejects, and
  // performLogin's ~3 fast retry attempts exhaust). The fix must surface an
  // honest failure toast promptly — well inside the old 15s stall window.
  await expect(page.getByText('Sign-in failed. Please try again.')).toBeVisible({
    timeout: 10_000,
  });

  // resolvePendingConversation(null) must fail the queued request promptly,
  // giving the card's honest error instead of a hang until the 15s timeout.
  await expect(
    page.getByText("Couldn't open the conversation. Please try again."),
  ).toBeVisible({ timeout: 5_000 });

  // The false-positive toast this regression test exists for must never fire.
  await expect(page.getByText('Signed back in — resuming…')).toHaveCount(0);
});
