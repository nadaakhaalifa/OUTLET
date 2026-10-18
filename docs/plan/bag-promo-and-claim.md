# Bag: verified claim per line, promo code field, Discount row

Status: plan only, no code changed. Author: architect. Date: 2026-10-15. Phase: 1 (bag and checkout, money core), built on fakes.
Scope: the three elements of the owner's Bag design board that the redesigned `BagScreen` cannot render:
1. a strike-through price and a discount pill on each line,
2. a "Have a promo code? Apply" field,
3. a Discount row in the totals.

Governing rules: master prompt §6 (bag), §7 (checkout, quote), §9 (Price Integrity Engine), §17 (promotions), A2.4 (money as integer piastres), A2.5 (idempotency), A2.13 (never fake data), `docs/design-system/ux-principles.md` rules 4, 7 and 12, `docs/specs/cart.md`, `docs/specs/promotions.md`, `docs/specs/checkout.md`.

---

## 1. Current state (with file references)

### 1.1 Mobile bag
- `apps/mobile/src/features/bag/model.ts`
  - `BagLine` has `unitPrice`, `priceAtAdd`, `availability` and `savedForLater`. It has **no verified-claim or reference-price field**.
  - `BagPort` has `load`, `inSizeSuggestions`, `setSavedForLater`, `setQuantity`, `removeLine` and `addLine`. It has **no voucher or pricing-preview method**.
  - `buildBag` sums `unitPrice × qty` per store client-side for the subtotal and the free-delivery bar. That is arithmetic on server prices, not discount logic. The server already sends `merchandise_subtotal` per group, which the adapter ignores.
  - `priceChange`/`changeHeadline` ("dropped/rose since you added") is a statement about the shopper's own add (`docs/specs/cart.md`). It is **not a claim** and must never feed a strike-through.
- `apps/mobile/src/features/bag/api.ts` (`ApiBagPort`) maps `GET /v1/cart`. It never reads a claim, because the wire has none.
- `apps/mobile/src/features/bag/BagScreen.tsx`
  - Each `LineRow` shows the line total and the dropped/rose caption.
  - The `StickyBar` footer shows "Subtotal" and "Total", and **both are `view.total`**. There is no Discount row and no promo field.
- `apps/mobile/src/features/bag/bag.test.ts` covers free delivery, price change, suggestions and qty. It has nothing on claims or vouchers.

### 1.2 Mobile checkout (where voucher logic lives today)
- `apps/mobile/src/features/checkout/model.ts`
  - `QuoteVoucher {code, discount, applied}` and `CheckoutSelection.voucherCodes`.
  - **`computeTotals` sums the applied voucher discounts and clamps them to the gross client-side** (lines 242-246). It also computes `verifiedSavings` and the store-credit amount client-side. This is existing client money logic. The bag must not reuse it, and §8 lists it as follow-up debt.
- `apps/mobile/src/features/checkout/api.ts` (`ApiCheckoutPort`)
  - It maps `vouchers: []` always (gap) and `verifiedReferencePrice: null` on every line.
  - **`quote()` never sends `voucher_codes`**, so a code the shopper picks is only sent at commit.
- `apps/mobile/src/features/checkout/CheckoutScreen.tsx:405-428` renders vouchers only as checkboxes over `quote.vouchers`. There is no code-entry field, and the voucher total comes from `computeTotals`.

### 1.3 Verified claim elsewhere in the app
- `apps/mobile/src/features/home/model.ts:59` `claimOf` accepts a server claim only when `referencePrice > price`, `verifiedPct ≥ 5` and `verifiedPct === floor((ref − price) × 100 / ref)`. Otherwise it returns null (fail closed). This checks the server's claim; it does not compute a discount.
- `apps/mobile/src/features/home/api.ts:36-45` reads `reference_price`/`discount_pct` only when `badge === "verified_discount"`.
- `apps/mobile/src/features/shop-all/ShopAllScreen.tsx:260` and `home/parts.tsx:38` render the claim only through the kit `PriceBlock`.

### 1.4 API (server)
- **Cart.** `apps/api/src/modules/cart/adapters/wire.ts`
  - `lineWire` has no price claim.
  - `productWire` (free-delivery suggestions) already emits a `PriceBlock` and forces `reference_price`/`discount_pct` to null unless the badge is `verified_discount`. That is the pattern to copy.
  - `CatalogPort.skus()` (`cart/domain/ports.ts`, `SkuFacts`) returns no badge or reference. `SuggestionFacts` does.
- **Quote.** `apps/api/src/modules/checkout/application/quote.ts` (`QuoteCheckout`)
  - It is pure (no writes). It reprices the bag server-side, then runs **two promotion passes**: item scope first, because the free-delivery threshold is measured after item discounts and before vouchers. After that come tax, the Plus waiver, store-credit planning, method availability (including a COD risk call) and an HMAC price-lock token.
  - `address_id` is optional. **`method` is required.**
- **Quote route.** `apps/api/src/modules/checkout/adapters/checkout.controller.ts`
  - `QuoteBody` is `{method (required), address_id?, voucher_codes ≤ 5, use_store_credit, price_lock?}`, strict.
  - Rate limit is 30/min/user.
  - Errors: `bag_empty`, `method_unavailable`, `address_not_found`, `address_not_covered`.
- **Quote wire.** `apps/api/src/modules/checkout/adapters/wire.ts` (`quoteWire`)
  - It emits per-line `discount`, per-store `discount`, `discount_total`, `total`, `methods` and `price_lock`.
  - **It drops the evaluator's `applied[]` and `rejected[]`**, so the client cannot tell which code applied or why one failed.
- **Promotions evaluation.** `packages/domain/src/promotions/types.ts`
  - `EvaluationResult` already carries `applied[]` (code, scope, amount, funding split, `display: "voucher_minus"`) and `rejected[]` with a typed `RejectReason`: `unknown_code`, `too_many_codes`, `not_active`, `not_started`, `expired`, `per_user_cap_reached`, `per_day_cap_reached`, `budget_exhausted`, `payment_method_not_eligible`, `plus_members_only`, `no_eligible_lines`, `min_order_not_met`, `no_discount`, `candidate_limit`, `stacking_conflict`, `no_additional_saving`.
  - Stacking matrix v1 (`docs/specs/promotions.md` §48): at most one platform code, at most one store voucher per store, at most one auto promotion per scope, at most 5 candidates, auto-best exact.
- `POST /v1/promotions/evaluate` (`evaluatePromotions`) is **service-only** (`serviceBearer`, `InternalPromotionsController`) and takes a `user_id` in the body. The client must never call it.

### 1.5 Contract drift found during this review (blocking)
The generated client (`packages/api-client/src/generated/schemas.ts:274-278`, from `docs/api/openapi.yaml`) and the server disagree on the quote and the commit:

| Item | OpenAPI / generated client | Server (`checkout.controller.ts`, `wire.ts`) |
|---|---|---|
| Quote request: method | `payment_method` optional | `method` required |
| Quote request: address | `address_id` required | `address_id` optional |
| Quote request: line ids | `cart_line_ids` allowed | not accepted (strict body → 400) |
| Quote request: store credit | `store_credit_amount` | `use_store_credit` |
| Quote response shape | `quote_id`, `groups[]`, `payment_methods[]`, `total_payable`, `verified_savings` | no `quote_id`; `lines[]`, `stores[]`, `methods[]`, `total`, `amount_due`, `price_lock` |
| Commit request | `quote_id` required | no `quote_id` (QuoteBody + `expected_total`) |
| Code length | `max(40)` | `max(64)` |

Pact (`tooling/pact/src/consumer/mobile-contracts.ts:125-141`) and `packages/api-client/src/contract.test.ts:99` exercise **error paths only**, so no test catches this drift.

Consequences:
- `ApiCheckoutPort.quote` cannot succeed against the real server: it sends `cart_line_ids` and no `method`.
- Even if the request passed, the strict `Quote` parse would throw `ContractDriftError`.
- The mobile checkout is green only on fakes.

This drift must be resolved before any bag preview is built on the quote. That is task T1.

---

## 2. Options compared

| | **A. Reuse the checkout quote as a bag preview** | **B. Server-persisted cart vouchers** | C. Client calls `evaluatePromotions` | D. Client computes |
|---|---|---|---|---|
| Shape | `POST /v1/checkout/quote` with `purpose: "bag"`, no address, no method, `voucher_codes`. The bag keeps the entered codes in app state and hands them to checkout. | `PUT/DELETE /v1/cart/vouchers/{code}`. `GET /v1/cart` returns a `pricing` block. Codes are stored on the cart row. | Bag posts lines + codes to the evaluate route. | Bag applies % or fixed values itself. |
| Complexity | Low. One body field, one additive wire block and a skip-list in the use case. No migration. | Medium-high. New table or column with migration, two endpoints, a cart→checkout/promotions dependency, and the quote must also read stored codes. | Low | Low |
| Accuracy | **Identical to checkout**: same two-pass engine, Plus waiver and stacking matrix. Bag and checkout cannot disagree. | Same only if the cart calls the quote engine. A second evaluation entry point risks divergence. | Wrong. No shipping context, no two-pass threshold rule, no tax. | Wrong and illegal (A2.13, §17). |
| Cost | One pure read per bag change (debounced). The `bag` purpose skips price-lock signing, COD risk, method listing and credit planning. | One write per apply, and an evaluation on every cart read. | Low | None |
| Scalability | Stateless and cacheable per (cart ETag, codes hash). Rate-limited per user. | Stateful. Cross-device code sync is a plus, but every cart read pays for an evaluation. | n/a | n/a |
| Security | Shopper-scoped from the principal, no `user_id` in the body. | Same | **BOLA**: the body carries `user_id`; the route is service-only. Rejected. | Tamperable. Rejected. |

**Choice: Option A.** The quote already runs the real promotions engine in the right order (item scope, then threshold, then vouchers, then shipping), so a bag preview that calls it shows exactly what checkout will charge, with no second money path and no migration. Option B buys cross-device code sync only, at the cost of a stateful second entry point. It stays open as a later, additive step if the owner wants codes to follow the shopper across devices (decision D4).

The verified claim (element 1) is **not** a quote concern. It is a catalog/price-integrity fact about the current unit price, so it goes on `GET /v1/cart` lines, mirroring `productWire`. This keeps §17's rule that a voucher never becomes a reference price: claims and vouchers travel on different wires.

---

## 3. Design

### 3.1 Principles (non-negotiable)
1. **The server is the single source of truth.**
   - Every amount the bag shows comes from the wire: line unit price, verified reference, percent, discount per code, discount total, merchandise after discount.
   - The client adds, subtracts and multiplies no money for the Discount row or the discounted total.
   - The only client checks are (a) `claimOf`'s floor-percent consistency check, which fails closed, and (b) display formatting.
2. **Money is `bigint` piastres** end to end. Wire `Money.amount` is a decimal string, mapped with the existing `money()` helper in `services/wire.ts`.
3. **No new money logic in the mobile app.** Fakes return fixture tables keyed by input; they never evaluate.
4. **Fail closed.** No claim, a stale claim or an inconsistent claim gives a plain price. A preview that is missing, failed or in flight gives no Discount row (never a stale or optimistic one).

### 3.2 API changes (server; additive)

**(a) `GET /v1/cart`: claim per line** (`CartLine.price`, the same subset as `PriceBlock`)
```jsonc
"price": {
  "badge": "verified_discount" | "lowest_30d" | "launch_price" | "none",
  "reference_price": Money | null,   // non-null only when badge = verified_discount
  "discount_pct": 5..100 | null,     // non-null only when badge = verified_discount
  "claim_id": Uuid | null            // evidence trail (§9.3 snapshots)
}
```
- Extend the cart's `CatalogPort.skus()` / `SkuFacts` with `badge`, `referencePrice`, `discountPct` and `claimId`. Fill them from the same price-integrity source the free-delivery suggestions already use.
- Server guard in `lineWire`: emit the claim only when `badge === "verified_discount"`, **the claim was evaluated for the current `unit_price`**, and `discount_pct === floor((ref − unit) × 100 / ref) ≥ 5`. Otherwise force `badge: "none"` and nulls, as `productWire` does.
- A claim older than the §9 staleness window (72 h evidence) degrades to plain, server-side.
- Optional field: older clients ignore it. Add it to `CartLine` in `openapi.yaml`.

**(b) `POST /v1/checkout/quote`: bag preview purpose**
- Request: add `purpose: "bag" | "checkout"`, defaulting to `"checkout"`. When `purpose = "bag"`:
  - `method` is optional and must be absent.
  - `address_id` must be absent.
  - `use_store_credit` is forced to false.
  - No `price_lock` is accepted or issued.
  - Skip the COD risk call and method listing (`methods: []`).
  - Payment-partner-scoped promotions are **deferred**, not rejected (see the reason table).
  - Shipping is evaluated with standard fees so the free-delivery threshold logic stays identical. Shipping-scope discounts are reported in `promotions.applied` with `scope: "shipping"`, but the bag shows them as text, not in the merchandise Discount row (decision D3).
- Response: add, for both purposes, so checkout can drop its own arithmetic later:
```jsonc
"merchandise": {
  "subtotal": Money,          // Σ unit × qty, server
  "discount": Money,          // item + store + order scope promotions only, server
  "after_discount": Money     // server; the bag's "Total" before delivery
},
"promotions": {
  "applied": [ { "code": string | null, "auto": boolean, "scope": "item"|"store"|"order"|"shipping"|"payment_partner",
                 "store_id": Uuid | null, "amount": Money } ],
  "rejected": [ { "code": string, "reason": PublicVoucherReason, "shortfall": Money | null } ],
  "deferred": [ { "code": string, "reason": "needs_payment_method" | "needs_address" } ]
}
```
- `rejected` lists **entered codes only**. Auto promotions that did not apply are never exposed, so promotion ids and internal campaigns do not leak.
- `shortfall` is the server-computed "spend X more" for `min_order_not_met`, so the client never subtracts.

**Public reason mapping** (server-side, in the checkout wire; coarse on purpose, decision D2):

| Domain `RejectReason` | `PublicVoucherReason` | Bag copy (AR first, EN) |
|---|---|---|
| `unknown_code`, `not_active`, `not_started`, `expired`, `budget_exhausted` | `not_valid` | "This code isn't valid right now" |
| `min_order_not_met` | `min_order_not_met` (+ `shortfall`) | "Add {shortfall} to use this code" |
| `no_eligible_lines`, `no_discount` | `not_eligible` | "This code doesn't apply to items in your bag" |
| `plus_members_only` | `plus_only` | "This code is for Plus members" |
| `per_user_cap_reached`, `per_day_cap_reached` | `limit_reached` | "You've already used this code" |
| `stacking_conflict`, `no_additional_saving` | `not_combinable` | "Can't be combined with a better offer already applied" |
| `too_many_codes`, `candidate_limit` | `too_many_codes` | "You can use up to 5 codes" |
| `payment_method_not_eligible` (purpose = bag) | moved to `deferred: needs_payment_method` | "Applies when you pay with the eligible method at checkout" |
| `payment_method_not_eligible` (purpose = checkout) | `not_eligible` | as above |

**(c) Voucher-attempt limiter** (API6, §17 abuse controls; `docs/specs/promotions.md` §103 assumes "the internal caller's per-user limits")
- Count distinct entered codes that come back `not_valid`, per user and per device.
- Default: 10 per hour, 30 per day. Configurable, admin-editable with audit.
- Over the limit: the quote still returns 200, but **every** entered code is reported `not_valid` and none is evaluated. This hides whether a guess hit.
- Emit `voucher.attempts_throttled` (outbox) and alert on bursts across accounts.
- The existing 30/min route limit stays.

**(d) Fix the contract drift in §1.5** before (b). That is task T1.

### 3.3 Mobile port and model changes

`apps/mobile/src/features/bag/model.ts`
```ts
/** Server-verified claim (spec §9). Null = plain price. Never derived from priceAtAdd or a voucher. */
export interface VerifiedClaim {
  readonly referenceUnitPrice: bigint; // piastres
  readonly percent: number;            // integer 5..100, server value, checked by claimOf
}

export interface BagLine {
  // ...existing fields
  readonly claim: VerifiedClaim | null;
}

export type PublicVoucherReason =
  | "not_valid" | "min_order_not_met" | "not_eligible" | "plus_only"
  | "limit_reached" | "not_combinable" | "too_many_codes";

export interface BagPricing {
  /** Echo of the cart version this preview priced; a preview for an older cart is discarded. */
  readonly cartVersion: string;
  readonly merchandiseSubtotal: bigint;
  readonly merchandiseDiscount: bigint;   // Discount row; 0n hides the row
  readonly merchandiseAfterDiscount: bigint;
  readonly applied: readonly { readonly code: string | null; readonly auto: boolean; readonly scope: "item" | "store" | "order" | "shipping"; readonly amount: bigint }[];
  readonly rejected: readonly { readonly code: string; readonly reason: PublicVoucherReason; readonly shortfall: bigint | null }[];
  readonly deferred: readonly { readonly code: string; readonly reason: "needs_payment_method" | "needs_address" }[];
}

export interface BagPort {
  // ...existing methods
  /**
   * Server-evaluated preview of the current bag with these entered codes (POST /v1/checkout/quote, purpose "bag").
   * Pure read: no reservation, no lock, no write. Apply = preview([...codes, c]); remove = preview(codes without c).
   */
  preview(codes: readonly string[]): Promise<BagPricing>;
}
```
- **Why `preview` and not `applyVoucher`/`removeVoucher`:** with Option A nothing is stored server-side. "Apply" and "remove" are view-model state transitions over a list of strings followed by a fresh preview. Port methods named `apply`/`remove` would suggest a server write that does not exist, and would need idempotency keys for no reason. If Option B is adopted later, `preview` stays and `apply`/`remove` are added as real writes.
- **Pure view-model helpers** (string handling only, no money):
  - `normalizeCode(raw)`: trim, NFKC, map Eastern Arabic digits to ASCII, upper-case, 1..40 chars, `[A-Z0-9-]`. Anything else is rejected locally with "Check the code" and never sent.
  - `addCode` / `removeCode`: dedupe, max 5.
  - `pricingFor(snapshot, pricing)`: returns the pricing only when `pricing.cartVersion` equals the snapshot's version, else null.
- **Shared code state.** `state/promo-codes.ts` holds the entered codes for the session and hands them to checkout, seeding `CheckoutSelection.voucherCodes`. It is persisted per account in MMKV (non-sensitive instance) and cleared on sign-out and account switch. Decision D4.
- **`ApiBagPort.load`** maps `l.price` to `claim`: non-null only when `badge === "verified_discount"` and both fields are present, then passed through `claimOf` (moved from `features/home/model.ts` to a shared `features/price-claim.ts`, so the bag does not import from home). It also exposes the cart's `updated_at`/ETag as `version` on `BagSnapshot`.
- **`ApiBagPort.preview`** calls `quoteCheckout({ body: { purpose: "bag", voucher_codes } })` and maps the `merchandise` and `promotions` blocks. `shipping` and `payment_partner` applied entries map to an informational list, never into `merchandiseDiscount`.
- **`InMemoryBagPort.preview`** returns `FIXTURE_PRICING[codesKey]`, a static table that includes one `not_valid`, one `min_order_not_met` with a shortfall, one `deferred`, and one successful code. It does no arithmetic.
- **Checkout follow-up (same wave, small):**
  - `ApiCheckoutPort.quote` must send `voucher_codes`.
  - Checkout should read `merchandise.discount` and `promotions.applied` from the wire instead of `computeTotals`'s client voucher sum (§8, task T8).

### 3.4 Screen behaviour (`BagScreen.tsx`)

**Line row**
- When `claimOf` passes, render through the kit `PriceBlock` with `claim: {referenceMinor, percent, verified: true}`. That gives the strike-through of the **unit** reference and the pill "−{percent}%".
- When `qty > 1`, show "{qty} × {unit}" with the unit strike-through, then the line total (server unit × qty is display multiplication of a server price, as today). The reference is never multiplied into a "was" line total (decision D5).
- The dropped/rose caption stays and is visually distinct. It is never a strike-through.

**Promo field**
- Placed above the totals in the sticky area or the last section, with the kit `Field` (label above, rule 4) and a secondary "Apply" button. The primary action stays "Checkout" (rule 1).
- While a preview is in flight, "Apply" shows a spinner and the field is read-only.
- Applied codes show as removable chips with the server amount: "WELCOME −50 EGP".
- Rejected codes show inline error text from the reason table. A `deferred` code shows a neutral note.

**Totals**

| Row | Source |
|---|---|
| Subtotal | `pricing.merchandiseSubtotal` (falls back to `view.total` only when no pricing; identical by construction) |
| Discount | shown only when `pricing !== null && merchandiseDiscount > 0n`, as "−{merchandiseDiscount}"; auto and code discounts together, with a breakdown sheet listing `applied[]` |
| Total | `pricing.merchandiseAfterDiscount`, labelled "Total before delivery"; the existing "Delivery is calculated at checkout" note stays |

**Refresh rules**
- Every successful mutation (qty, remove, save for later, add) reloads the cart, then re-previews with the current codes. Bursts are debounced at 400 ms.
- A preview whose `cartVersion` does not match the shown snapshot is discarded.

**States**

| State | Display |
|---|---|
| Preview loading | Discount row shows a skeleton, never the previous value |
| Preview failed (offline or 5xx) | No Discount row; chips go neutral with "We'll check your code at checkout"; banner `bag.promoCheckFailed` with retry |
| `bag_empty` 409 | Existing empty state |
| 429 | "Too many tries, try again later"; the field is disabled until the `Retry-After` time |

**Checkout handoff.** Checkout always re-quotes. If its discount differs (voucher expired, budget exhausted, cap reached between bag and checkout), checkout shows the server delta through the existing `price_changed` path.

---

## 4. Honesty rules (testable)

| # | Rule | Enforced by |
|---|---|---|
| H1 | A strike-through or % pill appears **only** from a server `verified_discount` claim that passes `claimOf`. | Unit test on `ApiBagPort.load` mapping + `claimOf`; Pact on `CartLine.price`; server `lineWire` guard test |
| H2 | `priceAtAdd`, a price drop, a voucher, an auto promotion or a Plus saving **never** produce a strike-through, reference price or percent. | Unit test: line with `priceAtAdd > unitPrice` and no claim → no `claim` prop on `PriceBlock`; copy-lint |
| H3 | The Discount row shows only `merchandise.discount` from a server preview for the **current** cart version; 0 or no preview hides the row. | View-model tests for stale version, failed preview and zero |
| H4 | The client performs no subtraction or summation to derive Discount or Total. | Lint rule: no `-`/`+` on `bigint` in `features/bag/BagScreen.tsx` beyond formatting; review checklist; a test that changes `merchandiseAfterDiscount` in the fake and asserts that exact value renders |
| H5 | Voucher savings never count as "You saved" verified savings (§7 step 5, §17). | Checkout test, plus wire separation (`promotions` vs `price` claim) |
| H6 | Every voucher message is localized from the enum. Server free text is never rendered, and a code echo is rendered as plain text. | i18n parity CI, unit test |
| H7 | Budget data is never used for promotions (§12). | Existing `promotions/test/no-budget-import.test.ts`; the bag preview passes no budget fields |

---

## 5. Idempotency, concurrency and error states

- **Preview is a pure read.** No `Idempotency-Key` is needed. It writes nothing, holds no stock, issues no lock and creates no OrderGroup. A retry is always safe.
- **Commit** keeps its required `Idempotency-Key` and `expected_total`. A voucher that changed between bag and commit surfaces as 409 `price_changed` with the server delta, which re-confirmation already handles.
- **Concurrency:**
  - The preview carries `cartVersion` and the client discards mismatches.
  - Two devices editing the same cart each preview their own codes. Codes are per device in Option A; that is the documented limitation (D4).
- **Voucher lifecycle races** (expired, budget exhausted or per-user cap reached between preview and commit): the commit re-evaluates, and the shopper sees the delta (`docs/specs/promotions.md` §60).
- **Stacking (§17, policy v1):**
  - Two platform codes: the server applies the better one; the other comes back `not_combinable`.
  - A store voucher applies only to its store's lines.
  - An entered code that loses to an auto promotion comes back `not_combinable`.
  - Payment-partner offers in the bag come back `deferred`.
  - More than 5 codes are blocked client-side; the server returns `too_many_codes` if the client limit is bypassed.

**Error matrix (bag preview)**

| Condition | Wire | Bag UX |
|---|---|---|
| Unknown, expired, not started, inactive or budget-exhausted code | 200, `rejected: not_valid` | Inline error; code not kept as a chip |
| Below minimum order | 200, `min_order_not_met` + `shortfall` | "Add {shortfall} to use this code"; chip kept as pending |
| Not applicable to the bag | 200, `not_eligible` | Inline error |
| Plus-only | 200, `plus_only` | Inline, with a link to Plus (no confirm-shaming) |
| Cap reached | 200, `limit_reached` | Inline |
| Stacking loss | 200, `not_combinable` | Inline, naming the applied offer |
| Needs a payment method | 200, `deferred` | Neutral note |
| Throttled | 200, every entered code `not_valid` (limiter) or 429 (route limit) | 429 disables the field until `Retry-After` |
| Bag empty | 409 `bag_empty` | Empty state |
| Offline or 5xx | — | No Discount row; banner with retry; codes kept, unverified |
| Unknown field / mass assignment | 400 `validation_failed` | Contract test only |

---

## 6. API gaps to record in `docs/plan/api-client-gap.md` (task T9)

Add a section "Bag: claims and promo codes" with these rows:

| operationId | Needed | What the app does until then |
|---|---|---|
| `quoteCheckout` / `createCheckout` | **Contract drift** (§1.5): request field names, response shape, `quote_id` and code length disagree between OpenAPI and server. Success paths are untested by Pact. | Checkout works on fakes only; bag preview not built |
| `quoteCheckout` | `purpose: "bag"` (no method, no address, no lock, no COD risk) | Bag shows no Discount row; promo field hidden behind flag `bag.promo_preview` |
| `quoteCheckout` / `Quote` | `merchandise {subtotal, discount, after_discount}` and `promotions {applied[], rejected[] with public reason + shortfall, deferred[]}` | Same as above; checkout keeps `vouchers: []` |
| `getCart` / `CartLine` | `price {badge, reference_price, discount_pct, claim_id}` with the server-side verified-only guard | Plain prices only (fail closed) |
| `getCart` | `ETag`/`updated_at` exposed to the port as the cart version (already on the wire; needs mapping) | Mapping task, no API change |
| (limiter) | Voucher-attempt limiter and `voucher.attempts_throttled` event | Route limit 30/min only (gap for API6) |

---

## 7. Tests

**Domain/server (Vitest, PGlite where persistence is touched)**
1. `lineWire` claim guard: verified + consistent → emitted; `lowest_30d`/`launch_price` → badge only, nulls; inconsistent percent, stale claim, or claim for a different unit price → forced to `none`. Property test: for random (ref, unit), an emitted `discount_pct` always equals `floor((ref − unit) × 100 / ref)` and is ≥ 5 (fast-check).
2. Quote `purpose: "bag"`:
   - writes nothing (reservations 0, no lock token, no risk call: spy);
   - its `merchandise.discount` equals the `purpose: "checkout"` quote's merchandise discount for the same bag and codes (property test over random bags and promo pools);
   - `method`/`address_id` present with `purpose: "bag"` → 400.
3. Reason mapping: every `RejectReason` maps to exactly one public reason (exhaustive switch test). Auto-promotion rejections are never emitted.
4. `shortfall` = server min order − merchandise after item discounts. Unit test, plus a mutation run on the mapping (Stryker ≥ 80%, promotions is a critical module).
5. Limiter: 11th distinct failing code in an hour → all codes `not_valid`, a valid code included; resets after the window; event emitted; the counter is per user and per device.
6. Stacking through the quote: the `docs/specs/promotions.md` acceptance cases (two platform codes, store voucher scope, `max_discount` cap) asserted at the quote wire level.

**Contract (Pact + `packages/api-client/src/contract.test.ts`)**

7. **Success-path** interactions for `quoteCheckout` (checkout and bag purposes) and `getCart` with `price`. These close the drift hole.
8. Bag preview with one applied, one `not_valid` and one `deferred` code.
9. Bag preview with an unknown body field → 400 (mass assignment).
10. 429 with `Retry-After`.

**Negative authorization (every touched endpoint)**

11. Quote (`purpose: "bag"`) without a token → 401. With a seller or admin token → 403. It always prices the principal's own cart: shopper B's request never reflects shopper A's lines (two-user harness, `cart.authz.test.ts` style).
12. Quote with another user's `address_id` (checkout purpose) → 404, not 403 (no existence leak).
13. `POST /v1/promotions/evaluate` with a shopper bearer → 401/403 (service-only). Mobile lint: `evaluatePromotions` is not referenced under `apps/mobile` (dependency-cruiser or grep fitness function).
14. `GET /v1/cart` claims never include another store's private fields (wire allow-list test).

**Mobile unit (Vitest, pure model and adapter)**

15. `ApiBagPort.load` claim mapping: verified → claim; `lowest_30d` → null; missing fields → null; inconsistent → null (via `claimOf`).
16. `normalizeCode`: Arabic-Indic digits, whitespace, case, length, charset; dedupe; max 5.
17. `pricingFor` discards a stale `cartVersion`; Discount row is hidden for 0n, null, loading or error.
18. `ApiBagPort.preview` maps `shipping` and `payment_partner` to the informational list and never into `merchandiseDiscount`.
19. H2: a price drop with no claim yields no claim prop.

**E2E (Maestro, AR and EN, light and dark)**

20. Apply a valid code: chip and Discount row appear, and Total equals the fake's `after_discount`.
21. Invalid code: inline error, no row.
22. Remove a code: the row disappears.
23. Offline: banner shown, no row.
24. A line with a verified claim shows the strike-through and pill; a line with only a price drop shows the caption only. RTL mirroring is correct.

**Design and copy**

25. `tooling/design/check-debt.mjs` does not grow (kit `Field`, `PriceBlock` and `Button` only). Copy-lint passes. AR/EN key parity holds.

---

## 8. Threat notes (STRIDE, API Top 10 2023)

| Threat | Vector | Control |
|---|---|---|
| Spoofing / BOLA (API1) | Previewing another user's cart, or calling evaluate with a chosen `user_id` | Quote derives the user from the principal and has no `user_id` field; evaluate is service-only; tests 11-13 |
| Tampering (API3, mass assignment) | Client sends amounts, discounts or `is_plus_member` | Strict Zod bodies; the preview accepts only `purpose` and `voucher_codes`; commit trusts only `expected_total` as a guard |
| Information disclosure | Distinguishing expired from unknown codes (enumeration); leaking auto-promotion ids | Coarse `not_valid`; entered codes only in `rejected`; limiter masks results once throttled |
| Business-flow abuse (API6) | Code guessing; scripted preview spam | Limiter (§3.2c) + the 30/min route limit + App Attest at commit; alerts on cross-account bursts (shared code lists) |
| Resource consumption (API4) | Preview on every keystroke | Apply-on-tap only, 400 ms debounce on bag changes, bag purpose skips risk, tax-light path and lock signing; cache by (cart ETag, codes hash) for 30 s server-side |
| Repudiation | Disputes over "the bag showed −X" | Quote evaluations are pure; the commit snapshot stores per-line allocations and `policyVersion` (existing); the claim carries `claim_id` for the §9.3 evidence trail |
| Misleading pricing (CPL 181/2018, §9) | Strike-through from a seller "was" price or a voucher | H1-H2, server guard, contract tests; legal review in the CR-2 checkpoint |
| Logging | Codes in logs | Log a hash of each code plus its public reason, never the raw code list with the user id (promo codes can be personal referral or gift codes) |

---

## 9. Task breakdown

| # | Task | Tier | Depends on | Done when |
|---|---|---|---|---|
| T0 | ADR-0044 "Bag pricing preview reuses the checkout quote; claims on cart lines" (MADR, this doc's §2-§3), plus a `docs/specs/cart.md` and `docs/specs/checkout.md` delta | Architect (Opus) | — | Owner confirms D1-D5 |
| **CR-1** | **Chief-reviewer checkpoint: quote contract reconciliation + bag purpose + public reasons + limiter (money surface, API6)** | **Chief reviewer (Fable)** | T0 | Signed off or changes listed |
| T1 | Resolve quote/commit contract drift (§1.5): decide per field which side is right, update `openapi.yaml`, regenerate the client, fix `ApiCheckoutPort`, add success-path Pact | Builder (Sonnet), architect review | CR-1 | Pact green on success + error paths against the real controller |
| T2 | Server: `purpose: "bag"` in `QuoteBody`/`QuoteCheckout` (skip-list), `merchandise` + `promotions` wire blocks, reason mapping, tests 2-4, 6, 11-12 | Builder (Sonnet) | T1 | Domain coverage ≥ 90%, Stryker ≥ 80% on the mapping |
| T3 | Voucher-attempt limiter + event + admin config with audit (test 5) | Builder (Sonnet), security review by architect | T2 | Test 5 green; config audited |
| T4 | Cart claim: extend `SkuFacts`/`CatalogPort.skus`, `lineWire` guard, OpenAPI `CartLine.price`, tests 1 and 14 | Builder (Sonnet) | T0 | Property test green |
| **CR-2** | **Chief-reviewer checkpoint: price-claim exposure on the cart (§9, CPL) and the T2 money wire before mobile consumes it** | **Chief reviewer (Fable)** | T2, T3, T4 | Signed off |
| T5 | Mobile model and port: `VerifiedClaim`, `BagLine.claim`, `BagSnapshot.version`, `BagPricing`, `BagPort.preview`, move `claimOf` to `features/price-claim.ts`, `normalizeCode`/`addCode`/`removeCode`/`pricingFor`, `state/promo-codes.ts`, adapter + fake tables, tests 15-19 | Builder (Sonnet) | CR-2 | Unit tests green; no bigint arithmetic in the bag view model beyond line totals |
| T6 | `BagScreen` UI: `PriceBlock` per line, promo `Field` + chips + errors, Discount/Total rows, all states, AR/EN copy, flag `bag.promo_preview` (default off until T1-T4 ship) | Builder (Sonnet) | T5 | Design debt not grown; screenshots AR/EN × light/dark |
| T7 | Tests: Pact 7-10, E2E 20-24, authz 11-13 | Tester (Sonnet) | T2-T6 | All green in CI |
| T8 | Checkout follow-up: send `voucher_codes` in `quote()`, seed codes from `state/promo-codes`, replace `computeTotals` voucher sum and clamp with server `merchandise.discount` and `promotions.applied` | Builder (Sonnet), **CR-3 light review by chief reviewer (money display)** | T2, T5 | Checkout no longer sums vouchers client-side |
| T9 | Docs: `api-client-gap.md` rows (§6), verify-register row if D2 is legal-sensitive, i18n keys | Quick fix (Haiku) | T0 | Rows merged |

Sequencing: T0 → CR-1 → T1 → (T2 ∥ T4) → T3 → CR-2 → T5 → T6 → T7, with T8 after T2 + T5. Until CR-2 passes, the bag ships with plain prices and no promo field (flag off). That is honest and needs no stub numbers.

---

## 10. Owner decisions required

| # | Decision | Recommended default |
|---|---|---|
| D1 | Show a server-evaluated Discount row (auto promotions and entered codes) in the Bag, with "Total before delivery", ahead of checkout | Yes, from the server preview only; delivery stays "calculated at checkout" |
| D2 | Granularity of invalid-code messages: coarse (`not_valid` for unknown, expired or exhausted) vs exact reasons | Coarse, plus the attempt limiter (10 failed per hour, 30 per day per user and device). Exact "expired" helps enumeration. |
| D3 | Payment-partner and shipping-scope offers in the Bag | Shown as notes ("applies at checkout" / "free delivery code applied"), never inside the Discount row |
| D4 | Where entered codes live | Per account on this device (Option A), cleared on sign-out. Server-side cart vouchers (Option B) later if cross-device sync is wanted. |
| D5 | Strike-through presentation | Unit reference price + verified % pill only; never a multiplied "was" line total, and no per-line voucher allocation shown (vouchers appear only as "−X" in the Discount row) |
