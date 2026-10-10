# ADR-0010: Free-delivery threshold per store versus one bag before hub consolidation

- Status: **Proposed, needs owner decision (Product and Finance)**
- Date: 2026-10-10
- Deciders: Product, Finance, Ops
- Spec refs: bag section (free shipping at 2,000 EGP "from the same store", configurable per store and by admin), hub consolidation (Phase 2, one parcel and one fee), Plus (free delivery, no minimum)

## Context and problem statement

The bag is one bag across stores, but the free-delivery bar is per store. Phase 1 has no hub: each seller ships its own parcel, so each parcel costs a delivery fee. Hub consolidation, which gives one parcel and one fee for a multi-seller order, arrives in Phase 2. A single threshold on the whole bag would be easier to understand but would have us paying for several courier trips on one order, which thin unit economics do not support. The 2,000 EGP figure is a spec default, not a validated number.

## Decision drivers

- Parcel cost is incurred per seller shipment before consolidation.
- Shoppers see one bag and one checkout; confusion about multiple fees hurts conversion.
- Whoever funds free delivery (platform, seller, split) is not settled.
- The threshold base is already defaulted: merchandise subtotal after item discounts, before vouchers and store credit.

## Considered options

1. **Per-store threshold in Phase 1, bag-level threshold only after hub consolidation** (default).
2. One bag-level threshold from day one, platform absorbs extra parcel cost.
3. Per-store only, permanently.

## Decision (proposed default)

Option 1. The shopper sees one delivery-fee line per store group with its own progress bar, as in the spec. The threshold is read from configuration (global default, per-store override). When hub consolidation ships, a flag switches eligibility to bag level for hub-fulfilled orders. The threshold value must not be hard-coded; 2,000 EGP is a placeholder pending Finance. Funding of the waiver is recorded in the ledger as a seller or platform cost per policy.

## Consequences

- Multi-store bags in Phase 1 can show several delivery fees; copy must explain this.
- The ledger needs a delivery-fee funding field per order group now, to avoid migration later.

## Owner decision required

Finance to set the threshold value and who funds the waiver. Product to confirm per-store display for Phase 1.

## Safe default if no answer

Option 1, threshold 2,000 EGP per store, platform funds nothing: the waiver is borne by the seller only where the seller has opted in, otherwise the threshold is disabled for that store.
