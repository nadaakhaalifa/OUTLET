# Delayed account creation at checkout (browse and fill a cart before registering) vs the Z-OUTLET spec

Scope note: Repo findings come from a read-only look (file paths given). Web figures come from search snippets and the pages named; items I could not confirm are in Gaps. No code was changed.

## 1. Which spec/ADR rules conflict with "browse and carry a cart before registering"?

### Takeaway
Only a small set of rules truly conflict. The hard ones are: "Guest bag is not supported" (spec §6), the server-side per-user bag with buyer-audience tokens (docs/specs/cart.md), and "accounts require age >= 18 by DOB" at the first sign-in (§1/B6). Everything else (phone verified before first order, one account per phone, consents, OTP limits) can be satisfied if they are enforced at checkout/registration time instead of app launch.

### Cited Findings
- Spec §6: "Guest bag is not supported: an account is required (18+ gate)"; bag "syncs across devices (server-side)". — `/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md` §6
- Spec §1: accounts require age >= 18 by DOB; an under-18 DOB triggers a 30-day device soft-block; "one account per phone number"; phone verified before the first order, wallet use, referral or COD; consents never pre-ticked; OTP 6 digits, 5 min, max 5 attempts, 3 sends/15 min/phone, 10/day/device; App Attest required on OTP; EG-only country-code allow-list. — same file §1, B6, T2
- Spec §7: reservation is placed only when checkout starts; client totals never trusted; App Attest required on `POST /v1/checkout`. — same file §5, §7
- Spec B1: SDKs (PostHog, Sentry, ads) initialise only after matching consent; consent granular, explicit, not pre-ticked. — same file §B1
- Repo cart spec: "One bag per user. No guest bag: every route needs a buyer-audience token (18+ gate is enforced at sign-up)." — `/Users/nadakhalifa/OUTLET/docs/specs/cart.md`
- Repo catalog spec D-4: `getProduct` is `shopperBearer` in OpenAPI; "If the PDP must be reachable by guests (not in Phase 1: guest bag is unsupported) change both." — `/Users/nadakhalifa/OUTLET/docs/specs/catalog.md` line 185
- Cart port is user-keyed: `getOrCreate(userId, newId, nowMs)`, `setUnavailableSince(userId, ...)`; controller `userOf(req)` throws `unauthenticated` when `req.principal` is absent. — `apps/api/src/modules/cart/domain/ports.ts`, `apps/api/src/modules/cart/adapters/cart.controller.ts`
- Checkout controller derives `userId` from `principalOf(req).actor.id` on every route (only the webhook is `@Public()`). — `apps/api/src/modules/checkout/adapters/checkout.controller.ts`
- Age gate is already decoupled from the account: `AgeGate.submit` takes `{dob, deviceIdHash, attestedDeviceKey}`, stores only HMAC identifiers and a pass valid 24 h (`AGE_GATE_PASS_TTL_MS`), keyed on attested device key + device id hash + keyed DOB; `ageBandOf` gives 18_20 vs 21_plus. A passed gate is consumed by `verifyOtp` when creating the user. — `apps/api/src/modules/auth/application/age-gate.ts`, `verify-otp.ts`
- Mobile onboarding funnel is `account (DOB + 18+ + terms + phone) -> otp -> consents -> done`; consents step is skippable; routes under `/onboarding/*`; tabs are Home, Discover, Saved, Bag, Profile (ADR-0044). — `apps/mobile/src/features/flow.ts`, `/Users/nadakhalifa/OUTLET/docs/adr/0044-bottom-tabs-discover-saved-profile.md`
- Mobile checkout address model already has `recipientName` and one `phone` (nullable in the address book type); no second-phone field was found. — `apps/mobile/src/features/checkout/model.ts` lines ~515-570, `features/addresses/model.ts`
- Wishlists (Saved tab) are also user-scoped server-side (`/v1/me/wishlists`, spec §8). — spec §8 (inference for Saved tab impact below)

### Conflict and edit table (inference from the above)
| # | Rule | Conflict? | Edit needed |
|---|---|---|---|
| 1 | §6 "Guest bag is not supported" + cart.md "No guest bag" + ADR-0010 context | Direct | New ADR (suggest ADR-0045 "Delayed registration and anonymous bag") superseding that sentence; edit spec §6 and cart.md "Rules"; amend `docs/data-model/cart.md` |
| 2 | §3/§5 browse needs shopper token; catalog D-4 `shopperBearer` on getProduct | Direct for browse | Same ADR; change OpenAPI security for catalog read ops to `anonymousOrBearer`; update catalog.md D-4 |
| 3 | §1 "Accounts require age >= 18"; "Create account, browse, wishlist, cart = 18" in B6 table | Partial: browse/cart before DOB breaks the table row | B6 table row split: "browse and local cart: no age data collected; DOB attestation required before checkout, wishlist-sync, any account". Owner/counsel decision (see Q-flags) |
| 4 | §1 onboarding order (DOB, language, consents, vibes...) before value | Product flow, not hard rule | Spec §1 flow rewrite; flow.ts steps; ADR-0044 unaffected |
| 5 | §1 "phone verified before first order" | No conflict (checkout-time) | None; just keep enforced server-side at `POST /v1/checkout` |
| 6 | §1 "one account per phone" | Needs care: two anonymous carts, same phone | Merge rule in ADR (claim by verified phone, no second account) |
| 7 | §1 App Attest required on OTP / checkout | Extends to anonymous session creation | Add "session creation" to attested routes (T2 list) |
| 8 | B1 SDK consent gating, consent never pre-ticked | Anonymous browsing may use strictly-necessary server events only | Clarify in B1/§26 that anonymous session uses pseudonymous, strictly-necessary processing; consent screen moves to checkout/registration |
| 9 | §12 / §8 / §13 per-user server features (wishlist, history, budget) | Anonymous users get device-local only | State "device-local until registration" in those specs |
| 10 | §7 `Idempotency-Key = order_group_id`, BOLA "OrderGroup readable only by owner" | No conflict if order is created only after phone verified | None |
| 11 | docs/specs/cart.md "buyer-audience token" | Direct | New audience `anon` (see Q4) or separate endpoint family |

### Inferences
- The least invasive way to respect the spec is to keep "no account without DOB + verified phone" intact and only delay it to the checkout boundary, while the pre-registration bag is a *separate, lower-trust object* (not a user cart).
- A true "guest checkout" (order with no account) would break rows 5, 6, 10 and the DSAR/deletion model (§2), so it needs more edits than option 1.

### Gaps
- I did not open docs/data-model/cart.md or openapi.yaml; exact security-scheme names should be confirmed by the builder.
- ADR numbering: 0042 is missing from the list and 0044 is highest; I suggest 0045 but did not check for in-flight drafts.

## 2. Options, trade-offs and evidence

### Takeaway
Evidence is strong that forced pre-purchase registration loses sales and that registering after value is delivered is preferred (Baymard, NN/g), and Apple does not allow requiring registration before non-account features. Recommended: option 1 (anonymous device-scoped session + cart) combined with option 2 (phone OTP at checkout creates the account implicitly), with option 3 (Apple/Google) as an optional equal alternative that carries the Sign in with Apple obligation. Pure guest checkout (option 4) is not recommended for this spec.

### Cited Findings
- Baymard's checkout page reports 19% of surveyed US adults abandoned an order in the past three months because they did not want to create an account, and recommends making guest checkout the most prominent option. Other sources cite 18%, 24% (a 2022 survey as cited by a secondary source) or 26%, so the figure varies by year. — [Baymard checkout UX](https://baymard.com/blog/checkout-flow-ux-optimization); [Baymard reduce cart abandonment](https://baymard.com/blog/reduce-cart-abandonment); secondary variation: [Henkan Partners](https://henkanpartners.ai/en/insights/product-page-checkout-optimisation/)
- NN/g: guest checkout with optional registration simplifies purchase, and forcing registration causes lost sales; it advises stating registration is optional and offering the password after the transaction (reciprocity). — [NN/g Optional registration](https://www.nngroup.com/articles/optional-registration/); [NN/g Login walls](https://www.nngroup.com/articles/login-walls/); [NN/g EAS framework](https://www.nngroup.com/articles/eas-framework-simplify-forms/)
- Apple 5.1.1(v) (older archived text): "If your app doesn't include significant account-based features, let people use it without a login." Developer-forum quote of the review board: requiring full registration before any use is not acceptable, though asking users to register for purchase tracking is; non-account features should be reachable before sign-in. These are secondary renditions, not Apple's current page. — [Apple forum thread](https://developer.apple.com/forums/thread/724336); [appfollow guide](https://appfollow.io/blog/app-store-review-guidelines)
- Account deletion: apps that support account creation must offer deletion in-app; when Sign in with Apple is used, revoke tokens via the REST API on deletion. — [ptkd 5.1.1(v)](https://ptkd.com/journal/rejection-5-1-1-v-account-deletion-for-ai-social-login); [appfollow](https://appfollow.io/blog/app-store-review-guidelines)
- Guideline 4.8: an app that uses a third-party login for the primary account must also offer an equivalent privacy-preserving option (Sign in with Apple meets it); exceptions exist. Spec B7 already says "Sign in with Apple whenever Google sign-in is offered". — [Apple forum 4.8](https://developer.apple.com/forums/thread/765145); spec §B7
- OWASP guidance: use a different session identifier pre- and post-authentication and bind them; ASVS 5.0 V7.2.3 requires reference tokens from a CSPRNG with >= 128 bits of entropy. — [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html); [ASVS 5.0 V7](https://asvs.dev/v5.0.0/V7-Session-Management/); [Cornucopia ASVS 5.0 V7.2](https://cornucopia.owasp.org/taxonomy/asvs-5.0/07-session-management/02-fundamental-session-management-security)
- PDPL Article 1: personal data includes data that identifies a person directly or indirectly by linking with other data; examples include name, voice, image, ID number and "online identifier". Device-ID coverage is by the general test, not named; one vendor says cookies/trackers count when they can be linked to an individual (commentary, not statute). — [DLA Piper Egypt](https://www.dlapiperdataprotection.com/?t=law&c=EG); [Legal500 translation](https://www.legal500.com/intelligence/egypt/privacy/egypts-personal-data-protection-law-(pdpl)-english-translation); [CookieHub](https://www.cookiehub.com/pdpl-egypt)
- Repo: the existing OTP/age-gate stack already has attested-device keys, HMAC-keyed identifiers and 24 h pass TTL (reusable for anonymous sessions); the existing waiting-room module uses a signed token with join-by-device and handles unauthenticated-ish admission (`apps/api/src/modules/waiting-room/application/join.ts`), a precedent for token design.

### Option comparison (trade-offs are inference unless cited above)
| Option | Fit to spec | Conversion | Security/abuse | Verdict |
|---|---|---|---|---|
| 1. Anonymous device session + anonymous (server or local) cart, merge on registration | Needs ADR (rule 1,2,3,7,8). Keeps orders account-bound (spec §7, §2) | Matches NN/g, Baymard, Apple | Needs attestation, rate limits, pre/post-auth token separation | Recommended as the substrate |
| 2. Phone-OTP at checkout, account created implicitly | Matches §1 (phone verified before first order, one account per phone) with DOB+consents inline | One short step; EG users used to OTP | SMS pumping controls from §1 apply | Recommended as the checkout gate |
| 3. Apple/Google at checkout | Needs phone still verified before first order (§1), so it adds a step after; Sign in with Apple required if Google offered | Fast for iOS | Provider tokens verified already in `social-login.ts` | Offer as alternative on the same screen; still collect verified phone |
| 4. True guest checkout | Breaks one-account-per-phone, DSAR/deletion, ledger/BOLA model, referral, returns | Highest short-term | Highest abuse (COD, vouchers) | Not recommended |

### Inferences
- Baymard/NN/g evidence is largely about web checkout with email/password; for passwordless phone-OTP the "account creation" friction is smaller, so the uplift of the anonymous-first flow is probably lower than the headline 19%. The Baymard number should be used as directional, not as a forecast.
- Apple's wording permits requiring an account at checkout because purchases are account-based; it forbids gating browsing. Anonymous browse + checkout registration is consistent with 5.1.1(v) as quoted (VERIFY at submission, as spec B7 already requires).

### Gaps
- Apple's current official guideline text could not be fetched; only secondary quotes. Add to verify-register.
- The Baymard report itself (exact sample, wording, year) was not opened; only the blog page and secondary summaries.
- No Egypt-specific data on forced-registration abandonment found.
- ASVS 5.0 requirement numbers for pre/post-auth token separation were not confirmed beyond V7.2.3.

## 3. Anonymous session security, merge, revalidation, abuse, PDPL

### Takeaway
Treat the anonymous session as an attested, low-privilege, short-lived device token that can hold a bag and nothing else; never reuse it as the authenticated session, rotate to a fresh token at registration, merge the bag idempotently, and revalidate price/stock at merge and at checkout start.

### Cited Findings
- Spec: reservation only at checkout start (§5/§7), price-lock 10 min, client totals untrusted; max 50 lines / 10 units per SKU (§6); API6 sensitive-flow rate limiting, App Attest/Play Integrity on checkout (§7, T2). — spec file
- OWASP: new token at authentication, anonymous and authenticated tokens distinct, CSPRNG >= 128 bits. — [OWASP cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html); [ASVS V7.2.3](https://cornucopia.owasp.org/taxonomy/asvs-5.0/07-session-management/02-fundamental-session-management-security)
- Existing code stores only HMAC identifiers for age-gate keys (`ageBlockKey(secret, "attested_device", ...)`), a pattern to reuse for anonymous-session device linkage. — `apps/api/src/modules/auth/application/age-gate.ts`
- PDPL: indirect identifiability test and "online identifier" example. — [DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=EG)

### Inferences (design)
- Cart token: opaque 256-bit CSPRNG, stored hashed, bound to the attested device key hash, 30-day sliding / 90-day absolute expiry, audience `anon`, scopes limited to `catalog:read`, `bag:*`; cannot call checkout, wallet, wishlist-sync, vouchers, referrals.
- Server bag vs device-local bag: server-side anonymous bag keeps the spec's "price_at_add, threshold_at_add, server revalidation" semantics and cross-surface consistency but creates a PDPL-relevant record keyed to a device; local-only bag is simplest for PDPL but cannot compute free-delivery suggestions server-side without sending SKUs anyway. Recommend a **server anonymous bag with a hard cap (e.g. 20 lines) and short TTL**, treated as pseudonymous, strictly-necessary data (counsel to confirm).
- Merge rules at registration: (1) merge key is the anon session id + idempotency key; (2) if the account already has a bag, union by SKU with qty = min(sum, 10), keep newer `price_at_add` reset to live (cart.md re-add rule); (3) cap 50 lines, overflow goes to `saved_for_later`; (4) mark source `merged_anon`; (5) delete the anon bag in the same transaction (outbox event `cart.merged`); (6) repeating the merge with the same key returns the same result; a different anon session for the same account merges as a second operation (commutative/associative: property-test it).
- Revalidation: lines carry no authoritative price; `GET cart` and `QuoteBagForCheckout` recompute from catalog; merge reports `unavailable`/`price_change` per line; no reservation is made before `POST /v1/checkout`.
- Abuse: scraping (anonymous browse rate limits per attested device + per IP, page-size caps already in §4 API4); coupon abuse (vouchers/Plus/referral unavailable to anon; vouchers require verified phone); inventory hoarding (no reservation for anon, so no hold abuse); bag-spam (line cap, rate limit); SMS pumping (OTP only at checkout step, same §1 limits, EG allow-list); anon-session farming (attestation required to mint; per-device-key cap on active anon sessions, e.g. 3); age-block evasion (age gate block keys already combine device keys).
- PDPL: an anonymous device identifier plus bag is likely personal data under the indirect-identifiability test, so treat it as personal (P1/P2) with a retention purge job and RoPA row; strictly-necessary processing for the requested service avoids needing consent, but this is a legal judgment, not verified.

### Gaps
- No authoritative source on PDPL treatment of a device identifier or on whether "strictly necessary" exemptions exist in Decision 816/2025; this is a counsel VERIFY row.
- No empirical source on SMS-pumping rates for checkout-time OTP.

## 4. Checkout identity form

### Takeaway
Ask once, at the start of checkout: name, phone 1 (verified by OTP), DOB + 18+ attestation, then address with optional phone 2; consents (including nothing pre-ticked) on a following skippable screen. Persist to the profile and prefill afterwards.

### Cited Findings
- Spec §1 OTP rules and SMS pumping defences (EG allow-list, per-prefix caps, anomaly alerts, App Attest). — spec §1
- Spec §B1 purposes list and "withdrawal one tap"; P3 field encryption for phone/DOB/addresses; Seller DPA: phone masked via relay where courier supports it, sellers lose access 30 days after delivery/return closure. — spec §B1, T5
- Existing mobile flow collects DOB + 18+ + terms + phone on one screen then OTP, then consents (skippable). — `apps/mobile/src/features/flow.ts`
- Address records already have recipientName and phone; address quality (landmark + map pin) required for COD (§20.7). — checkout/model.ts; spec §7, §20.7

### Inferences (design)
- Fields: Full name (Arabic or Latin, 2-80 chars, required, becomes `recipientName` default); Phone 1 (E.164, EG +20 at launch, required, OTP-verified, becomes the account login identifier, P3 encrypted + blind index); Phone 2 (optional, E.164, **delivery-contact purpose only**, not verified, not an account identifier, never used for OTP/marketing/dedup/fraud graph (state this in the on-screen text), shown to the courier only, never to sellers unless relay exists, deleted with the address or 30 days after delivery/return closure).
- Phone 2 consent: it is third-party-possible data (a relative's number). Show inline notice in Arabic first, e.g. "رقم إضافي للتواصل مع مندوب التوصيل فقط. لن نستخدمه في التسويق." plus an "I confirm this person agrees to be contacted" is probably over-engineering; recommend a purpose-limited notice, not a pre-ticked consent. Counsel to confirm if a separate consent purpose (e.g. `delivery_secondary_contact`) is needed. Add the column to `data_inventory.yaml` with purpose, retention and processor (courier).
- Age gate placement: DOB + attestation is the first control on the identity screen before OTP is sent (existing order in age-gate.ts: "age gate runs before any phone number is used").
- Consent placement: after OTP success, a single consents screen (nothing pre-ticked, skippable) before payment; analytics/marketing consents are not needed to place an order. Terms acceptance is the only required checkbox (contract formation).
- Ask once, prefill: name, phone 1, address(es), language; DOB never re-asked; phone 2 stored with the address.
- Arabic-first copy, RTL, Eastern/Western numeral input normalisation (spec §4 acceptance mentions Eastern Arabic numerals), 44-pt targets, inline validation.

### Gaps
- Courier-side support for relay numbers and for a second contact number (Bosta API) is unverified (VERIFY row 11 territory).
- No decision found on whether phone 2 needs its own consent purpose under PDPL; counsel.

## 5. Pre-registration "choose your country / shop-for" screen

### Takeaway
Store it device-local only (MMKV non-sensitive), send it to the server only as a non-identifying request parameter while anonymous, and persist it to the account at registration under the `personalization` purpose only if the shopper consented; otherwise discard.

### Cited Findings
- Spec §3: world selection (Local/Global/All/My Stores) "remembered per device and account"; My Stores is `user_favorite_stores` server-side. — spec §3
- Spec T2: MMKV for non-sensitive local state; B1: SDKs only after consent; `personalization` is a consent purpose; §13 personalization toggle off means non-personalized ranking. — spec T2, B1, §13
- Spec §1: sizes/vibes/brands are skippable steps after DOB. — spec §1

### Inferences
- Country: needed to pick the catalog/courier coverage; at launch Egypt only (§6 "Currency EGP at launch"); it is a request parameter, not a stored profile.
- "Shop for" (e.g. women/men/kids) is a coarse preference: keep on device, send as a query filter; do not log against the anonymous session id for ranking (avoids profiling without consent).
- On registration: migrate the choice to `users.locale`/default world only if the shopper does not decline; treat as part of onboarding preferences, not a consent record. Sizes/vibes/budget remain optional post-order steps, `measurements` and `budget_insights` consents only at their features.
- Nothing from the pre-registration screen may feed the budget tables or promotions (§12 lint).

### Gaps
- Product intent of "shop-for" categories (adult sizes only given 18+ rule vs kids profiles in §10) is not defined in the spec; a product decision.

## 6. Recommended flow, state machine, API, data model, security, metrics, tests, phases

### Takeaway
Recommended: **Anonymous-first browse and bag, phone-OTP registration at checkout** (options 1+2), Apple/Google as parallel choices, no guest orders. Requires one new ADR and small spec edits; order creation remains strictly account-bound.

### Cited Findings (supporting, all above)
- Baymard/NN/g: avoid forced early registration. — [Baymard](https://baymard.com/blog/checkout-flow-ux-optimization), [NN/g](https://www.nngroup.com/articles/optional-registration/)
- Apple 5.1.1(v)/4.8/deletion. — [Apple forum](https://developer.apple.com/forums/thread/724336), [4.8](https://developer.apple.com/forums/thread/765145)
- OWASP session separation. — [Cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

### Inferences (the design; everything below is a proposal)

**Screens**
1. First launch: language (device default) + country/shop-for (device-local) -> Home. No login wall; no DOB yet. (Mint anon session in background after App Attest.)
2. Browse, search, PDP, Saved (device-local until registered), add to Bag (anon server bag).
3. Bag -> "Continue to checkout". Shown: totals, free-delivery progress, estimated delivery.
4. Checkout step A "Who is ordering": DOB + "I am 18 or older" (age gate), name, phone 1, terms; offer Apple/Google as alternatives. Age gate first, then OTP request.
5. Step B OTP verify (6 digits, resend timer); account created, anon session exchanged for authenticated session, bag merged.
6. Step C address (map pin, structured Egyptian address) + optional phone 2 with purpose notice.
7. Step D consents screen (nothing pre-ticked, skippable) -- may also appear after order success to keep checkout short (recommended to test).
8. Step E delivery option, payment, review, place order (`POST /v1/checkout`, attested, idempotent).
9. Success: offer passkey, optional preferences (sizes, vibes, budget).
- Under-18 DOB: polite block, existing 30-day device block applies; the anonymous bag remains browsable but checkout is blocked.
- Moving to 21+ gated features (Plus, BNPL) still handled by `age_band` as today.

**State machine** (explicit table in domain, per A2.6)
`ANON_BROWSING -> ANON_BAG_ACTIVE -> AGE_CLEARED(pass, 24h) -> PHONE_CHALLENGED -> REGISTERED_VERIFIED -> (ORDERING)`; side exits: `AGE_BLOCKED` (30d), `ANON_EXPIRED` (purge), `MERGE_FAILED(retryable)`. Invalid transitions throw a typed error; property test that no state outside the table is reachable and that REGISTERED requires a verified phone and an age band.

**API sketch** (all under /v1; mutating = Idempotency-Key UUIDv7)
- `POST /v1/anon/sessions` (attested; body: installId, platform, language; returns opaque `anon_token`, expiry; rate limit per device key and IP)
- `GET /v1/products...` (accepts anon or buyer token)
- `GET/POST/PATCH/DELETE /v1/cart...` (audience `anon` or `buyer`; same routes, token decides owner; line cap lower for anon)
- `POST /v1/auth/age-gate` (existing) then `POST /v1/auth/otp/request` and `/verify` (existing); `verify` accepts optional `anon_session_id` and returns buyer tokens
- `POST /v1/cart/merge` (buyer token + `anon_token` in body; Idempotency-Key; returns merged bag and per-line changes; idempotent per (anon_session, user))
- `PUT /v1/me/profile/contact` (name, phone2 with `purpose=delivery_contact`)
- `POST /v1/checkout` unchanged, requires buyer audience, phone verified, age band present.
- Errors: Problem+JSON; anon token on buyer-only route returns 401 with `upgrade_required`; accessing another session's bag returns 404.

**Data model changes**
- New `anonymous_sessions(id, token_hash, attested_device_key_hash, install_id_hash, created_at, last_seen_at, expires_at, merged_into_user_id null, merged_at null, status)`; partial index on active; purge job with metric.
- `carts`: add `anonymous_session_id` nullable, `user_id` nullable, CHECK exactly one non-null (preferred to making `user_id` merely nullable); unique partial indexes on each.
- `cart_lines.source` add `merged_anon`.
- `users`/profile: `secondary_phone` (P3 encrypted, no blind index, purpose tag `delivery_contact`), or on the address row (preferred: lifecycle follows the address).
- `data_inventory.yaml` rows for all of the above; RoPA entry "anonymous browsing session".
- RLS/policy: separate `anon` actor kind in `packages/policy`; deny by default on every non-allowlisted route.

**Security and abuse controls**
- Mint anon sessions only with valid App Attest/Play Integrity; cap active anon sessions per device key; rate limits per session on bag writes and catalog reads; no vouchers/Plus/referrals/wallet/wishlists-server/BNPL on anon.
- Rotate to a new buyer session on registration; invalidate the anon token on merge (replay of the token after merge returns the merged result idempotently only with the same user).
- Cart token is not a bearer of price: prices recomputed server-side; no reservation before checkout.
- Do not log phone or DOB on the anon session; HMAC identifiers only.
- OTP and SMS pumping controls exactly per spec §1; WhatsApp OTP fallback.
- Add the new threats to the auth and cart STRIDE models.

**Metrics**
- Bag-to-checkout rate, checkout-identity completion, OTP success p95 and cost per verified user (spec §1), anon-to-registered conversion, merge conflict rate, % anonymous bags expired, age-block rate at checkout, SMS-pumping anomaly alerts, guardrails: COD refusal and return rate for delayed-registration users vs old flow (A/B).

**Test plan**
- State-machine tests: every transition; property test unreachable states.
- Negative authorization: anon token -> checkout/wallet/orders = 401/403; anon token A -> anon bag B = 404; buyer user A -> anon bag of someone else = 404; merge with someone else's anon token = 404; expired/revoked token = 401; anon token on admin/seller routes = 403.
- Merge: idempotency (same key twice yields one merge and identical response), commutativity/associativity property tests (fast-check) over random bags (union, caps 50/10, saved-for-later overflow), never exceeds caps, never negative qty, total quantity preserved or capped, price_at_add reset.
- Crash test: kill the process between "create user" and "delete anon bag" -> no lost lines and no duplicate lines after retry (single transaction + outbox).
- Age gate: under-18 at checkout blocks, DOB change retry does not lift the block (existing tests), 21+/18-20 band set correctly.
- OTP: rate limits (3 sends/15 min, 5 attempts), allow-list, attestation missing.
- Contract/Pact: mobile <-> API for the new endpoints; Maestro E2E: browse -> add -> checkout -> register -> pay (AR/EN, RTL).
- Copy-lint: no fake counts; phone 2 notice present in AR and EN.
- Privacy: purge job removes expired anon sessions; DSAR export includes merged data only after registration.

**Phased plan**
- Phase A (spec/ADR, 1 sprint): ADR-0045 (delayed registration, anon session model, age-gate position, phone 2 purpose), spec edits (rows 1-11), data_inventory/RoPA, threat-model deltas, verify-register rows. Chief-reviewer checkpoint (auth + personal data).
- Phase B (API): anon sessions, anon-or-buyer audience on catalog/cart, merge endpoint, purge job, tests above.
- Phase C (mobile): remove onboarding wall, checkout identity step, Bag merge UX, device-local Saved, copy AR/EN.
- Phase D (hardening): load test anon mint and OTP endpoints, SMS-pumping simulation, App Review notes for 5.1.1(v), A/B vs current flow.
- Items needing owner/counsel decision before building: below.

**Flags: legal or irreversible decisions (ADR / VERIFY rows)**
1. B6: allowing browse and bag before any DOB attestation (spec row "Create account, browse, wishlist, cart = 18") - owner + counsel; ADR.
2. PDPL: legal basis and retention of the anonymous device identifier and anon bag; whether strictly-necessary processing needs no consent (VERIFY, links to ADR-0002 residency).
3. PDPL: phone 2 as possibly third-party data; need for a separate purpose/consent; retention and courier sharing (DPO).
4. Apple: guideline text and acceptance of anonymous browse + checkout registration (VERIFY at submission; add to P2 row 10 context).
5. Whether Apple/Google sign-in is offered at checkout (triggers Sign in with Apple parity and the "phone still verified" rule) - product.
6. One account per phone merge policy when a phone already has an account on another device - product/security ADR.
7. Whether DOB is collected before OTP (current) or after (changes age-block anti-evasion keys) - security ADR.
8. Any move toward true guest checkout would be a separate irreversible decision (ledger, DSAR, returns) and is not recommended.

### Gaps
- No measured conversion benchmark for passwordless-OTP checkout in Egypt; A/B needed.
- I did not review `docs/data-model/cart.md`, the OpenAPI security schemes, or the Maestro flows; builder should confirm names before writing the ADR.
- The exact effect of the existing auth guard (`Authorize`/`AuthenticatedSelf` decorators in `apps/api/src/platform/decorators`) on an "anon" audience was not inspected.
