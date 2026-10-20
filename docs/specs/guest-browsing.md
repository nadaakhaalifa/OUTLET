# Spec: guest browsing, local bag and saved items, sign-up only at checkout (iOS)

- Status: product direction **Accepted** by the owner (ADR-0055); legal points **Proposed** (ADR-0055 section "Proposed", VR rows below).
- Owner requests (2026-10-16): "Don't take me to create account; let me browse, add to favourites, add to cart and everything; only before I buy ask me to create an account." Then, stricter: "Don't ever put create your account unless right before checkout directly."
- **Core rule (R0).** The only place a guest is ever asked to create an account, or shown the sign-up flow (DOB, 18+ box, phone or provider, consents), is the **Checkout gate**: the moment the guest taps Checkout in the Bag, before the Delivery step. No other screen, banner, nudge, badge, interstitial, onboarding step, role-chooser path, empty state or modal may ask a guest to create an account or link to the sign-up route. A quiet "Sign in" for existing accounts is allowed (§2 F5) and is not a create-account prompt.
- Overrides: master prompt §6 "Guest bag is not supported: an account is required (18+ gate)", the onboarding-first order of §1, the server-only bag and wishlists of §6 and §8 for signed-out users, `docs/specs/cart.md` "No guest bag", and the B6 row "Create account, browse, wishlist, cart = 18" (split, see §4).
- Unchanged: no order without an account (no true guest checkout), one account per phone, the age gate before any identifier is used (`/v1/auth/age-gate`), the checkout saga, idempotency, price lock and stock holds (which start only at `POST /v1/checkout`), ADR-0053 step pages.
- Inputs read: master prompt §1, 2, 6, 7, 8, 12, 13, B1, B6, B7; `reports/Viral feed onboarding checkout reviews.md` §C (it suggested "ADR-0045"; 0045 is taken, so this is ADR-0055); `docs/specs/mobile-ux-round-2.md`; mobile `app/index.tsx`, `role.tsx`, `onboarding/*`, `state/ports.ts`, `features/{role-choice, account-creation, bag, wishlists, checkout, discover, me}`; `packages/api-client` operations; `docs/api/openapi.yaml`.

## 1. Decisions and options compared

| Choice | Options | Chosen and why (2-3 lines) |
|---|---|---|
| (a) Where guest state lives | **A. Device-only store: `expo-sqlite` behind a `GuestStorageAdapter` port**; B. anonymous server session (report §C); C. expo-secure-store only; D. MMKV | **A** (owner decision). No personal data reaches the server before an account exists: no new token audience, no anon-session minting, no server purge job. `expo-sqlite` is "Included in Expo Go" in the SDK 57 reference (docs.expo.dev/versions/v57.0.0/sdk/sqlite, checked 2026-10-16); MMKV needs a dev-client build, so it stays a later adapter. C cannot hold the bag: SecureStore values are capped at 2,048 bytes (`platform/secure-storage.ts`). |
| (a) Merge transport | **A. One `POST /v1/me/guest-merge`, one transaction**; B. client replays `POST /v1/cart/lines` and wishlist adds | **A.** 50 lines would hit the 60/min cart limit, B is non-atomic, and wishlist item add is not idempotent (`x-idempotent: false`). A gives server caps, one audit trail and one outbox event. Cost: a new endpoint (WP-G0). |
| (a) Quantity on a SKU in both bags | **A. keep the larger quantity**; B. sum, clamped to 10 | **A** (owner decision). Guest bag has 2, account bag has 3 → 3, never 5. A duplicate across devices is far more likely than a wish for more units; summing silently raises the charge. |
| (b) Gate point | **A. Tapping Checkout in the Bag**; B. Place order on Review; C. first add-to-bag | **A** (owner rule R0). Delivery needs saved addresses and the quote needs a server cart; nothing is held for a guest. B loses three filled steps to merge changes; C contradicts the owner. |
| Account-bound features for guests | **A. Quiet: hidden, honest empty state, device-local, or deferred to after checkout sign-up**; B. one sign-in sheet with a reason per feature | **A** (owner rule R0). B is the common pattern but is exactly the prompting the owner forbade. Cost: some features (stylist, budget, gift-card buying) are invisible until the first purchase. |
| Guest personalisation | **A. Device-only affinity re-rank of public results**; B. none | **A.** Counts of local likes, views and bag stores, never sent; the server always gets non-personalised requests. B is the fallback if the DPO objects. |

## 2. Flows

**F1 First launch only (owner rule: region on first open, changeable in Settings).** Region screen (`features/welcome-region`, already built: country list, only Egypt selectable today, every other country greyed with "Not available yet"; optional "shop for" step) → entrance page (`/role`) → "Continue as shopper" → **Home tab as a guest** (no DOB, phone or consents). The choice is stored on the device only (existing `outlet.pref.region`, `RegionPrefSchema`): no account, no location permission, no GPS; the device region only preselects a row. A non-available country gets no "notify me": it would need a contact detail or an account, so it is omitted; the screen says "Not available yet" and keeps Egypt selectable. The entrance page also appears **once**: the role is stored (`outlet.pref.role`). It keeps its role choices, a quiet "Sign in" text action (F5) and one line: "Z-OUTLET is for adults 18+. You'll confirm your age before your first order." (§4). No "open a store instead" or "create account" cross-links appear on any shopper surface. Home shows a non-blocking analytics banner (§5).

**F1b Every later launch.** Straight to Home: no region screen, no entrance page, no account prompt. `resolveEntry` becomes: blocked → `/onboarding/blocked`; role `brand` → `/brand`; region not chosen → `/welcome-region`; role not chosen → `/role`; otherwise `/(tabs)`, whether signed in or not (a half-finished sign-up never routes to `/onboarding/*`, E4). `onboardingDone` and `resume` stop affecting shopper entry.

**F1c Change later.** Settings → "Region" (row already exists; opens the same picker with `mode=edit`, returns with back). Saving updates the device preference and the market scope (EG only today, so catalogue and delivery scope do not change yet); it suggests the region's default language only if the shopper never chose one, and never forces sign-in, a restart or the entrance page. A returning visitor reaches the brand path through a quiet "Sell on Z-OUTLET" row in Me and in Settings (→ `/brand`), never through a launch screen.

**F2 Browse, save, bag.** Public reads only (§9). Heart → local Saved (intent sheet Need / Want / Treat / Later). Add to bag → local bag line (size required as today). The Bag shows store groups, quantities, saved-for-later and live prices, plus: "Items aren't held for you until you check out. Your bag is saved on this phone only."

**F3 Checkout gate (the only sign-up).** Bag "Checkout" → `CheckoutGate` modal (`app/sign-up.tsx`) → why → age → method → OTP → consents (new account) → **merge** (§3) → merge summary only if anything changed ("Continue to checkout" / "Review bag") → `/checkout` Delivery step (ADR-0053 step 1). If nothing changed, straight to Delivery. Unchanged content:
1. Why: "Create your account to place your order. Your bag comes with you." Merge rule in plain words (AR first, native review): "If you already have an account, we'll add this bag to it. If an item is in both, we keep the larger quantity, never both added together." (أي قطعة موجودة في الحقيبتين نحتفظ بالكمية الأكبر، ولا نجمع الكميتين.)
2. Age: DOB + "I am 18 or older" (unticked), `AccountCreateScreen` (its toggle and legal-link changes are already built) hosted inside the gate, `runAgeGate` before any identifier. A returning user on a new device re-enters the DOB (owner accepted). Under 18 → E9.
3. Method, equal weight: phone OTP (terms unticked), Sign in with Apple, Google, passkey. Apple and Google appear only together (App Store 4.8), each only when its mobile adapter exists (today only phone).
4. OTP: limits unchanged (6 digits, 5 min, 5 attempts, 3 sends / 15 min). Recycled-number step-up runs before merge.
5. New account only: consents, every purpose off; `analytics` reflects the banner choice with "Your choice on this phone" (DPO, VR-GUEST-02); `measurements` is asked only if a local size profile exists. Skippable. Preference steps (vibes, sizes, brands, budget) are never in the gate.
6. Merge, then Delivery. Cancel at any step → back on the Bag, unchanged. AR/RTL mirrored, DOB digits LTR, Dynamic Type, VoiceOver labels, 44 pt targets.

**F4 After the first purchase.** On the order-success screen: the notification permission prompt ("Track your order"), then deferred features (stylist, budget, gift cards, referral) become visible. No upsell to create anything else.

**F5 Quiet sign-in (existing accounts only; not a create-account prompt).** A text action "Sign in" at the bottom of Me and on the role screen, styled as a link, never a button, banner or badge. Route `app/sign-in.tsx`, mode `existing_only`: phone OTP / Apple / Google / passkey; no consents step and no "create account" option or copy. If the identity has no account: "We couldn't find an account for this number." + "Back to shopping"; **nothing is created**. Until API gap G-9 ships, the server still requires `/v1/auth/age-gate` first, so the DOB step shows here too (owner accepted DOB re-entry); G-9 removes it. Success → the same merge as F3 (larger quantity, §3) → back to the screen the shopper came from, with the summary if anything changed.

**F6 Sign-out.** The device becomes a fresh guest with an empty store; the account's server bag is never copied to the device (shared phones).

### Quiet guest behaviour for account-bound features (no prompts)
| Feature | Guest behaviour | Kind |
|---|---|---|
| Checkout, COD, BNPL, store credit, vouchers, gift-card redemption | Only inside checkout, after the gate | Deferred to gate |
| Orders, returns, refunds | Me row → empty state "Your orders will appear here after your first purchase." No button | Honest empty |
| Wallet / store credit, rewards, coins | Hidden (a guest cannot hold a balance) | Hidden |
| Gift cards (buy) | Hidden; visible after the first purchase | Deferred (F4) |
| HAUL Plus | Plus page readable (benefits, prices, terms), no Subscribe button; line "You can add Plus when you check out." The existing checkout Plus offer applies after the gate (21+ rule unchanged) | Deferred to checkout |
| Referral | Own code and sharing hidden. An incoming referral link's code is kept on the device and attributed after checkout sign-up (`POST /v1/referrals/attribute`); the friend discount appears in checkout | Deferred to gate |
| Reviews, Q&A, report price | Read visible; write controls hidden (reviews are verified-purchase only) | Hidden |
| Notification permission | Never asked before the first purchase (F4) | Deferred |
| Size profile | Works locally: one profile ("Me") with measurements and fit preference in **SecureStore** (`outlet.guest.sizeprofile`, P3, Keychain, never in SQLite); the PDP compares it to the public size chart on device. Synced after the gate only with `measurements` consent | Local |
| Price-drop, restock, back-in-size alerts | Work locally: watch list in the guest store, checked on foreground via public reads, shown in-app (no push). Sent with the merge and become server alerts | Local, then merged |
| Saved-search alerts | Hidden | Hidden |
| Share lists; gift, birthday, custom lists | Hidden; sharing a product link (no referral code) works | Hidden |
| Budget, affordability, stylist, stylist chat, visual search, NL search parse | Entry points hidden (per-user cost and P3 controls); visible after the first purchase | Deferred (F4) |
| Live drops | Readable; buy controls replaced by "Live drop buying isn't available in guest mode yet." | Honest empty |
| Addresses, sessions, account deletion, server Privacy Center | Hidden; Me shows the guest privacy panel (§8) | Hidden |

One table in code, `features/guest/capabilities.ts` (`guestBehaviour(feature) → hidden | empty | local | deferred`), drives every entry point.

## 3. Merge on sign-in (gate F3 and quiet sign-in F5)
- After tokens are stored and any step-up passes. `Idempotency-Key` = `merge.pendingKey` (UUIDv7) written to the store **before** the request, reused on every retry, cleared on a 200. Only the items sent are cleared.
- Server, one transaction: bag lines union by `sku_id`; quantity = the larger of the two (guest 2, account 3 → 3, never 5), clamped to 10 and to drop per-user limits; `price_at_add` = live server price; `source = merged_guest`. Cap 50 lines: server lines win, guest overflow goes to the default Saved list (`over_cap`). Sold out, paused or delisted → not added, product to Saved if it exists (`unavailable`). Suspended store → dropped. Saved items union by `(intent list, product_id)`. Local alerts become server alerts (deduped). Recently viewed is accepted only with `personalization` consent.
- Client summary: added, quantity raised, moved to Saved, unavailable, and "price changed since you added on this phone" from `seen.unitPrice` vs live (numbers only; no "% off" unless the server claim is verified).

## 4. Age policy (flag for counsel)
Browsing, local saving and the local bag collect **no age data**; the 18+ rule is a notice on the role screen; DOB + attestation happen only at the Checkout gate (or quiet sign-in), always before the first order. This splits B6 row 1: "browse, local save, local bag: notice only; account, server bag, purchase: 18 by DOB". **Not decided:** VR-GUEST-01 and VR-GUEST-04 (counsel). Ships behind `flag.guest_browsing` (off in production; on in dev and TestFlight).

## 5. Privacy (PDPL, B1)
- No analytics SDK, PostHog, Sentry user context or ingest call before the device `analytics` consent. Banner: "Help us improve Z-OUTLET with anonymous usage stats?" **Allow** / **Not now**, equal weight, nothing pre-selected, no account mention; stored in the device consent record (`features/consent.ts`); changeable in the guest privacy panel.
- `POST /v1/analytics/events` needs a bearer today, so **guest events are dropped, not queued**, until anonymous attested ingest exists (G-6, VR-DASH-07). Guest and account analytics ids are never stitched; conversion is measured from `cart.guest_merged` (counts only).
- Guest personalisation is device-only; every server read is non-personalised (`personalized=false` where it exists).
- **Encryption analysis.** The SQLite file is **not encrypted by the app**: SQLCipher is "not supported on Expo Go" (SDK 57 reference). It relies on iOS sandboxing and default Data Protection and is included in device backups. Contents: product, SKU and store ids, quantities, timestamps, public catalogue text and prices (P0), intents, alert targets, an incoming referral code and a merge key. **No PII**: no phone, name, email, address, DOB, budget or payment data, no measurements (SecureStore, above) and **no install id** (SecureStore `outlet.device.installid`, as today). The contents identify no one on their own; assessment: plaintext is proportionate under PDPL's security duty. An app-layer cipher with a SecureStore key was rejected (JS crypto dependency, key-loss failures, protects only non-PII in backups). Controls: `.strict()` Zod allow-list schema; a unit test fails if a field name matches `phone|name|email|address|dob|birth|measure|budget|iban|token`; "Clear data on this phone" deletes the database and the SecureStore size key. A dev-client encrypted adapter (SQLCipher or MMKV) can be swapped in behind the port. **Flagged under VR-GUEST-02.**

## 6. Edge cases
| # | Case | Behaviour |
|---|---|---|
| E1 | Offline as a guest | Bag and Saved usable from the store; prices show "last seen" with a time; Checkout disabled with "You're offline". |
| E2 | Offline or 5xx during merge | "We couldn't move your bag yet" + Retry + "Continue to checkout without it"; local data kept; retried with the same key on next foreground. |
| E3 | Gate or sign-in cancelled | Back on the same screen; data unchanged; no account unless OTP or provider auth already succeeded. |
| E4 | App killed after OTP, before consents | Entry no longer opens `/onboarding/consents`: the shopper lands on Home, all purposes off; the gate resumes at the consents step on the next Checkout tap. |
| E5 | Token expiry or refresh revoke mid-checkout | Existing refresh; on revoke, the gate reopens in its sign-in form inside checkout; ADR-0053 step choices persist under the bag fingerprint; no re-merge. |
| E6 | Guest on two devices | Separate local bags; each merges with the larger-quantity rule. |
| E7 | Uninstall, backup restore | Uninstall deletes the database and data is gone; a restore may bring the guest bag back (no PII; prices re-read). Bag and Saved empty states say "Your bag and saved items are kept on this phone only." (no sign-up link). |
| E8 | Corrupt store, newer schema, SQLite open failure | Corrupt file is deleted (not renamed aside), store reset, notice once; never crash. |
| E9 | DOB under 18 at the gate or quiet sign-in | Existing blocked route and 30-day device block; guest store and size key **wiped**; browsing stays blocked as today (open question 4). |
| E10 | Phone already has an account | Normal sign-in; merge into that account. |
| E11 | Price, stock or store change in the guest bag | Live read updates the line; sold out greyed with "Find similar"; suspended store group locked with reason. |
| E12 | TTL (owner accepted) | Bag lines idle 30 days, Saved 180 days, viewed 30 days: pruned on launch with a one-time count notice. |
| E13 | Store full | "Your bag holds up to 50 items" (or 10 units per item), the server caps. |
| E14 | Quiet sign-in with an unknown identity | "We couldn't find an account for this number."; nothing created; no sign-up offered. |

## 7. Data model (device only)
Port `GuestStorageAdapter { read(): Promise<string|null>; write(json: string): Promise<void>; clear(): Promise<void> }` (`features/guest/storage.ts`). Default `SqliteGuestStorage`: own database `outlet-guest.db` (`openDatabaseAsync`), table `guest_state(k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)`, one row `k='state'`, atomic replace in a transaction; `clear()` deletes the file. `InMemoryGuestStorage` for tests. Zod-validated on every read.
```
GuestStateV1 { v: 1, createdAt, updatedAt,
  bag: [{ id uuidv7, skuId, productId, storeId, qty 1..10, savedForLater, addedAt, touchedAt,
          seen: { unitPricePiastres: string, title, sizeLabel, storeName, imageUrl|null } }]   max 50
  saved: [{ productId, skuId|null, intent: need|want|treat|later, addedAt, seenPricePiastres }] max 200
  alerts: [{ productId, skuId|null, kind: price_drop|restock|back_in_size, createdAt }]          max 50
  viewed: [{ productId, at }] max 100 (TTL 30 d)
  affinity: { stores: Record<id, count>, categories: Record<id, count> } max 50 keys each
  referral: { code: string(≤16), receivedAt } | null
  merge: { pendingKey: uuidv7|null, startedAt|null } }
```
Size cap 256 KB serialised. Versioning: `migrate(raw) → GuestStateV{n}` chain, one pure function per bump; a newer version → read-only empty view, file untouched. Size profile is a separate SecureStore JSON (< 2 KB, existing `SecureStorage`).

## 8. Screens for guests
- **Me:** no header card and no prompts. Local rows: size profile (local), language, appearance, help, legal, Orders (honest empty), "About your data on this phone" (analytics toggle, "Clear data on this phone", what is stored, privacy policy). Hidden rows per §2 table. Bottom: quiet "Already have an account? Sign in" text action (F5).
- **Saved:** round-2 Saved screen on `GuestWishlistsPort`; one list per intent; share, new list and list settings hidden; "Add to bag" works locally.
- **Bag:** `GuestBagPort`; free-delivery progress only if the public store read carries the threshold, else "Delivery calculated at checkout"; no Plus nudge or in-size suggestions. Checkout opens the gate.
- **Discover ("For you"):** public feed + local re-rank; server-history modules hidden; "Recently viewed" local; no budget data.
- **PDP:** public product read; size chart, community fit and on-device chart match from the local profile; local alert bell; review write hidden.

## 9. API needs and gaps (A3)
Public routes a guest uses (`security: []`, per-IP limits "proposed" in openapi): `GET /v1/public/search` (300/60 s), `/v1/public/products/{id}` (600/60 s), `/v1/public/stores`, `/{id}`, `/v1/public/categories` (300/60 s), `/v1/drops`, `/v1/products/{id}/{reviews,questions}` (120/60 s), `/{price-history,price-evidence,similar}` (60/60 s). Bearer-only routes the app calls today that guests cannot: `getFeed`, `search`, `suggestSearch`, `listHomeBanners`, `listStores`, `getProduct`, `getProductFit`, `/v1/cart*`, `/v1/me/*`.

| Gap | Contract |
|---|---|
| G-1 Merge | `POST /v1/me/guest-merge` · `shopperBearer`, scopes `shopper:cart.write shopper:wishlists.write shopper:alerts.write` · idempotent (UUIDv7, 24 h, same key different hash → 422) · 5/min, 20/day per user · body `{bag_lines ≤50 {sku_id, qty 1..10, saved_for_later, added_at}, saved ≤200 {product_id, sku_id?, intent}, alerts ≤50 {product_id, sku_id?, kind}, recently_viewed ≤100 {product_id, viewed_at}}`, unknown keys 400 · 200 `{cart, outcome{lines[{sku_id, result: added|qty_raised|unchanged|moved_to_saved|unavailable|store_suspended|limit_clamped}], saved{added, duplicates, over_cap}, alerts{added, duplicates}, viewed: accepted|ignored_no_consent}}` · one tx + outbox `cart.guest_merged{counts}` · audit row · 401, 413. |
| G-2 SKU batch | `GET /v1/public/skus?ids=` ≤50 · public · 60/60 s per IP + device bucket · price, availability, `units_left` 1..5, store status, verified claim only. |
| G-3 Public feed | `GET /v1/public/feed?cursor=`, never personalised · 120/60 s. |
| G-4 Public banners | `GET /v1/public/home/banners` · 120/60 s. |
| G-5 Public suggestions | `GET /v1/public/search/suggestions?q=` prefix only · 30/10 s. |
| G-6 Anonymous ingest | `POST /v1/analytics/events` with `X-App-Attest`, no bearer, consent flag · blocked on VR-DASH-07. |
| G-7 Device-keyed limits | Optional `X-App-Attest` on public routes: device bucket for attested callers, stricter IP bucket otherwise (mobile CGNAT). |
| G-8 Store threshold, size chart | Confirm `free_delivery_threshold_piastres` on public store reads and the size chart on public product reads; else add (P0). |
| G-9 Sign-in-only mode (**OTP verify BUILT 2026-10-18, flag.guest_browsing; Apple, Google, passkey NOT built**: they still create on first sign-in) | `mode: "existing_only"` on `/v1/auth/otp/verify`, `/apple`, `/google`, `/passkey/assert` → 404 `no_account`, creates nothing; OTP request answers identically either way (no enumeration); **the age gate is still required before OTP request (request-otp is unchanged, ADR-0055 item 4): the client runs the age gate first** · Security review (chief-reviewer). |

## 10. Abuse controls
Guests make **no server writes** (only G-1 after sign-in, plus the existing attested age-gate and OTP routes). Public reads: IP plus device buckets, page size ≤50, ≤30 facets, edge bot management, ETags; the catalogue is public by design. Stock shows only `units_left` 1..5; no reservation, price lock or timer for a guest; guest copy never says "reserved". OTP limits and the EG-only allow-list are unchanged; G-9 keeps identical responses for known and unknown numbers. Local alerts poll at most once per foreground, batched through G-2.

## 11. Events (consent-aware, no PII)
`checkout_gate_shown`, `checkout_gate_step(step)`, `checkout_gate_completed(method, is_new_account)`, `checkout_gate_cancelled(step)`, `quiet_sign_in_completed(method)`, `quiet_sign_in_no_account`, `guest_store_reset(cause: corrupt|newer_version|ttl)`, `analytics_banner_answered(choice)`; server `cart.guest_merged{counts}`. Add to `packages/analytics/src/analytics-events.ts` and `docs/analytics/events.md`.

## 12. Acceptance (Gherkin)
- **Global (R0):** Given a guest, when they use every tab, search, filter, favourite, add to bag, open every Me row, open a PDP, Plus, a live drop and every empty state, then no screen other than the Checkout gate shows create-account UI (sign-up route, DOB field, 18+ box, consents step, or any `signUp.*` / `onboarding.account.*` string), and the only sign-in UI anywhere is the quiet text action on Me and the entrance page (first launch only).
- Given a fresh install, when I pick Egypt and "Continue as shopper", then I land on Home without DOB, phone or consents, no location permission is requested, and no request hits `/v1/me/*` or `/v1/cart*`.
- Given I completed the first launch, when I open the app again (signed in or not), then Home opens directly: no region screen, no entrance page, no account prompt.
- Given the region picker, when I tap a country other than Egypt, then it shows "Not available yet", cannot be saved, and no "notify me" or contact field appears.
- Given Settings → Region, when I save a region, then I return to Settings, the preference is stored on the device, and no sign-in, restart or entrance page appears.
- Given a returning shopper, when they open Me or Settings, then a "Sell on Z-OUTLET" row leads to `/brand`.
- Given a guest with 2 bag lines, when I tap Checkout, then the gate opens; after DOB, 18+, OTP and consents, my server bag holds both lines at live prices and I am on the Delivery step.
- Given my account bag has SKU X ×3 and my guest bag has X ×2, when I sign in, then X has qty 3, never 5.
- Given the merge times out, when I retry, then the same Idempotency-Key is sent and nothing is doubled.
- Given a guest bag line whose SKU sold out, when I sign in, then its product is in Saved as "unavailable".
- Given I cancel the gate at OTP, then I am back on the Bag with the same lines.
- Given quiet sign-in with a number that has no account, then "We couldn't find an account" shows, no account exists afterwards, and no create-account option appears.
- Given a guest sets a local price-drop alert, when they sign up at checkout, then a server alert exists for that product.
- Given no analytics consent, then no analytics SDK is initialised and no ingest request is made.
- Given the guest store is corrupt, then the app opens with an empty bag and a one-time notice.
- Given DOB under 18 at the gate, then the device is blocked as today and the guest store and size key are empty.
- Given the first order succeeds, then the notification prompt appears once, and not before.

## 13. Test plan and source guard
- Unit: schema (incl. forbidden-field test), migrations, caps, TTL prune, corrupt reset, adapter contract on `InMemoryGuestStorage` and `SqliteGuestStorage`, `guestBehaviour` table snapshot, affinity re-rank, `resolveEntry` truth table (first launch → region → role; later launches → `/(tabs)` signed in or not; signed in without consents → `/(tabs)`, never `/onboarding/*`; blocked and brand unchanged). Property (fast-check): merge idempotent, ≤50 lines and ≤10 units, two guest merges in either order give the same quantities.
- API: 401 without token; key reuse by another user is a separate record; 422 key reuse with a different body; consent-gated `recently_viewed`; outbox and audit rows; G-9 creates nothing and responds identically at OTP request.
- **Source guard (R0)**, all in CI: (1) dependency-cruiser rule `no-sign-up-outside-gate`: only `features/checkout-gate/**` and `app/sign-up.tsx` may import `features/account-creation/**`, `app/onboarding/**` or `features/checkout-gate/**`, except `features/bag/BagScreen.tsx`, which may import only `features/checkout-gate/index.ts` (`openCheckoutGate`). (2) A guard test greps `apps/mobile/src` and fails if the strings `"/sign-up"`, `"/onboarding/account"`, `"/onboarding/consents"`, `"/onboarding/otp"` or the i18n prefixes `signUp.` / `onboarding.account.` appear outside the allow-list. (3) Maestro `16-guest-no-signup-prompt` walks every tab and Me row as a guest and asserts no `testID` starting with `signup-`. CODEOWNERS: the allow-list file needs Architect review.
- Network audit (fetch spy) in guest mode: only allow-listed public routes. Pact: G-1 to G-5, G-9. Maestro (AR and EN): `13-guest-browse-to-checkout`, `14-guest-cancel-gate`, `15-quiet-sign-in`, `16-guest-no-signup-prompt`. Copy-lint: no "reserved", "held" or timers in guest bag copy.

## 14. Work packages (start after round-2 WP-2…WP-6 merge; no shared files in parallel)
| WP | Scope | Files | Depends |
|---|---|---|---|
| G0 API (chief-reviewer on G-1 and G-9) | G-1…G-9, doc edits | `apps/api/src/modules/{auth,cart,wishlists,alerts,search,home,analytics-ingest}/*`, `docs/api/openapi.yaml`, generated `packages/api-client`, `packages/db/migrations` (`merged_guest`), `docs/specs/{cart,wishlists,auth-production}.md`, master prompt §6 note, `data_inventory.yaml`, `docs/compliance/verify-register.md` (VR-GUEST-01…04), `docs/adr/README.md` | none |
| G1 Guest store, ports, capabilities | §7, guest ports, `capabilities.ts`, size-profile key | new `features/guest/{storage.ts, sqlite-storage.ts, store.ts, schema.ts, migrate.ts, GuestBagPort.ts, GuestWishlistsPort.ts, local-alerts.ts, affinity.ts, capabilities.ts, guest.test.ts}`; `state/{ports.ts, feature-ports.ts, services.tsx}`; `platform/secure-storage.ts` (key `outlet.guest.sizeprofile`); `apps/mobile/package.json` + lockfile (`npx expo install expo-sqlite`, SDK 57, no SQLCipher, no MMKV); i18n and event keys in WP-1's files after round 2 | G0 contracts (fakes until live) |
| G2 Checkout gate, merge, Bag | §2 F3, §3; the only sign-up | new `app/sign-up.tsx`, `features/checkout-gate/*`, `features/guest/merge.ts`; `features/account-creation/*` (hosted only by the gate; toggle and legal-link changes already built); `app/onboarding/{otp,consents}.tsx` (gate return); `features/flow.ts`; `features/bag/*`, `app/(tabs)/bag.tsx`; `.dependency-cruiser.cjs` rule and the guard test `apps/mobile/src/features/checkout-gate/guard.test.ts` | G1 |
| G3 Entry, role, quiet sign-in, banner | §2 F1–F1c, F5, F6, §5 banner | `features/role-choice/{model.ts (resolveEntry), role-choice.test.ts}`, `app/index.tsx`, `features/welcome-region/WelcomeRegionScreen.tsx` (non-available copy, language suggestion in edit mode only), new `app/sign-in.tsx`, `features/quiet-sign-in/*`, `features/first-launch/AnalyticsBanner.tsx`; after the role rebrand lands: only the "Continue as shopper" target, the quiet "Sign in" link and the 18+ line in `RoleChoiceScreen.tsx` | G1, G2 (merge) |
| G4 Me and deferred features | §2 table, §8 Me, PDP, F4, "Sell on Z-OUTLET" rows | `app/(tabs)/me.tsx`, `features/me/*`, `features/settings/SettingsScreen.tsx` (Sell row only; Region row exists), `features/privacy-center/*` (guest panel), `features/pdp/*`, `features/size-profile/*`, `features/plus/*`, `features/gift-cards/*`, `features/drops/*`, `features/purchase/*` (order-success prompt), `app/{plus,gift-cards,wallet,rewards,orders,drops,stylist,budget,visual-search}.tsx` (guest guard only) | G1, G3 (sign-in link) |
| G5 Round-2 surfaces | Saved, Discover, Home, checkout revoke | `features/wishlists/*`, `app/(tabs)/saved.tsx` (WP-6), `features/discover/*`, `worlds/WorldsScreen.tsx`, `search/{SearchScreen.tsx, InlineSearch.tsx}` (WP-5), `features/home/{api.ts, HomeScreen.tsx}`, `home-banners/QuickActions.tsx` (WP-4), `features/checkout/CheckoutSession.tsx` (WP-2) | G2 and WP-2/4/5/6 merged |
Order: G1 → G2 → (G3, G4) → G5. Each WP owns the Maestro flows for its screens; G2 owns flow 16.

## 15. Apple review notes (extends VR-10; VR-GUEST-03)
5.1.1(v): apps without significant account-based features must work without login; browsing, saving, the bag, size profile and alerts now do. Placing an order is account-based (orders, returns, Arabic invoices, refunds), so requiring sign-up before payment is allowed; guest checkout is not required (VERIFY at submission). Account deletion stays in Privacy Center for accounts; guests get "Clear data on this phone". Sign in with Apple ships whenever Google ships (4.8). Reviewer notes: "Browse without an account; you create one at checkout; existing accounts can sign in from Me" plus the demo account.

## 16. Open questions (counsel and DPO only)
Owner decided 2026-10-16: `expo-sqlite` store behind a port; larger quantity on merge; TTLs 30 / 180 / 30 days; DOB re-entry on a new device; sign-up only at the Checkout gate (R0); region and entrance page on first launch only, region changeable in Settings.
Pending input: `reports/First launch region selection.md` (deep research on region UX, in production); fold its findings into F1/F1c when it lands, without reopening the owner decisions above.
1. Counsel (VR-GUEST-01): may an 18+ marketplace allow unverified browsing and a local bag with a notice only?
2. DPO (VR-GUEST-02): is the unencrypted device store acceptable (§5)? Guest analytics banner at all? May the banner choice pre-set the account `analytics` toggle?
3. Product / Legal (VR-GUEST-03): current App Store 5.1.1(v) text; account required only to order.
4. Counsel (VR-GUEST-04): sign-up, age attestation, Terms acceptance and consents happen only at checkout; is that late point acceptable (Terms bind before purchase; consents and the 18+ rule are not presented earlier), and must an under-18 block also block browsing (default: yes, as today)?

## 17. Open items from G3 (entry, region)
- **Storefront reader.** `features/welcome-region/default-region.ts` ships `unconfiguredStorefront` (returns null) behind the `StorefrontReader` port. A dev-client adapter reading StoreKit `Storefront.current.countryCode` (alpha-3, reported unreliable on TestFlight) can implement the port; Expo Go has none. Until then the default falls to the locale region, then Egypt.
- **US storefront preselects the US.** With a native reader, a US storefront would preselect the US and Continue would show "not available yet". The App Review reviewer needs one tap on Egypt, which is first in the list. Consider preselecting only served markets once a reader exists.
- **Guest server calls removed.** The role funnel call and consent sync wait for a session (queued in memory, sent once after sign-in); the Checkout gate's merge step should also call `services.role.flushFunnel?.()` and `services.consent.flushPending()` (G2).
- **Quiet sign-in (G-9 shipped).** The client sends `mode: "existing_only"` on `POST /v1/auth/otp/verify`. 404 `no_account` shows "We couldn't find an account for this number" (nothing created, OTP consumed); any other 404 of this mode (flag.guest_browsing blocked) shows "Sign-in isn't available right now" and never falls back to create mode. The age-gate step still precedes the OTP request. Phone OTP only; Apple, Google and passkey modes do not exist yet.

### Tracked blockers before real users (G-9), status 2026-10-18
- **Recycled-number step-up (VR-GUEST-06): API built, mobile UI not built.** Both OTP modes: after a correct code, an existing account last used more than 180 days ago, on an install that never held one of its sessions, gets 403 `step_up_required` and NO tokens (no session, no device row; code consumed). Design below. Tests: `apps/api/src/modules/auth/test/sign-in-only.http.test.ts` ("VR-GUEST-06"). Still a blocker for real users until the mobile step-up screen ships and the owner decides recovery (below).
- Suspended accounts (fixed, all methods): OTP and Apple/Google `existing_only` answer 404 `no_account`; OTP and Apple/Google create mode answer 403 `account_unavailable` (Apple/Google was an unhandled 500). Nothing is created. A suspended account's passkey answers 401 `invalid_passkey_assertion` (indistinguishable from an unknown credential). Pinned in `stores.contract.test.ts` and `existing-only-identity.http.test.ts`.
- Apple, Google and passkey assertion (fixed): accept `mode: "existing_only"` (behind `flag.guest_browsing`, 404 while blocked; the gate runs before the token or nonce is touched). Apple/Google: unknown identity answers 404 `no_account` after the token verified, nothing created, nonce consumed. Passkey assertion never creates an account; the mode is accepted so the client sends one mode on every method. New read-only port `UserDirectory.findByIdentity`.
- Mobile `isNewAccount` (fixed): the OTP verify response carries `is_new_account` and `http-api.ts` reads it.

#### Recycled-number step-up design (VR-GUEST-06)
| Option | Complexity | Safety | Cost | Scalability |
|---|---|---|---|---|
| **A. No tokens; 403 `step_up_required` with an account-bound passkey challenge (chosen)** | Low: auth module only, reuses `passkey_challenges` (user_id already nullable, no migration) | Fail closed: nothing to forget downstream; tokens exist only after the second factor | Low | Adding a factor (email link) is one more redeem route |
| B. Restricted session (claim `step_up_pending`) and hide stored value per route | High: every wallet, orders, addresses, gift-card route must check the claim | Fails open if one route forgets | Medium | Grows with every stored-value feature |
| C. Hard block, support only | Lowest | Safe, but locks out genuine returning owners on a new phone | Support cost | Poor |
A wins because the guarantee lives in one place (session issuance) and needs no change outside auth; B was the `evaluateRecycledNumber` default ("proceed, hide stored value") and is deliberately not used.

Rules: "unused" = the latest `lastUsedAtMs` or `createdAtMs` over the account's sessions (revoked included; none at all = account creation time), threshold `> 180 days` (`RECYCLED_NUMBER_THRESHOLD_MS`); "new device" = NOT (a session of that account with the same `install_id` AND the same attested device-key hash). `install_id` is client-supplied, so it alone proves nothing: `auth_sessions.device_key_hash` (migration 0099, HMAC of the App Attest / Play Integrity key, set at `issuer.open` on the OTP and passkey paths) must match too. Sessions created before the column hold NULL and count as NOT known (fail closed: one extra step-up per old install). A just-created account never steps up. The check runs only after a correct code, so a wrong code answers the same 422 for every number (no oracle). The 403 body is Problem+JSON with flat fields `step_up_factors` (`passkey`, a server constant, never per account), `passkey_challenge_id`, `passkey_challenge`, `passkey_rp_id`, `passkey_expires_at` (5 min, single use); no user id, masked phone, e-mail or enrolled-factor hint. The client answers with `POST /v1/auth/passkey/assert`; a challenge bound to an account is rejected (401) for any other account's credential. Once that install (with that attested key) holds a session it is a known device. Events (outbox, no PII): `auth.step_up_required` and `auth.step_up_completed` carry `user_id` and a SHA-256 `install_id_hash`. Retention interaction: `auth_sessions` is purged under `auth_credentials` (30 days, `purge_expired_sessions`) while the threshold is 180 days, so purging erases the "known device" and "last used" evidence; an account whose sessions were all purged falls back to its creation time and a returning install steps up once. This is the safe direction (more step-ups, never fewer); see docs/privacy/README.md (purge note). Any lookup failure throws (5xx, no tokens). OpenAPI: `SignInForbidden` / `SignInForbiddenProblem`; `TokenPair.second_factor_required` is now documented as always false.

Mobile work (not done here, owner rule R0 unaffected: this is inside the Checkout gate and quiet sign-in):
- M-SU-1: on 403 `step_up_required` from OTP verify (both the gate and quiet sign-in), show a "Confirm it's you" step that runs the platform passkey assertion with the returned challenge and posts it to `/v1/auth/passkey/assert`; success continues exactly like a normal sign-in (merge, then Delivery). Never fall back to create mode.
- M-SU-2: with no passkey on the device (cancel or error), show the recovery copy decided by the owner (see below) and keep the guest bag; no session, no merge.
- M-SU-3: regenerate-client consumers: `PasskeyAssertRequest.mode` and `SocialLoginRequest.mode` exist; quiet sign-in may now offer Apple, Google and passkey with `mode: "existing_only"` (404 `no_account` copy as for OTP).

Owner decisions needed (VR-GUEST-06):
1. Recovery for a genuine owner with no passkey (most accounts at launch) who returns after 180 days on a new phone: support-verified recovery, email link (needs an email provider, VR comms), or accept the lockout. The first lockouts cannot occur before 180 days after the first real accounts exist.
2. A new holder of a recycled number cannot create their own account (one account per phone): support detaches the phone identity from the stale account? Needs a policy and an admin tool.
