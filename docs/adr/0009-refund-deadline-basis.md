# ADR-0009: Refund payment deadline basis (from delivery versus from return receipt)

- Status: **Proposed, blocked on VR-07 (Legal)**
- Date: 2026-10-10
- Deciders: Legal, Finance, Product
- Spec refs: consumer-law section (refund within 14 days "from delivery"), refunds section (SLO "assume 14 days from return receipt"), open question 11, VR-07

## Context and problem statement

The master prompt contradicts itself. One passage says distance selling carries a "refund within 14 days from delivery". Another sets the SLO as "paid within the legal deadline (assume 14 days from return receipt)". We have not verified the statute. The two bases differ materially: a return window of 14 days plus transit means a refund due 14 days from delivery can fall due before the item is even back at the hub.

## Decision drivers

- Never breach a statutory deadline; the legal text is unverified.
- Cash flow: refunding before inspection exposes us to return fraud.
- Trust: shoppers expect refunds promptly.
- Ledger: the deadline is a constant that drives SLO alerts and cannot be a hidden literal.

## Considered options

1. **Stricter of the two** (default): the refund must be paid within 14 days of delivery **and** initiated within 24 hours of return receipt. When both apply, the earlier date wins. Operationally: the system alerts on whichever clock expires first, and the return pickup is scheduled so receipt normally precedes the delivery-based deadline.
2. 14 days from return receipt only.
3. 14 days from delivery only, refunding before the item is received.

## Decision (proposed default)

Option 1. The deadline basis is a typed policy value (`refund_deadline_basis`) with two clocks, both tracked per return. Customer-facing text says "we refund you within 14 days" without naming the basis until counsel confirms. Where the delivery-based clock would expire before receipt, the refund is issued on courier pickup confirmation for low-risk accounts (policy flag, Finance to set the risk rule).

## Consequences

- Higher refund-before-receipt exposure for a small set of returns; bounded by the risk rule.
- Slightly more complex SLO dashboards (two clocks).
- Once VR-07 is verified, one clock is removed by configuration, not code.

## Owner decision required

Legal to state the statutory basis and day count in writing. Finance to approve the exposure limit for refund-on-pickup.

## Safe default if no answer

Option 1 as above.
