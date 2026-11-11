# CLAUDE.md — Avante Maps

*This file is automatically read by Claude Code at the start of every session in this repo. It should never be edited to include a specific one-off task — describe the task in the chat/session itself, not here. Keep this file as durable, project-level context only.*

---

## Project Identity

I'm working on **Avante Maps** — a Pi Network-powered business directory web app. Solo-founded, KYC-verified on Pi Network. This is a side project that acts as an introduction to a larger primary vision called **Avante World** (a low-poly virtual world replica) — do not discuss Avante World publicly in any user-facing copy unless I explicitly ask you to; it should only ever be hinted at vaguely in marketing contexts.

**Brand identity — non-negotiable:**
- Colors: strictly **blue (#2563EB primary, #1E3A8A navy) and white**. NEVER gold, amber, orange, or any warm color, anywhere in the codebase, in any component, ever. This was a firm deliberate decision.
- Positioning: **"Made For Pi. Not Made By Pi."** — Avante Maps is explicitly NOT an official Pi Network product. Never write copy that implies official affiliation with Pi Core Team.
- Tone: solo indie developer, community-first, honest — not corporate SaaS language.

---

## Tech Stack

- **Framework:** TanStack Start (`@tanstack/react-start`) with server-side rendering — NOT a client-only SPA. React 19 + TypeScript 5.8 + Vite 8, configured through `@lovable.dev/vite-tanstack-config` in `vite.config.ts` (it already bundles the React, Tailwind, nitro and TanStack plugins — don't add them again). `src/server.ts` is the SSR server entry.
- **Routing:** TanStack Router (`@tanstack/react-router`), file-based routes in `src/routes/` (`src/routeTree.gen.ts` is generated — don't hand-edit). NOT React Router. `src/lib/router-compat.tsx` is a shim that maps React Router v6-style calls (`useNavigate`, `Link`, etc.) onto TanStack Router, so older components still import from `@/lib/router-compat`.
- **Backend:** Supabase (Postgres + Auth + Edge Functions + Realtime), client `@supabase/supabase-js` 2.110
- **Supabase URL/project is hardcoded**, not read from env: `src/config/supabase.ts` (`SUPABASE_CONFIG`) holds the URL, publishable key (`sb_publishable_…`, in the field still named `anonKey`) and project ID for `xvpwbocwasbtzrzrxyvu`. Edge function URLs come from `getSupabaseFunctionsUrl()` in the same file; don't hardcode them. `VITE_SUPABASE_URL` in `.env` is NOT read by any client code, so changing env vars in a deployment does not change which project it talks to — every build uses this one project.
- **Data fetching:** TanStack Query (React Query) 5.101 — used across all major hooks with `staleTime`/`gcTime` caching
- **Forms/validation:** React Hook Form 7.71 + Zod 3.24
- **UI:** Tailwind CSS 4 with tw-animate-css + shadcn/ui (Radix UI primitives) + Lucide React icons + Sonner for toasts
- **Maps:** Leaflet 1.9.4 + React Leaflet 5 + React Leaflet Cluster 4.1, OpenStreetMap tiles (NOTE: `@googlemaps/react-wrapper` is in package.json but UNUSED — the entire map is Leaflet-based, this dependency is dead weight)
- **Charts:** Recharts 2.15.4 (business analytics dashboards)
- **Testing:** Playwright e2e suite in `tests/e2e/` and Deno tests for edge functions (see Testing below)
- **Package manager:** Bun. `bun.lock` is the ONLY lockfile — `package-lock.json` was deliberately removed (and is gitignored), and `bun.lockb` was superseded by the text-format `bun.lock`. Don't commit a second lockfile.
- **Hosting:** Vercel (via GitHub) for both `mainnet.avantemaps.com` and `testnet.avantemaps.com` (confirmed via `server: Vercel` / `x-vercel-id` response headers), with SSR running as a Vercel function. The build's Cloudflare target in `@lovable.dev/vite-tanstack-config` is only nitro's *fallback* when no provider is detected; on Vercel, nitro auto-detects Vercel and builds for it. Local builds fall back to Cloudflare output (`.output/`). Supabase Edge Functions run on Deno.
- **Payments/blockchain:** Pi Network SDK

---

## Key Resources

| Resource | Value |
|---|---|
| Lovable project ID | `ad58478f-862b-4337-99c0-4bd1bc66d916` |
| Lovable Dev branch | `Dev` (source of truth) |
| GitHub repo | `https://github.com/Avantemaps-pi/avantemaps` (branch: `Dev`) |
| Supabase project ID | `xvpwbocwasbtzrzrxyvu` |
| Supabase URL | `https://xvpwbocwasbtzrzrxyvu.supabase.co` |
| App domain | `avantemaps.com` |
| Pi Network app URL | `avantemapsaebbcf9516.pinet.com` |
| Support email | `support@avantemaps.com` |
| Inquiries email | `inquiries@avantemaps.com` |
| Businesses email | `businesses@avantemaps.com` |

---

## Critical Architectural Rule — READ THIS FIRST

**There are TWO different ID systems in this app that must NEVER be confused:**

1. **Pi Network UID** (`user.pi_uid`) — comes from Pi Network authentication
2. **Supabase Auth UUID** (`session.user.id`) — comes from `supabase.auth.getSession()`

After a normal login, `user.uid` (the `PiUser` from `useAuth()`) holds the Supabase user ID, with the Pi ID in `pi_uid`. This is guaranteed by `verification.ts` passing `verify-pi-auth`'s `user` through (it used to drop it, so `uid` fell back to the Pi ID) and by `authService.ts` taking `uid` from the live session (`session.user.id`) once it has set it. `AuthProvider`'s reload restore relies on this: it drops the cached user when `session.user.id !== user.uid`. But `user.uid` can still be the Pi ID if no Supabase session could be set at login, and a saved login can be stale against the live session. So `user.uid` is not a reliable ownership ID; read it from the session instead.

**Rule: ALWAYS use the Supabase UUID for any database ownership check, RLS policy, or `.eq('owner_id', ...)` / `.eq('customer_id', ...)` type query. NEVER use `user.uid` for database queries.**

This exact bug class has caused multiple production incidents in this app:
- "Authentication mismatch" toasts for legitimately logged-in users
- Businesses not appearing on "Your Businesses" page (query used wrong ID)
- Business registration limits not being enforced (count always returned 0)
- CommuniCon messaging validation failing (`validateConversation` initially used wrong column names AND wrong ID system)

Before writing ANY query that checks user ownership or access, get the session explicitly:
```typescript
const { data: { session } } = await supabase.auth.getSession();
const userId = session?.user?.id; // This is the correct ID to use in queries
```

---

## RLS Policies — READ THIS BEFORE WRITING ANY AUTH-SENSITIVE QUERY

RLS is enabled on `businesses`, `conversations`, `messages`, and `users`. A query can look completely correct client-side and still return zero rows or silently fail an insert if it doesn't satisfy these policies. **Before writing any new query or mutation against these tables, either paste the current policies into the chat or ask me to fetch them fresh via Supabase MCP (`list_tables` / `execute_sql` against `pg_policies`) — policies may have changed since this prompt was written.**

Known policy behavior as of this writing:

- **`businesses`** — SELECT/UPDATE/DELETE/INSERT all scoped to `owner_id = auth.uid()`. There is no public SELECT policy visible here for browsing all businesses — public business browsing goes through a `SECURITY DEFINER` RPC (`get_public_business_info` or similar), not a direct table select. Don't assume `.from('businesses').select()` will return other people's businesses to an anon/authenticated non-owner — it won't, by design.

- **`conversations`** — INSERT requires `customer_id = auth.uid()`. SELECT/UPDATE allowed if `customer_id = auth.uid()` OR `is_business_owner(auth.uid(), business_id)` (a Postgres function, not a raw column check). Any validation logic must use this same "customer OR business owner" pattern, not a `sender_id`/`recipient_id` check — those columns don't exist.

- **`messages`** — INSERT policy is a compound gate (`"Participants can send messages with gating"`): a customer can only insert if they're verified OR have a paid, unused `message_fee` from the last 60 seconds; a business can only insert if the business has an active paid subscription (`has_active_paid_subscription()`). **This means an unverified customer's message insert can fail RLS even though the UI let them type and hit send — always surface the actual Postgres error to the user/toast rather than assuming success.** There are also explicit `deny all` policies for realtime broadcast/presence on `messages` — don't rely on Supabase Realtime presence/broadcast channels for this table, only postgres_changes.

- **`users`** — SELECT/UPDATE/DELETE scoped to `id = auth.uid()`, anonymous access explicitly denied. **Critically: the UPDATE policy's `with_check` blocks a user from changing their own `subscription` or `pi_uid` columns**, even on their own row — those must be changed via a `SECURITY DEFINER` function/Edge Function, never a direct client-side `.update()`. If a subscription upgrade/downgrade isn't taking effect, this is the first thing to check.

**Rule of thumb:** if a query/mutation "should work" but returns no data or a silent no-op, check RLS before assuming it's an application bug. Use `Supabase:get_advisors` (type: `security`) after any schema change to catch missing/misconfigured policies.

---

## Supabase keys (since 21 Oct 2026)

- **Legacy JWT-based API keys are disabled.** The `eyJ…` anon and service_role keys were turned off in Supabase because the service_role key leaked in this public repo's git history. Any request that uses an `eyJ…` API key fails.
- **The app uses the publishable key** (`sb_publishable_…`) in `src/config/supabase.ts` and `.env`. Never put an `eyJ…` key back.
- **Direct `fetch` calls to edge functions** send `apikey: <publishable key>`, plus `Authorization: Bearer <user access token>` only when signed in. Never send the publishable key as a Bearer token — it isn't a JWT.
- **Never write any secret into any file in the repo, including `.env`** — `sb_secret_…`, service role, JWT secret, cron secret, third-party API keys. Secrets live in Supabase (Edge Functions → Secrets, Vault) and Vercel env vars. The repo is public and GitHub push protection is on.
- **Edge functions read `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY`**; Supabase fills them with the new keys. Don't add custom secrets with those names.
- **Merging to `Dev` doesn't deploy edge functions or apply migrations** — they're deployed separately (`supabase functions deploy <name> --project-ref xvpwbocwasbtzrzrxyvu`, and migrations applied by hand).
- **Cron-triggered functions authenticate with the `X-Cron-Secret` header**, checked via `public.verify_cron_secret` (`supabase/functions/_shared/cronAuth.ts`). pg_cron jobs read the secret from Vault (`cron_shared_secret`); don't send an `Authorization` header from cron.
- In triggers and functions, detect the service role with auth.role() = 'service_role', never current_setting('request.jwt.claim.role') (current PostgREST doesn't set it).

---

## Pi payments

Full reference: `claude/pi-payments-reference.md` in the claude.ai project. Durable facts:

- **Two Pi apps.** Testnet (testnet.avantemaps.com, server key `PI_API_KEY`) and Mainnet (server key `PI_MAINNET_API_KEY`). Each app sees only its own payments. Which app a payment belongs to depends on how Avante Maps was opened, so to test testnet payments, type testnet.avantemaps.com into the Pi Browser. As of 11 Nov 2026 the payment functions read only `PI_API_KEY`.
- **Pi uids are per app.** Never compare `users.pi_uid` with a payment's `user_uid`. The payer check calls Pi's `/v2/me` with the client's in-memory `piAccessToken` (from this page load's `Pi.authenticate()`), and checks the uid and the signed-in user's username (#173).
- **SDK:** `sandbox: false` inside the Pi Browser. `init()` and the payments scope belong to one `window.Pi` instance. Never trust them from localStorage or an earlier page load (#168, #169).
- **Pi retries `onReadyForServerApproval` about every 10 s for its 60 s window**, also after we refuse. Client payment flows settle once and ignore later callbacks in the UI (#174).
- **approve-payment, complete-payment and payment-status run with verify_jwt off.** They aren't in `supabase/config.toml`, so deploy them with `--no-verify-jwt`. CORS (`_shared/cors.ts`) must allow `x-lifecycle-id` and `x-correlation-id`.
- **`/validation-key.txt` is served per host** from `src/config/piValidationKeys.ts` (no static file in `public/`).
- **When a payment fails, read approve-payment's logs first:** `piErrorBody`, `payment_user_mismatch`, `pi_token_*`.

---

## Environment & Branch Workflow

- **`Dev` is the source of truth branch** on both Lovable and GitHub (`Avantemaps-pi/avantemaps`, branch `Dev`).
- **Do not commit directly to `Dev` for anything non-trivial.** Work on a feature branch cut from `Dev` (e.g. `fix/auth-mismatch`, `feat/business-analytics`) and open a PR back into `Dev` for review, unless I've explicitly told you a specific change is a direct-to-Dev hotfix.
- Production deploys to `avantemaps.com` via Vercel are connected to this repo — confirm with me which branch is wired to the production Vercel deployment before assuming a merge to `Dev` auto-deploys.

---

## ⚠️ Lovable Is Also Actively Editing This Repo — Check For Overlap First

I use **both** Claude Code and Lovable's own AI agent (via its MCP) to make changes to this exact project/repo, often in the same day. This creates real risk of both agents editing the same file without knowing about each other's changes.

**Before starting any non-trivial task:**
1. Pull the latest `Dev` branch and check `git log` for recent commits you didn't make.
2. If you have access to Lovable's MCP tools in this environment, check `list_edits` (project ID above) for recent Lovable-agent edits and `get_diff` on the latest few to see what changed.
3. If a file you're about to touch was edited very recently by "the other agent," tell me and confirm before proceeding rather than silently overwriting or merging blind.

This isn't optional — we've had real bugs in this project caused by assumptions about file state that turned out to be stale.

---

## Database Schema Notes (conversations table specifically)

The `conversations` table uses `customer_id` and `business_id` columns — **NOT** `sender_id`/`recipient_id`. Business ownership is checked via `businesses.owner_id`. If you ever need to validate conversation access, the correct pattern is:

```typescript
const { data: convRow } = await supabase
  .from('conversations')
  .select('id, customer_id, business_id')
  .eq('id', conversationId)
  .maybeSingle();

// Customer side
if (convRow.customer_id === userId) { /* valid */ }

// Business side — check business ownership
const { data: bizRow } = await supabase
  .from('businesses')
  .select('id')
  .eq('id', convRow.business_id)
  .eq('owner_id', userId)
  .maybeSingle();
```

---

## Business Rules Already Implemented (do not break these)

1. **Subscription tier business limits** (enforced at 3 layers — frontend, Edge Function, AND a Postgres trigger `enforce_business_limit()`):
   - Individual: 1 business
   - Small Business: 3 businesses
   - Organization: 5 businesses
   - `is_active` column on `businesses` handles downgrade — excess listings get deactivated, most recent stay active, queries filter `.eq('is_active', true)`

2. **Auth flow specifics:**
   - No `supabase.auth.signOut()` before `setSession()` (creates a session gap)
   - No `Pi.authenticate()` calls during silent background refresh
   - The browser doesn't write the `users` row: `verify-pi-auth` (service role) does. `upsert_user_profile` is service-role only and must not be called from the browser or granted to `authenticated`.
   - Sandbox/dev login bypass exists (`isSandbox` check) — only visible when `window.Pi` is unavailable, hidden in production Pi Browser

3. **CommuniCon (messaging) live mode:**
   - Redirects with toast + falls back to AI mode if `openConversationId` is missing
   - `validateConversation()` in `useChatState.tsx` must complete before live mode renders
   - Retry button on error toasts, three distinct error states: missing / not_found / access_denied

4. **Performance work already done:**
   - 10 database indexes on foreign keys + hot filter columns
   - Optimistic UI on comments, comment voting, messages, bookmarks (standard TanStack Query onMutate/onError rollback pattern)
   - `select('*')` eliminated everywhere except admin dashboards and `count: 'exact', head: true` queries (where it's a no-op)
   - `MapMarkers` component memoized with `React.memo` + custom comparator, marker icons memoized with `useMemo`
   - Map auto-geolocation on load via `navigator.geolocation`, silent fallback to world view if denied/unavailable

---

## App Conventions

- **Navigation rule:** main destinations show the bottom nav. Task pages (Registration steps, Update business, Write a review, Pricing, Verification info, Analytics, CommuniCon) hide it and use the header back arrow (`backButton` + `hideBottomNav` on `AppLayout`). Back never dead-ends: with no earlier in-app page it goes to `/` (`src/lib/inAppHistory.ts`).
- **Toasts:** the only Sonner `<Toaster />` is in `src/routes/__root.tsx`. Don't add another, or every toast shows twice.
- **Edge function URLs:** use `getSupabaseFunctionsUrl()`.
- **CommuniCon one-tap confirm link:** `/communicon?confirm_code=&business=` is read and stripped from the URL in `Communicon.tsx`. `contact-otp` builds the link from `PI_APP_LINK_BASE`.

---

## Testing

- **Playwright e2e suite** in `tests/e2e/` (`playwright.config.ts`): ~214 tests, ~27 min, with mocked map and Supabase helpers in `tests/e2e/helpers/`. **Deno tests for edge functions** sit next to each function (e.g. `supabase/functions/contact-otp/index.test.ts`). During a PR, run only the specs the change touches; run the full suite before big merges.
- **When fixing a bug, add a regression test in `tests/e2e/` when feasible** — especially for anything touching auth, business limits, or messaging, since these are the areas with the worst history of silent regressions in this project. Don't just patch the bug and move on without a test that would have caught it.
- If adding a Playwright test isn't feasible for a given fix (e.g. it requires live Pi Browser auth that can't be simulated), say so explicitly rather than skipping the question entirely.

---

## Definition of Done

A task is not complete when the build merely compiles. Before calling anything finished:

1. **The build passes** — TypeScript compiles clean, no new ESLint warnings introduced.
2. **No new `any` types** — if you're tempted to reach for `any` to make a type error go away, stop and find the actual type, or ask me if the underlying type is genuinely unknown.
3. **Manually trace through the specific user flow affected** — don't just trust the compiler. Given this project's bug history (auth mismatches, RLS-silent-failures, wrong ID systems), a green build has repeatedly not meant a working feature. Walk through what happens for: a logged-out user, a logged-in customer, and a business owner, where relevant.
4. **Check RLS implications** (see RLS section above) for anything touching `businesses`, `conversations`, `messages`, or `users`.
5. **Regression test added** where feasible (see Testing section above).
6. **Report back what you actually verified**, not just what you changed — e.g. "I traced this through as a logged-in customer and confirmed the toast fires correctly" rather than just "build passes."

---

## Working Style / Preferences

- **Read the actual file before editing it.** Assumptions about code structure without reading have caused real bugs (e.g., the `sender_id`/`recipient_id` column mismatch that broke messaging for a full session before being caught).
- **One targeted fix per commit where possible** — avoid combining unrelated changes into a single sprawling commit unless explicitly asked to batch them.
- **Always verify the build passes** (TypeScript compilation, no console errors) before considering a task complete — but see "Definition of Done" above, since a passing build is the floor, not the finish line.
- **Never introduce gold/warm colors** anywhere, under any circumstance, even temporarily for "testing."
- **Never claim Avante Maps is first-to-market** or the only Pi business directory — Map of Pi already exists with an established following. Differentiate honestly: direct business messaging and business analytics dashboards are the genuine differentiators, not "we invented Pi business discovery."
- **Copyright/legal/about page content** should reflect the current year and accurate KYC/independence disclaimers.
- Prefer **secureLog** (from `@/utils/secureLogger` or equivalent) over raw `console.log`/`console.error`/`console.warn` in any auth, payment, or session-handling code — sensitive data should never leak to browser devtools.

---

## Keep The Codebase Lovable-Compatible

Lovable's own AI agent will continue to read, edit, and regenerate parts of this codebase after you're done. If Claude Code introduces patterns Lovable's agent doesn't recognize or handle well, Lovable can start making worse suggestions, produce broken diffs, or silently overwrite/mangle things it doesn't parse cleanly. To avoid that:

- **Match the existing file/folder conventions exactly.** Don't introduce a different folder structure, a different naming scheme (e.g. `kebab-case` files if the project uses `PascalCase`), or a different state-management pattern than what's already used elsewhere in the same directory. Look at 2–3 sibling files before creating a new one and mirror their shape.

- **Don't introduce new architectural patterns without discussing it with me first.** For example: if this codebase uses plain hooks + Context (it does — `AuthProvider`, `useChatState`, etc.), don't introduce Redux, Zustand, Jotai, or a different data-fetching library alongside TanStack Query "because it's better." Lovable's agent is tuned to this project's existing patterns — a second competing pattern makes future Lovable edits more likely to break something.

- **Avoid exotic TypeScript.** No decorators, no advanced conditional/mapped types, no non-standard tsconfig changes, unless there's no simpler way to solve the problem — Lovable's agent handles straightforward, idiomatic TypeScript far more reliably than clever type-level code.

- **Don't restructure or rename existing files/exports as a side effect of an unrelated fix.** Renaming a component, moving a file, or changing a default export to a named export (or vice versa) breaks every import across the app and makes it much harder for Lovable to track what changed. If a rename is genuinely warranted (like the `PlaceCardActions` naming collision fixed earlier), do it as its own isolated, clearly-labeled change — never bundled silently into a bug fix.

- **Don't add new npm dependencies casually.** Every new package is something Lovable's agent has to be aware exists when it touches related code later. If a fix seems to need a new dependency, tell me what it is and why before installing it — there's a decent chance the existing stack (see Tech Stack above) already covers it.

- **Keep comments and code style consistent with the surrounding file**, not with your own default style. If a file has minimal comments and short functions, don't suddenly add heavy JSDoc blocks and much longer functions in the same file — stylistic whiplash across a file makes it harder for both Lovable and me to review diffs at a glance.

- **After finishing, tell me plainly whether anything you did is "unusual" relative to the rest of the codebase** — new pattern, new dependency, restructured file, etc. — even if you think it's an improvement. I'll decide whether to keep it or ask you to conform to the existing style, but I need to know it happened.

---

*End of durable project context. The specific task for this session will be described separately in the conversation — this file is not the place for it.*
