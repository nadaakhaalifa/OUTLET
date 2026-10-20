# ADR-0013: Price-integrity evidence for clearance SKUs without history

- Status: **Proposed, needs owner decision (Product, Legal)**
- Date: 2026-10-10
- Deciders: Product, Legal, ML, Seller Ops
- Spec refs: price integrity section (percentage hidden when evidence is insufficient, no human asked), launch checklist ("30 curated launch brands with channel integrations connected >= 30 days"), docs/specs/price-integrity.md (evidence tiers E0-E5, lite mode), VR-07, VR-13

## Context and problem statement

The product sells clearance, overstock and sample stock, often listed once at its final price. Such SKUs have no 30-day own price history, which is the core of the engine's evidence. The launch checklist wants verified discounts at launch, but the checklist's own mitigation (channel integrations connected at least 30 days before launch) only helps sellers who have a connectable storefront and a history. The share of such SKUs is unmeasured.

## Decision drivers

- A shopper must never see a percentage the platform cannot defend.
- Sellers want to show discounts; the product's promise is real discounts.
- No human in the loop on routine claims, but no blind display of seller-typed "was" prices.
- Counsel has not confirmed the statutory discount text (VR-07).

## Considered options

1. **No percentage without evidence; plain price or "first listed price" label; seller can raise the tier by connecting a channel or supplying machine-readable history** (default).
2. Allow seller-declared reference price with a "seller-declared" label and penalties for false claims.
3. Use a platform-computed category benchmark to estimate a reference.

## Decision (proposed default)

Option 1, matching the price-integrity spec: tiers below the display threshold show a plain price. Marketing and ads follow the same rule (no "up to X% off" banner unless backed by real verified claims). Options 2 and 3 are not enabled; option 2 may be reconsidered only with written counsel advice and a distinct non-percentage label.

## Consequences

- At launch many clearance listings show no percentage; the tier-mix metric must be tracked from day one.
- Seller incentive to connect channels is the lever; seller onboarding must explain it.
- Launch marketing cannot claim "verified discounts across the catalog".

## Owner decision required

Product to accept the reduced discount display at launch, and to confirm the label wording for "first listed price". Legal to confirm VR-07 and whether a seller-declared label is ever acceptable.

## Safe default if no answer

Option 1.
