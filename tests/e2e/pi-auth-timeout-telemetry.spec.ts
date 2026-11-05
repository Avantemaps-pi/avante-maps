/**
 * Regression/telemetry test for the Pi.authenticate() 60s timeout path in
 * performLogin() (src/context/auth/authService.ts, PI_AUTH_TIMEOUT_MS).
 *
 * Production incident this covers: multiple users are hitting the
 * "Pi Network didn't respond" timeout with retry not resolving it, and the
 * only diagnostic signal used to be secureLogger's console output — invisible
 * to us once it happens in someone else's browser. authService.ts records a
 * 'pi_auth_timeout' telemetry event the moment the 60s watchdog fires (and
 * 'pi_auth_resolved' when Pi.authenticate() succeeds), so we can tell
 * server-side whether Pi.authenticate() is hanging vs. failing fast.
 *
 * pi_auth_timeout / pi_auth_resolved / pi_auth_error fire from inside
 * performLogin() before supabase.auth.setSession() is ever reached, at a
 * point where the Supabase client structurally has no authenticated-role
 * session — confirmed directly against reauth_telemetry's RLS (it's
 * `TO authenticated` only; SET LOCAL ROLE anon -> 42501). The normal
 * client-side insert() can never pass RLS for these three event types, on any
 * platform, so recordReauthEvent() (reauthTelemetry.ts) routes them
 * exclusively through supabase/functions/telemetry-beacon instead, which
 * inserts with the service role key. The primary transport is a keepalive
 * fetch() with a text/plain body (a CORS "simple" request — no preflight),
 * falling back to navigator.sendBeacon() if fetch is missing, throws, rejects,
 * or gets a non-2xx response.
 * The first test asserts both halves of that: the beacon request actually
 * fires over the fetch transport, and — just as importantly — no direct insert
 * to reauth_telemetry is ever attempted for this event type (it would be
 * wasted, since it cannot succeed). The remaining tests cover the sendBeacon
 * fallback for each fetch failure mode.
 *
 * This test simulates a hung Pi.authenticate() call (mirrors the window.Pi
 * stubbing pattern from reauth-false-success.spec.ts, but the stub's
 * authenticate() never resolves or rejects instead of rejecting immediately).
 */
import { test, expect } from './helpers/fixtures';

// Generous budget: the 60s PI_AUTH_TIMEOUT_MS watchdog only starts once
// requestAuthPermissions + the SDK-ready checks have run, so wall-clock time
// from button click to the recorded event can run somewhat past 60s.
test.setTimeout(150_000);

test('hung Pi.authenticate() records exactly one pi_auth_timeout event via the beacon path, never the direct insert', async ({
  page,
}) => {
  const beaconPayloads: any[] = [];
  const beaconHeaders: Record<string, string>[] = [];
  const directInsertAttempts: string[] = [];

  // Intercept the beacon edge function so this test never writes to the real
  // production table — just observes what recordReauthEvent() would have sent.
  await page.route('**/functions/v1/telemetry-beacon**', async (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      beaconPayloads.push(body);
      beaconHeaders.push(await route.request().allHeaders());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    } else {
      await route.continue();
    }
  });

  // pi_auth_timeout must NEVER attempt the direct insert path (it's beacon-only
  // now) — track any attempt so it fails the test rather than silently passing.
  await page.route('**/rest/v1/reauth_telemetry**', async (route) => {
    if (route.request().method() === 'POST') {
      directInsertAttempts.push(route.request().url());
    }
    await route.continue();
  });

  // Block the real Pi SDK so it can't overwrite the stub below.
  await page.route('**/pi-sdk.js', (route) => route.abort());

  await page.addInitScript(() => {
    // Stub Pi SDK: present and "initialized" (so preflight resolves to 'ok'
    // and the login button is enabled), but authenticate() hangs forever —
    // the "Pi Network never responds" scenario this test exercises.
    (window as unknown as { Pi: object }).Pi = {
      init: () => undefined,
      authenticate: (_scopes: string[], _onIncompletePayment: (p: unknown) => void) =>
        new Promise(() => {
          /* never resolves or rejects */
        }),
    };
    (window as unknown as { __piInitialized: boolean }).__piInitialized = true;
  });

  await page.goto('/');

  // Logged-out root route renders LandingPage, which opens LoginDialog by
  // default (showLogin defaults to true).
  const connectButton = page.getByRole('button', { name: 'Connect with Pi Network' });
  await connectButton.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(connectButton).toBeEnabled({ timeout: 15_000 });
  await connectButton.click();

  // The 60s watchdog (PI_AUTH_TIMEOUT_MS) must fire and surface the existing
  // user-facing error — unchanged by this instrumentation. It shows up in
  // multiple places at once (toast + overlay + dialog), so just wait for the
  // beacon payload itself rather than pin down one specific element.
  await expect
    .poll(() => beaconPayloads.some((row) => row?.event_type === 'pi_auth_timeout'), {
      timeout: 120_000,
    })
    .toBe(true);

  // Exactly one pi_auth_timeout event, with sensible metadata, tagged as
  // beacon-sourced.
  const timeoutEvents = beaconPayloads.filter((row) => row?.event_type === 'pi_auth_timeout');
  expect(timeoutEvents).toHaveLength(1);

  const [event] = timeoutEvents;
  expect(event.metadata.paymentCallbackFired).toBe(false);
  expect(event.metadata.piPresent).toBe(true);
  expect(event.metadata.piAuthenticateIsFunction).toBe(true);
  expect(event.metadata.elapsedMs).toBeGreaterThanOrEqual(59_000);
  expect(event.metadata.elapsedMs).toBeLessThan(75_000);
  expect(event.is_retry).toBe(false);

  // Sent over the primary keepalive-fetch transport as a CORS "simple"
  // request: text/plain body, no Authorization/apikey headers.
  expect(event.via).toBe('beacon-fetch');
  const [headers] = beaconHeaders;
  expect(headers['content-type']).toBe('text/plain;charset=UTF-8');
  expect(headers['authorization']).toBeUndefined();
  expect(headers['apikey']).toBeUndefined();

  // No spurious success/error events for this hung attempt.
  expect(beaconPayloads.filter((row) => row?.event_type === 'pi_auth_resolved')).toHaveLength(0);
  expect(beaconPayloads.filter((row) => row?.event_type === 'pi_auth_error')).toHaveLength(0);

  // The direct insert path must never be attempted for pi_auth_timeout — it
  // is beacon-only, since it structurally cannot pass reauth_telemetry's RLS.
  expect(directInsertAttempts).toHaveLength(0);
});

// Each way the primary keepalive fetch can fail must fall back to sendBeacon.
// 'sync-throw' needs a stubbed fetch; 'rejected' and 'non-2xx' use the real
// fetch and fail it at the network layer via the route handler below.
for (const failure of ['sync-throw', 'rejected', 'non-2xx'] as const) {
  test(`falls back to sendBeacon, tagged beacon-sendbeacon, when fetch fails (${failure})`, async ({ page }) => {
    const fetchAttempts: Record<string, unknown>[] = [];
    const sendBeaconPayloads: Record<string, unknown>[] = [];
    const sendBeaconHeaders: Record<string, string>[] = [];

    await page.route('**/functions/v1/telemetry-beacon**', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.via === 'beacon-fetch') {
        fetchAttempts.push(body);
        if (failure === 'rejected') {
          await route.abort('failed');
        } else {
          await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated"}' });
        }
        return;
      }
      sendBeaconPayloads.push(body);
      sendBeaconHeaders.push(await route.request().allHeaders());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    });

    await page.route('**/pi-sdk.js', (route) => route.abort());

    await page.addInitScript(() => {
      // authenticate() rejects immediately, so pi_auth_error records right away
      // instead of waiting on the 60s watchdog.
      (window as unknown as { Pi: object }).Pi = {
        init: () => undefined,
        authenticate: () => Promise.reject(new Error('User cancelled the authentication request')),
      };
      (window as unknown as { __piInitialized: boolean }).__piInitialized = true;
    });

    await page.goto('/');

    const connectButton = page.getByRole('button', { name: 'Connect with Pi Network' });
    await connectButton.waitFor({ state: 'visible', timeout: 15_000 });
    await expect(connectButton).toBeEnabled({ timeout: 15_000 });

    if (failure === 'sync-throw') {
      // Installed only after the app has mounted: useSupabaseSession wraps
      // window.fetch in an async function, which would turn a synchronous
      // throw from anything underneath it into a rejected promise. As the
      // outermost wrapper, this throws synchronously for the beacon endpoint
      // only; every other request (Supabase client, assets) is untouched.
      await page.evaluate(() => {
        const realFetch = window.fetch;
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input instanceof Request ? input.url : input).includes('/functions/v1/telemetry-beacon')) {
            throw new TypeError('simulated synchronous fetch failure');
          }
          return realFetch(input, init);
        };
      });
    }
    await connectButton.click();

    await expect
      .poll(() => sendBeaconPayloads.some((row) => row.event_type === 'pi_auth_error'), { timeout: 30_000 })
      .toBe(true);

    // The fetch transport is tried first unless it threw before sending.
    if (failure === 'sync-throw') {
      expect(fetchAttempts).toHaveLength(0);
    } else {
      expect(fetchAttempts.some((row) => row.event_type === 'pi_auth_error')).toBe(true);
    }

    // performLogin()'s retry loop may record one pi_auth_error per attempt;
    // every fallback send must be tagged and sent as text/plain (no preflight).
    expect(sendBeaconPayloads.map((row) => row.via)).toEqual(sendBeaconPayloads.map(() => 'beacon-sendbeacon'));
    expect(sendBeaconHeaders.map((h) => h['content-type'])).toEqual(
      sendBeaconHeaders.map(() => 'text/plain;charset=UTF-8'),
    );
  });
}
