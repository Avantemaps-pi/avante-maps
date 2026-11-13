# Pi ecosystem listing readiness audit

Audited on 13 Nov 2026, against `Dev` at `fb157a7f`. This is a report only: no code was changed.

**Method**
- I read the code for each of the 8 listing requirements.
- I ran the app locally (`npx vite dev`, Playwright at 390×844) on every main route, signed in and signed out. Supabase was mocked and nothing was read from production.
- I captured console errors, broken images, any `$`/`USD` text and outside hosts for each page. The screenshots are local and are not in this PR. The screens are named in each finding.

**Ratings**
- **Blocker:** likely rejection, or a security issue that should be fixed regardless of the listing.
- **Risk:** could be questioned by a reviewer.
- **OK:** checked and fine.

## 1. Summary

| # | Requirement | Blockers | Risks | OK |
|---|---|---|---|---|
| 1 | Pi authentication only | 1 (password path in `verify-pi-auth`) | 1 | Sandbox login, dev bypass, contact OTP |
| 2 | Pi only, no fiat | 3 (Pricing cards, checkout sheet, Wallet) | 0 | Prices derived from USD on the server only |
| 3 | No funnelling to external sites | 0 | 4 | Business website/tel/mailto, OSM credit, Pi Browser download link |
| 4 | Fully working, clean UI | 1 (CSP blocks realtime) | 6 | No broken images on the main routes |
| 5 | Minimal data collection | 0 | 4 | Home location, wallet address, synthetic email |
| 6 | Branding | 2 (Pi logo on landing and sign-in) | 4 | Colour tokens, domains |
| 7 | Privacy policy and terms | 1 (policy inaccurate, names Pi Network as a partner) | 2 | Links reachable in the app |
| 8 | Content | 1 (`og-image.png` is Lovable's homepage) | 2 | No stock or film images in the repo |

## 2. Findings

### 1. Pi authentication only

**1.1 Blocker (security): every account also has a guessable email/password login.**
- **Where:** `supabase/functions/verify-pi-auth/index.ts:142-145`, `:175-176`, `:357`.
- **Why:**
  - Each Pi user gets a Supabase user with the email `<pi_uid>@pi.local`.
  - The password is `pi_<pi_uid>_<first 32 chars of SUPABASE_SERVICE_ROLE_KEY>`, and the session is created with `signInWithPassword`.
  - With the legacy JWT service key (used until 21 Oct 2026), those first 32 characters are `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpX`. That is the standard JWT header, the same for every Supabase project, so it's public.
  - The password is only reset when a sign-in fails. So any user who hasn't signed in since the key change still has a password that anyone can compute from their Pi uid. Anyone holding the publishable key can then sign in as that user through the Supabase password grant.
  - If the service key were ever missing, the salt falls back to the literal `'default-salt'`.
  - That is a working non-Pi sign-in path, and an account-takeover risk.
- **Fix:**
  - Stop deriving the password: set a fresh random password on every `verify-pi-auth` call (admin `updateUserById`), then sign in with it. Or mint the session another way, without a stable password.
  - Then rotate every existing user's password once with a one-off admin script.
  - Check in the Supabase dashboard that **Auth → Allow new users to sign up** is off. I couldn't check this from the repo. With sign-ups on, anyone can create an email account with the publishable key.

**1.2 OK: sandbox login.**
- **Where:** `src/components/auth/LoginDialog.tsx:197-207`, `:525-553`; `src/context/auth/AuthProvider.tsx:11-20`, `:543-548`.
- **Why:** it only appears on `localhost`, `127.0.0.1` and Lovable preview hosts, and `loginAsSandbox()` refuses anywhere else. It is local only and creates no Supabase session. It doesn't show on `testnet.` or `mainnet.avantemaps.com`.

**1.3 OK: dev auth bypass.**
- **Where:** `src/config/environment.ts:51-125`.
- **Why:** `DEV_CONFIG` is `undefined` in production builds, and `shouldBypassAuth()` is true only on Lovable preview hosts.

**1.4 OK: business contact verification OTP is not a login.**
- **Where:** `supabase/functions/contact-otp/index.ts:113-119`, `:258-274`.
- **Why:** it needs an already signed-in caller (`getUser`). It only writes `contact_otps` and `businesses.contact_email_verified_*`, and never creates or returns a session.

**1.5 Risk: Supabase email/password auth is enabled for the project.**
- **Why:** it's needed by 1.1. No client UI uses it: there's no `signInWithOtp`, `signUp`, magic-link or password-reset code in `src/`.
- **Fix:** once 1.1 no longer relies on stable passwords, keep the email provider only for the server-side session mint, with public sign-ups off.

### 2. Pi only, no fiat or other tokens

**2.1 Blocker: Pricing plan cards show "≈ $X USD", including "≈ $0 USD" on Individual.**
- **Where:** `src/components/ui/pricing-card.tsx:80` (≈ USD line), `:91` (yearly strikethrough "$60 USD"), `:99-101` (fallback "$5 / monthly" when the Pi price fails to load).
- **Seen:** on `/pricing`, signed in and signed out.
- **Fix:** remove the USD line and strikethrough. Show the saving in π, for example "Save 15%". When the price is unavailable, show "Price unavailable" instead of `$`.

**2.2 Blocker: the checkout sheet header shows "$5.00 a month · 82.79 π today".**
- **Where:** `src/components/pricing/PlanCheckoutSheet.tsx:136`.
- **Fix:** show "82.79 π a month" only.

**2.3 Blocker: Wallet shows "≈ $X.XX USD" under the balance on Mainnet.**
- **Where:** `src/components/wallet/BalanceCard.tsx:45-49` (shown only when `isMainnetPiHost`).
- **Why:** it's hidden on testnet, but the same build is listed on Mainnet.
- **Fix:** remove the USD equivalent, and its "USD value unavailable" fallback.

**2.4 OK: prices are derived from USD internally.**
- **Where:** `src/utils/piPayment/pricing.ts:6-28`, `supabase/functions/_shared/prices.ts:4-26`, `supabase/functions/update-pi-price/index.ts:51` (OKX PI-USDT ticker).
- **Why:** this sets the π amount and isn't shown to users. Emails (`plan-reminders`, `notify-*`, `contact-otp`) contain no currency.

### 3. No funnelling to external sites

**3.1 Risk: About Us links to WhatsApp, X and Facebook.**
- **Where:** `src/pages/About.tsx:125`, `:130`, `:135`.
- **Why:** these are app-level links that take users out of the Pi Browser to social networks.
- **Fix:** remove them, or keep only the `mailto:` (`:140`).

**3.2 Risk: the Contact form "sends" by opening a `mailto:` link.**
- **Where:** `src/pages/Contact.tsx:54`.
- **Why:** it leaves the app. In the Pi Browser it may do nothing, which reads as a form that doesn't work (see point 4).
- **Fix:** send through an edge function. Brevo is already used for email.

**3.3 Risk: Share dialog and share bar.**
- **Where:** `src/components/business/ShareDialog.tsx:53-122` (WhatsApp, X, LinkedIn, Telegram, Gmail, Discord copy, TikTok, Snapchat); `src/components/business/ShareBar.tsx:32-66`.
- **Why:** user-initiated sharing, probably acceptable, but it's 9 outside services.
- **Fix:** keep "Copy link" and `navigator.share`, and drop the per-network buttons.

**3.4 Risk: the paid plan feature "Discord Special Access".**
- **Where:** `src/components/pricing/pricingTiers.ts:52`.
- **Why:** it sells access to an outside community as a perk.
- **Fix:** remove it, or describe an in-app benefit.

**3.5 OK: per-business contact links.**
- **Where:** `src/components/business/PlaceCardButtonRow.tsx:69`, `src/components/map/buttons/WebsiteButton.tsx:19`, `src/components/map/map-components/PlaceOverlay.tsx:231` (`tel:`), `:236` (`mailto:`).
- **Why:** each is a user-initiated contact link for one business. The registration placeholder suggests a `.pinet.com` site (`ContactFields.tsx:325`). There are no "Get directions" links to Google or Apple Maps.

**3.6 OK: other links.**
- OpenStreetMap credit (`mapConfig.ts:15`, `About.tsx:109`): required by the licence.
- `LoginDialog.tsx:35` `minepi.com/download`: shown only outside the Pi Browser.
- Emails link back to `avantemapsaebbcf9516.pinet.com` (`PI_APP_LINK_BASE`).

### 4. Fully working, clean UI

**4.1 Blocker (confirm on testnet): the CSP blocks Supabase realtime.**
- **Where:** `src/routes/__root.tsx:97`. `connect-src` has `https:` but no `wss:`. Browsers apply both this `<meta>` CSP and the `vercel.json:50` header, so this one wins.
- **Seen:** on every signed-in page: "Connecting to 'wss://xvpwbocwasbtzrzrxyvu.supabase.co/realtime/…' violates the following Content Security Policy directive".
- **Why:** live messages and notifications don't arrive without a refresh, and there's a console error on every page.
- **Fix:** add `wss://xvpwbocwasbtzrzrxyvu.supabase.co` to `connect-src`. To confirm first, check whether a CommuniCon message shows up on the other device without a refresh.

**4.2 Risk: unhandled error on Notifications.**
- **Where:** `src/pages/Notifications.tsx:48`.
- **Seen:** "cannot add `postgres_changes` callbacks for realtime:notifications-realtime after `subscribe()`". It may be caused only by StrictMode in dev, because the channel name is fixed.
- **Fix:** make the channel name unique per mount, or remove the channel before re-creating it.

**4.3 Risk: CommuniCon has a "Certification · Coming soon" row and a bot reply saying certification is coming soon.**
- **Where:** `src/components/chat/ChatInterface.tsx:155`, `src/hooks/useChatState.tsx:862-872`.
- **Why:** it's clearly labelled, but listing guidance mentions "coming soon" stubs.
- **Fix:** hide the row and reply until certification ships.

**4.4 Risk: `/diagnostics` is publicly reachable.**
- **Where:** `src/routes/diagnostics.tsx`.
- **Why:** it's a developer page (Pi SDK internals) that nothing links to.
- **Fix:** limit it to admins, as `NotificationAdmin.tsx:655-667` does, or remove the route.

**4.5 Risk: broken image fallback on the Review page.**
- **Where:** `src/pages/Review.tsx:312`.
- **Why:** it points at `'public/placeholder.svg'` (a relative path), so it 404s on `/review/...`.
- **Fix:** change it to `'/placeholder.svg'`.

**4.6 Risk: the Individual plan lists "Includes ads", but the app has no ads.**
- **Where:** `src/components/pricing/pricingTiers.ts:17`.
- **Fix:** remove the line, and remove "No Ads" from the paid plans (`:31`, `:49`).

**4.7 Risk: Lovable's editor script loads on every page in production.**
- **Where:** `src/routes/__root.tsx:202` (`cdn.gpteng.co/gptengineer.js`), allowed in the CSP at `:93`.
- **Why:** it's an outside script, extra network traffic, and possible console noise.
- **Fix:** load it only on Lovable preview hosts.

**4.8 Risk: small copy issues.**
- `src/pages/Contact.tsx:21` says "Register Business" in the navigation menu, but the menu item is "Registered Business".
- The landing footer hardcodes "© 2026 Avante Maps." (`src/pages/LandingPage.tsx:225`).
- **Fix:** match the menu label, and use `new Date().getFullYear()` with "Avante Maps Pty Ltd".

**Notes:**
- No broken images appeared on the main routes.
- An unknown route shows the NotFound page.
- Every page logged a generic "Failed to load resource: net::ERR_FAILED". I believe these come from the test mocks and the blocked socket, but that wasn't confirmed.
- I didn't walk the multi-step forms (Register, Edit listing, Top up) step by step in this audit. Their e2e suites cover them.

### 5. Minimal data collection

Personal data stored, from `src/integrations/supabase/types.ts`:

| Data | Where | Why needed | Optional? | In policy? |
|---|---|---|---|---|
| Pi username, Pi uid, wallet address | `users.username`, `users.pi_uid`, `users.pi_wallet_address` | Sign-in, payouts | No (comes from Pi) | Username only |
| Email | `users.email` | Synthetic `<uid>@pi.local`, not a real address | n/a | Not needed |
| Home location | `users.home_lat`, `home_lng`, `home_set_at` | Map home | Yes, set by the user | Only as "precise location" |
| Business contact details | `businesses.contact_info` (phone, email, website, first/last name), address, coordinates, images, hours | Public listing | Phone and email **required** (`formSchema.ts:64-65`); names optional | Partly |
| New-message email opt-in | `businesses.notify_new_message_email`, `contact_email_verified_*` | Email alerts | Yes | No |
| Messages, comments, reviews | `messages`, `comments`, `reviews`, `conversations` | Core features | Yes | No |
| AI chat text | Sent to `ai.gateway.lovable.dev` (`supabase/functions/chat-ai/index.ts:226`) | CommuniCon AI | Yes | **No** |
| Search terms | `user_searches` (`src/hooks/useSearchTracking.ts:16`) | Business analytics | No | As "search queries" |
| Business views | `business_views` (user_id, user_agent, referrer) | Analytics | No | As "usage" |
| Logs | `error_logs`, `reauth_telemetry` (user_agent, URL) | Debugging | No | As "device" |
| IP address, to third parties | `ipwho.is` (`useCountryGeolocation.ts:28`, `useIpLocationFocus.ts:44`), `ipapi.co` and `get.geojs.io` (`LocateMeButton.tsx:89`, `:101`) | Approximate map position | No | **No** |

**5.1 Risk: business phone and email are both required.**
- **Fix:** keep email required (contact verification and alerts need it) and make phone optional. Or require at least one contact method.

**5.2 Risk: IP addresses are sent to three outside geolocation services.**
- **Fix:** use one provider, or none (fall back to the world view), and name it in the policy.

**5.3 Risk: AI chat content goes to Lovable's AI gateway, and the policy doesn't say so.**
- **Fix:** name the provider in the policy and in the chat's intro text.

**5.4 Risk: the policy claims "Name, email, phone" from users.**
- **Why:** users only give a Pi username; names, emails and phones belong to businesses.
- **Fix:** rewrite it as part of 7.1.

**5.5 OK: nothing is collected and left unused.**
- `user_searches` feeds business analytics (`supabase/migrations/20260102165613_…sql:49`).
- `business_views` feeds the view counts (`20251225170136_…sql`).

### 6. Branding

**6.1 Blocker: Pi Network's logo on the signed-out landing page.**
- **Where:** `src/pages/LandingPage.tsx:8`, `:157-163` (`src/assets/pi-network-logo.png`, Pi's gold π mark) above "Made For Pi. Not Made By Pi."
- **Why:** it's the first screen a reviewer sees.
- **Fix:** remove the image, or swap in `AvanteMark`. Delete the asset.

**6.2 Blocker: Pi Network's logo in the sign-in dialog.**
- **Where:** `src/components/auth/LoginDialog.tsx:461`, in the "Pi Network User" row.
- **Asset:** `public/lovable-uploads/816179f9-d16d-46a7-9d6e-169846c0d0da.svg`, a PNG embedded in an SVG. The `.png` of the same name is Pi's purple-and-gold logo.
- **Fix:** use a neutral `UserRound` icon, and delete both files.

**6.3 Risk: "powered by Pi Network" wording.**
- **Where:** `src/pages/Index.tsx:491` (structured data), `src/pages/Pricing.tsx:159` (OG description).
- **Fix:** "for Pi Network users" or "accepts Pi".

**6.4 Risk: landing footer "Built on the Pi Network."**
- **Where:** `src/pages/LandingPage.tsx:225`.
- **Fix:** "An independent app for Pi users."

**6.5 Risk: the landing map illustration uses purple pins.**
- **Where:** `src/assets/map-preview.jpg`, used in `LandingPage.tsx:7`.
- **Why:** close to Pi purple, and off the blue/white brand.
- **Fix:** recolour it to blue, or replace it with a real screenshot.

**6.6 Risk: unused gold icon.**
- **Where:** `src/assets/avante-maps-intro-preview.png` (gold pin on black).
- **Why:** not imported anywhere, but it's gold and could be uploaded to the portal by mistake.
- **Fix:** delete it.

**6.7 OK: colours, wording and domains.**
- No purple or gold colour tokens or classes in `src/` or CSS.
- The Contact FAQ (`Contact.tsx:24-25`) and the landing copy (`LandingPage.tsx:165-168`) state independence, which is good. The FAQ answer could start with a plain "No."
- Domains `testnet.avantemaps.com`, `mainnet.avantemaps.com` and `avantemapsaebbcf9516.pinet.com` don't start with "pi".

### 7. Privacy policy and terms

**7.1 Blocker: the Privacy Policy is generic and inaccurate.**
- **Where:** `src/pages/PrivacyPolicy.tsx`.
- **Why:**
  - It's dated 13 April 2025.
  - It lists **"Business Partners: Pi Network and other partners"** (`:53`), which implies a partnership and data sharing with Pi.
  - It claims names and phones from users.
  - It omits: messages, AI chat (Lovable AI gateway), Brevo email, the IP geolocation services, home location, contact-email verification, business analytics, and account deletion.
  - It points to `privacy@avantemaps.com` (`:77`), which isn't one of the known mailboxes.
- **Fix:** rewrite it from the table in point 5. Name the processors (Supabase, Vercel, Brevo, Lovable AI, the geolocation provider, OpenStreetMap). Remove the Pi Network partner line, set the current date, and use `support@avantemaps.com`.

**7.2 Risk: the Cookie Policy describes advertising and third-party tracking cookies the app doesn't use.**
- **Where:** `src/pages/CookiePolicy.tsx:30-115`.
- **Fix:** say only local storage for sign-in and preferences is used.

**7.3 Risk: the Contact page lists `partnerships@avantemaps.com`.**
- **Where:** `src/pages/Contact.tsx:143`.
- **Why:** it's not a known mailbox.
- **Fix:** confirm it exists or remove it.

**7.4 OK: the legal pages are reachable in the app.**
- Privacy, Terms and Contact are in the side menu footer and in Settings → Legal and help (Cookies too). The sign-in dialog links Privacy and Terms (`LoginDialog.tsx:559-561`).

### 8. Content

**8.1 Blocker: `public/og-image.png` is a screenshot of Lovable's homepage, with Lovable's logo and slogan.**
- **Where:** used as the `og:image` / `twitter:image` for every page (`src/routes/__root.tsx:157-174`; `Index.tsx:472-484`; `Pricing.tsx:161`; `Registration.tsx:103`; `Recommendations.tsx:146`).
- **Why:** every shared link and preview shows another brand.
- **Fix:** replace it with a 1200×630 Avante Maps image (blue/white mark and wordmark).

**8.2 Risk: demo business "Pi Network Cafe" in a migration.**
- **Where:** `supabase/migrations/20251105090348_ddd8aa0f-…sql`.
- **Why:** marked verified and certified, with the fake owner `00000000-…-000000000001` and fake contacts (`+1-555-0123`, `pinetworkcafe.com`). Its column names (`name`, `description`, `postal_code`) don't match today's schema, so it may never have been inserted.
- **Fix:** the owner checks for it on testnet (see below), deletes it if present, and removes the migration from future setups.

**8.3 Risk: another app's validation file is publicly served.**
- **Where:** `public/barterfi-app-validation.txt`.
- **Why:** it looks like another Pi app's domain key served from avantemaps.com, which would confuse a reviewer.
- **Fix:** delete it if it's no longer needed. `public/favicons.ico` is an unused duplicate of `favicon.ico`.

**8.4 OK: no copyrighted images in the repo.**
- `public/` and `src/assets/` hold only the app's own marks plus the items above.
- Test fixtures use no image files. `tests/e2e/helpers/mapMocks.ts` uses `/placeholder.svg`.

**How the owner can check live business photos (not queried in this audit):**
- Photos are URLs in `businesses.images` (`text[]`), stored in the Storage bucket **`business-images`** (`src/hooks/useImageUpload.ts:32`).
- In the dashboard, open Storage → `business-images` and browse the thumbnails. Or run `select id, business_name, images from businesses where is_active` and open each URL.
- Look for film or game stills, other brands' logos, stock-photo watermarks, and placeholder names ("test", "Pi Network …").

### Listing assets

- **Icons:**
  - `public/apple-touch-icon.png`: 180×180, white compass on navy. On brand, with no Pi mark.
  - `public/lovable-uploads/Avante maps icon.png`: 400×400, 9 KB, black compass on white.
  - `public/lovable-uploads/Avante-Maps-icon.svg`: vector compass mark.
  - `src/assets/brand/avante-mark.svg`, `avante-badge.svg`.
  - None include a Pi mark, apart from the Pi logos in 6.1 and 6.2, which aren't app icons.
  - **Intro image (≥400×400, ≤1 MB):** `Avante maps icon.png` meets the size, but a blue/white version from the SVG at 1024×1024 would match the brand better.
- **Previews (3–5 images, ≥750×1500, ≤1 MB each, PNG/JPG):** none in the repo.
  - Take them in the Pi Browser on testnet after the blockers are fixed: map with pins, business page, CommuniCon chat, analytics, Pricing (π only).
  - A 390×844 viewport at 2× device scale gives 780×1688, which meets the minimum.
- **Don't use:** `og-image.png` (8.1), `avante-maps-intro-preview.png` (gold, 6.6), or `map-preview.jpg` (purple, 6.5).

## 3. Fix order

1. **1.1** Replace the derived password in `verify-pi-auth`, rotate existing passwords, and confirm public sign-ups are off. This is the security fix and comes first.
2. **6.1, 6.2** Remove Pi's logo from the landing page and the sign-in dialog, and delete the assets.
3. **2.1–2.3** Remove every USD display: plan cards, the `$` fallback, the checkout sheet header, the Wallet ≈USD.
4. **8.1** Replace `og-image.png`.
5. **7.1** Rewrite the Privacy Policy, removing "Pi Network partner"; with it, **7.2** Cookie Policy and **5.2–5.4**.
6. **4.1** Add `wss://` to the CSP `connect-src`, after confirming live messages fail on testnet.
7. Risks, cheapest first:
   - 6.3, 6.4 wording
   - 4.5 Review fallback
   - 4.6 "Includes ads"
   - 3.4 Discord perk
   - 4.3 Coming soon
   - 8.3 barterfi file
   - 6.5, 6.6 images
   - 4.4 `/diagnostics`
   - 4.7 `gptengineer.js`
   - 4.2 Notifications channel
   - 3.1 About socials
   - 3.2 Contact form via edge function
   - 3.3 trim share buttons
   - 5.1 phone optional
   - 7.3 mailbox
   - 4.8 copy
8. Owner checks:
   - 8.2 "Pi Network Cafe" and live photos in `business-images`.
   - The sign-up setting in Supabase Auth.
   - Then take the portal previews.
