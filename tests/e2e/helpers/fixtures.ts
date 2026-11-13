/**
 * The `test` every spec imports. On top of Playwright's, it fails a test that sends a request to
 * the real Supabase project: a request no mock handled would otherwise reach live data with the
 * tests' fake token, and pass or fail depending on what came back and when. Mock it instead.
 *
 * The unread-notifications count, which every page asks for, and the stale payment cleanup a
 * signed-in app start runs, are answered here. The client error
 * log (log-error) deliberately isn't: it's only sent when the error boundary catches a crash, and
 * a test that crashes should fail with it named. A spec that truly needs a live request opts out by naming it, with a comment saying why:
 *   test.use({ allowLiveSupabase: ['HEAD /rest/v1/notifications'] });
 */
import { test as base, expect } from '@playwright/test';

export * from '@playwright/test';

export const SUPABASE_ORIGIN = 'https://xvpwbocwasbtzrzrxyvu.supabase.co';

interface Options {
  /** "METHOD /path" names of live requests this spec needs. A trailing * matches the rest of the path */
  allowLiveSupabase: string[];
}

export const test = base.extend<Options & { blockLiveSupabase: void }>({
  allowLiveSupabase: [[], { option: true }],
  blockLiveSupabase: [
    async ({ context, allowLiveSupabase }, use) => {
      const leaked = new Set<string>();
      // On the context, so it covers every page the test opens. Page routes and routes added
      // later win over it, so it only sees what no mock handled
      await context.route(`${SUPABASE_ORIGIN}/**`, (route) => {
        const request = route.request();
        const name = `${request.method()} ${new URL(request.url()).pathname}`;
        const allowed = allowLiveSupabase.some((entry) =>
          entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry,
        );
        if (allowed) return route.continue();
        leaked.add(name);
        return route.abort('blockedbyclient');
      });
      // The stale payment cleanup a signed-in app start runs: nothing to clean. A spec's own route wins
      await context.route(`${SUPABASE_ORIGIN}/functions/v1/cleanup-stale-payments`, (route) =>
        route.fulfill({ json: { success: true, message: 'No stale payments found', cleanedCount: 0 } }),
      );
      // The unread count every page asks for, answered once here. A spec's own route wins
      await context.route(`${SUPABASE_ORIGIN}/rest/v1/notifications*`, (route) =>
        route.request().method() === 'HEAD'
          ? route.fulfill({ status: 200, headers: { 'content-range': '*/0' } }) // The unread count: none
          : route.fulfill({ json: [] }),
      );
      await use();
      expect([...leaked].sort(), 'requests to the real Supabase project: mock them (or opt out by name with allowLiveSupabase)').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
