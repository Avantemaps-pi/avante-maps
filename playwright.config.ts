import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for end-to-end / perf tests.
 *
 * By default we target the local Vite dev server at http://localhost:8080.
 * To run against the deployed preview, set PREVIEW_URL, e.g.:
 *   PREVIEW_URL=https://avantemaps.lovable.app bun playwright test
 */
const baseURL = process.env.PREVIEW_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './tests/e2e',
  // A stuck test fails after 60s; a stuck run (or server) fails after 45 minutes
  // instead of hanging.
  timeout: 60_000,
  // The suite is now ~214 tests and ~27 minutes, too close to the old 30-minute limit
  globalTimeout: 45 * 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // The html report is written but never served, so nothing waits for Ctrl+C
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    // Keep the cache enabled — that is exactly what we are measuring.
    serviceWorkers: 'allow',
  },
  // Playwright starts the dev server (port 8080, from the Lovable vite config)
  // and stops it after the run; one that's already running is reused. Not
  // used when PREVIEW_URL points at a deployed preview.
  webServer: process.env.PREVIEW_URL
    ? undefined
    : {
        command: 'bun run dev',
        url: baseURL,
        timeout: 120_000,
        reuseExistingServer: !process.env.CI,
      },
  projects: [
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
