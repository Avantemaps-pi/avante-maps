/**
 * Regression test for the "stuck on Preparing your map..." mainnet bug.
 *
 * A hung Pi.authenticate() (no resolve, no reject — what happens when the
 * Pi Browser approval sheet never comes back) used to leave
 * AuthenticatingOverlay mounted forever: appReady stayed false on the
 * timeout path, the retry loop re-ran the hung handshake, and the overlay
 * had no error state and no escape control.
 *
 * The fix: a slow-auth affordance with Cancel at 20s, a terminal 60s
 * timeout that surfaces an error card with Try again / Dismiss, and
 * appReady always settling so the overlay can never latch.
 */
import { test, expect } from './helpers/fixtures';

// Generous budget: the 60s PI_AUTH_TIMEOUT_MS watchdog only starts once
// requestAuthPermissions + the SDK-ready checks have run, so wall-clock time
// from button click to the error card can run somewhat past 60s.
test.setTimeout(150_000);

test('hung Pi handshake surfaces an escape hatch, then a dismissible error', async ({ page }) => {
  // The 60s timeout records pi_auth_timeout; answer the beacon locally so
  // test runs never write rows to the production reauth_telemetry table.
  await page.route('**/functions/v1/telemetry-beacon**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }),
  );
  // Block the real SDK so the stub below survives.
  await page.route('**/pi-sdk.js', (route) => route.abort());
  await page.addInitScript(() => {
    (window as unknown as { Pi: object }).Pi = {
      init: () => undefined,
      // Never settles — the exact production failure mode.
      authenticate: () => new Promise(() => {}),
    };
    (window as unknown as { __piInitialized: boolean }).__piInitialized = true;
    (window as unknown as { __piSandboxMode: boolean }).__piSandboxMode = false;
  });

  await page.goto('/');

  const connect = page.getByRole('button', { name: /Connect with Pi Network/i }).first();
  await connect.waitFor({ state: 'visible', timeout: 20_000 });
  await connect.click();

  // 20s slow-auth affordance: the user must get a way out before the timeout.
  await expect(page.getByText('This is taking longer than usual', { exact: false })).toBeVisible({
    timeout: 40_000,
  });

  // 60s terminal timeout: an honest error card replaces the fake progress,
  // instead of retrying the hung handshake for minutes.
  await expect(page.getByText("Sign-in didn't complete")).toBeVisible({ timeout: 60_000 });

  const dismiss = page.locator('button', { hasText: 'Dismiss' }).first();
  await dismiss.click();
  await expect(page.getByText("Sign-in didn't complete")).toHaveCount(0);
});
