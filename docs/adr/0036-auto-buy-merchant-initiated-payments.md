# ADR-0036: Price-drop auto-buy and merchant-initiated payments

- Status: **Proposed, blocked on VR-P3-01 (PSP merchant-initiated transaction support and SCA rules) and VR-P3-02 (consumer-law treatment)**
- Date: 2026-10-12
- Deciders: Product, Finance, Legal
- Spec refs: §28 row 1, §14 (Plus), §B8 (PCI), §20.7 (fraud), docs/specs/phase-3/price-drop-auto-buy.md

## Context and problem statement
Auto-buy charges a saved PSP token later, without the shopper present, when a target price is reached. This is a merchant-initiated transaction (MIT) pattern. Whether Paymob or the second PSP supports MIT on Egyptian cards, whether 3-DS or SCA may be waived after a first authenticated mandate, and whether a scheduled "purchase on a trigger" is a valid consumer contract are all unverified. The master prompt itself tags this row VERIFY.

## Considered options
1. **Notify-and-confirm (default).** Price hits target: push with a one-tap "buy now" that runs the normal checkout (SCA present). No unattended charge.
2. **Mandate plus pre-charge window (master prompt design).** Explicit per-item opt-in, saved token, push before charge with a 15-minute cancel, then an unattended MIT charge, max 1 unit, never BNPL or COD.
3. **Reserve-then-pay.** Reserve stock at target price and require shopper payment within the window.

## Decision (proposed default)
Ship option 1 first (it needs no MIT and no new legal basis), and build option 2 completely behind kill switch `price_drop_auto_buy` and `auto_buy.charge` (both off) with a fake PSP MIT adapter. Option 2 may be enabled only when VR-P3-01 and VR-P3-02 are Verified and the owner accepts. Option 3 is rejected: it holds scarce stock for a non-paying shopper.
Invariants for option 2 regardless of provider: explicit mandate text versioned and stored, per-item target and a hard max amount, budget and hard-cap check at charge time, fraud check at charge time, Plus members only per the spec, idempotency key `auto_buy:{mandate}:{price_event}`, ledger-first posting through the normal checkout saga (no parallel money path), full return rights unchanged.

## Consequences
Good: no unattended charge ships by default; the money path is the existing checkout saga. Bad: option 1 converts less than true auto-buy; option 2 may never be legal or supported.

## Owner decision required
Approve option 1 as the launch behaviour; decide whether to pursue option 2 after counsel and PSP evidence.

## Safe default if no answer
Option 1 only; option 2 code stays dark.

## Notes: Phase 3 money review part B fixes (B-0 to B-8)

Implemented after the chief reviewer's findings (docs/plan/phase-3-money-review.md part B):

- **Unresolved is never failed (B-1).** `MitCheckoutPort.lookup` is `placed | failed | pending | not_found`. Only `failed` (terminal saga failure) moves an attempt to `FAILED`. A thrown `placeOrder`, a `pending` lookup, a throwing lookup and `not_found` all keep the attempt `CHARGING` until the 60 minute ceiling, then park it in the new `MANUAL_REVIEW` state (event `auto_buy.manual_review`, no shopper "not charged" notice). `MANUAL_REVIEW` is re-looked-up every sweep, so a late success is recorded as `PURCHASED` and closes the mandate. While any attempt of a rule is in flight, parked or unresolved, the rule cannot trigger again (one attempt in flight per rule). `REQUIRES_USER_ACTION` is looked up before it is abandoned.
- **Charge bounded by the notified price (B-2).** `decideCharge` skips with `price_above_notified` when the live price exceeds the trigger price; `max_price` stays the hard ceiling.
- **Evidence survives deletion (B-3), migration 0057.** FKs from users and mandates to mandates and attempts are `RESTRICT`. The erasure executor tombstones the user and scrubs in place; the mandate guard now permits only `accepted_device_id` and `psp_token_ref` to be scrubbed. Inventory: both tables `retain_legal` (orders_tax_records), those two fields `pseudonymize`.
- **Window and hold (B-5, B-8).** The stale-notice grace equals the payment allowance in the hold TTL (10 min); the cancel window is measured from after the notice is durably enqueued. Cooldown counts only attempts that reached `NOTIFIED` (B-6). The active-rule cap takes a per-user advisory lock (B-7).

Owner decisions that remain:
1. **Never-charged rules and attempts are retained** under `orders_tax_records` after account deletion (personal columns scrubbed). Deleting never-charged rows needs a per-row retention predicate in the erasure executor; the safe default (retain, scrubbed) was chosen. Counsel to confirm the retention period for MIT evidence (VR-P3-01 area).
2. **`not_found` after a claim goes to MANUAL_REVIEW, not FAILED.** This also parks the rare crash between claim and `placeOrder`. An ops queue and a resolution tool for `MANUAL_REVIEW` (confirm not charged with the PSP, then FAILED) are not built; admin console work.
3. **Hooks without events.** `price.changed` has no producer; `order_group.paid` carries no SKU ids (CloseOnPurchase needs `sku_ids` added to the checkout payload); no card-removal event exists. Until then, charge-time rechecks (vault inspect, eligibility) are the only enforcement of card removal.
