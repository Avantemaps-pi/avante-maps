/**
 * Regression test for LoginDialog staying open on top of AuthenticatingOverlay's
 * terminal error card.
 *
 * LoginDialog's own try/catch only sees errors thrown by login(), but
 * performLogin() (authService.ts) swallows the 60s AuthTimeoutError and only
 * sets the context-level authError. The dialog never closed, and because Radix
 * portals it to the end of <body>, it aria-hid the "Sign-in didn't complete"
 * card underneath it — Try again / Dismiss were unreachable by mouse,
 * keyboard, or screen reader.
 *
 * Driven through /registration on purpose: Registration.tsx renders
 * LoginDialog unconditionally. The landing page is NOT a valid entry point for
 * this test — Index.tsx unmounts LandingPage (and its dialog) as soon as
 * isLoading flips true, which masks the bug.
 */
import { test, expect } from './helpers/fixtures';
import { NEARBY_BUSINESSES, mockBusinessList } from './helpers/mapMocks';

// The real 60s PI_AUTH_TIMEOUT_MS watchdog starts only after the permission
// and SDK-ready checks, so allow headroom past 60s (matches
// pi-auth-timeout-telemetry.spec.ts).
test.setTimeout(150_000);

test('LoginDialog on /registration closes when the 60s auth timeout sets authError', async ({ page }) => {
  // The 60s timeout records pi_auth_timeout; answer the beacon locally so
  // test runs never write rows to the production reauth_telemetry table.
  await page.route('**/functions/v1/telemetry-beacon**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }),
  );
  // Block the real SDK so the stub below survives.
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await mockBusinessList(page, NEARBY_BUSINESSES);
  await page.addInitScript(() => {
    (window as unknown as { Pi: object }).Pi = {
      init: () => undefined,
      // Never settles — the exact production failure mode.
      authenticate: () => new Promise(() => {}),
    };
    (window as unknown as { __piInitialized: boolean }).__piInitialized = true;
    (window as unknown as { __piSandboxMode: boolean }).__piSandboxMode = false;
  });

  await page.goto('/registration');

  const dialog = page.getByRole('dialog', { name: 'Sign in to Avante Maps' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });

  const connect = dialog.getByRole('button', { name: /Connect with Pi Network/i });
  await expect(connect).toBeEnabled({ timeout: 20_000 });
  await connect.click();

  // Terminal timeout: the overlay's error card appears...
  await expect(page.getByText("Sign-in didn't complete")).toBeVisible({ timeout: 90_000 });

  // ...and the dialog must be gone rather than stacked on top of it.
  await expect(dialog).toHaveCount(0);

  // Role-based lookup excludes aria-hidden content, so this also proves the
  // card is reachable by assistive tech, not just painted.
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await expect(page.getByText("Sign-in didn't complete")).toHaveCount(0);
});
