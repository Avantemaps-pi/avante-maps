# End-to-end performance tests

Playwright tests that run against a live preview of the app.

## Setup (one-time)

```bash
bun add -d @playwright/test     # already in devDependencies
bunx playwright install chromium
```

## Running

Against a local Vite dev server (default):

```bash
bun run dev                     # in one terminal
bunx playwright test            # in another
```

Against the deployed preview:

```bash
PREVIEW_URL=https://avantemaps.lovable.app bunx playwright test
```

## Tests

- `hero-cache.spec.ts` — verifies the hero logo (`avante-icon-*.webp`) and
  business/place hero images are served from the browser cache on the second
  visit to `/`. Fails if any hero asset is re-downloaded with a fresh
  `200 OK` body after navigating away and back. Production builds only: it
  is skipped unless `PREVIEW_URL` is set, because the dev server never caches
  `/src/assets`.

## No live Supabase requests

Specs import `test` from `helpers/fixtures.ts`, not `@playwright/test`. It fails any test that
sends a request to the real Supabase project that no mock handled, naming each one, because such a
request runs against live data with the tests' fake token and passes or fails on whatever comes
back. Mock the request in the spec (or in a shared helper). The unread-notifications count, which
every page asks for, is answered in the fixture. A spec that truly needs a live request opts out by
naming it, with a comment saying why, as `hero-cache.spec.ts` does:

```ts
test.use({ allowLiveSupabase: ['POST /rest/v1/rpc/get_public_business_info'] });
```

Map specs (`search-tap`, `reauth-false-success`, `place-drawer`,
`map-card-strip`) mock the business list and sign in with the sandbox mock
session through `helpers/mapMocks.ts`, so they don't depend on live data.

## No live Supabase requests

Every spec imports `test` from `helpers/fixtures.ts`, not `@playwright/test`. Its guard fails a test
that sends any request to the real Supabase project, because a request no mock handled would reach
live data with the tests' fake token. Mock the request in the spec, or in `helpers/mapMocks.ts` when
it's shared. The fixture itself answers the unread-notifications count that every page asks for.

A spec that truly needs a live request opts out by naming it, with a comment saying why:

```ts
test.use({ allowLiveSupabase: ['POST /rest/v1/rpc/get_public_business_info'] });
```

Only `hero-cache.spec.ts` does, as it checks real business photos on a deployed preview.

