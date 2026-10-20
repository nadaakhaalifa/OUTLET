# ADR-0053: Checkout as three step pages (overrides the one-page layout of master prompt section 7)

- Status: **Accepted.** The owner asked for it directly (round-2 mobile UX request, 2026-10-16). The master prompt section 7 says "Flow (one page)", and CLAUDE.md makes the master prompt the source of truth unless the owner overrides it. This is that override. It changes only the presentation. The money flow, the saga, idempotency, price lock and the no-drip-pricing rule stay exactly as they are, so it needs no legal or money sign-off.
- Date: 2026-10-16
- Deciders: Owner (decision), Architect (design)
- Spec refs: master prompt section 7 (flow, rules, drip pricing, "You saved X"), section 18 (forbidden patterns), section 25; `docs/specs/checkout.md`; `docs/specs/mobile-ux-round-2.md` item 1
- Related: ADR-0009/0010/0011 (refund basis, threshold scope, reservation TTLs), unchanged

## Context
The iOS checkout (`apps/mobile/src/features/checkout/CheckoutScreen.tsx`) is one scroll page with five numbered sections: address, delivery, payment, vouchers and review. The owner wants three pages: **Delivery -> Payment and voucher -> Review**. Section 7 has two jobs. One is presentational ("one page"). The other is protective: every fee appears on the first render, `You saved X` uses only verified savings, there is one payment intent, and idempotent commit applies. The protective rules must survive the change.

## Decision
1. **Three steps, one checkout session.** The steps are `delivery` (address plus a delivery option per shipment), `payment` (method, vouchers, store credit, gift card) and `review` (read-only summary, price-delta re-confirmation, Place order). Place order exists **only** on Review.
2. **Routing: an Expo Router stack inside `app/checkout/`, with a layout-scoped `CheckoutSessionProvider`.** The provider owns the quote, selection, submission, idempotency key and admission token. The step routes are `app/checkout/index.tsx` (Delivery), `payment.tsx` and `review.tsx`. The existing `/checkout?resume=` and `?drop=` deep links still resolve to `index` and then forward to the right step.
3. **No drip pricing.** A `CheckoutSummaryBar` appears on every step. It shows merchandise, delivery for each store, every `quote.fees` line, the voucher and credit lines once applied, and the total, all from the same `computeTotals`. A method-specific fee (for example COD or an installment admin fee) shows on the method row and in the summary as soon as the quote lists it. The client never adds a fee that the quote did not contain on the first render.
4. **Saga unchanged.** There are no new API calls. The quote and commit contracts, `buildPlaceRequest`, `requestFingerprint`, `beginSubmit` and the duplicate-tap guard are reused unchanged. The idempotency key is created only when Place order is pressed, as it is today.
5. **Resumable.** The step and the non-personal choices (saved address id, delivery option ids, payment method id, voucher codes, use-credit flag) are kept in the provider. They are also stored in the existing SecureStore (`services.storage`; WP-2 did not use MMKV, and guest data uses expo-sqlite per ADR-0055) under a bag fingerprint, with a TTL equal to `priceLockSeconds`. A free-typed address draft (P3) is never stored on disk. An unfinished payment resumes through `resumeOrderGroupId` as today.
6. **Back navigation.** The header back and the iOS edge swipe both go to the previous step. Back from Delivery leaves checkout. Choices persist across back and forward moves. While a submission is `submitting` or `awaitingPayment`, back is blocked with an explanation.

## Options compared
| Option | Complexity | Accuracy (money and state safety) | Cost | Scalability |
|---|---|---|---|---|
| A. One screen with an internal `step` state | Low. One file, one state tree | Good, but the iOS edge swipe pops the whole checkout, so swipe-back has to be disabled (poor UX) or stitched together with `beforeRemove` | Lowest | Poor. The 500-line screen grows further |
| **B. Router stack per step plus a layout-scoped provider (chosen)** | Medium. A provider and three small routes | Good. The submission and key live in one provider that outlives the steps, and native back behaves as iOS users expect | Medium | Good. Steps are testable on their own, and a later step (for example gift options) is just one more route |
| C. Global store (Zustand) plus separate routes | Medium | Weaker. Checkout state would outlive the screen and leak into other flows, and idempotency would be harder to reason about | Medium | Good |

B gives native back behaviour and keeps the idempotency key in exactly one owner whose lifetime is bounded by the checkout layout. A is cheaper but fights the iOS gesture. C widens the blast radius of money state.

## Consequences
- Maestro `subflows/place-order.yaml` and flows 05 and 08 gain two "Continue" taps. A new flow covers the steps, back navigation and resume.
- `docs/specs/checkout.md` gets a note that the mobile presentation follows this ADR. Section 7's protective rules are restated as acceptance criteria in the round-2 spec.
- The web shopper app (Phase 3) is not affected.
