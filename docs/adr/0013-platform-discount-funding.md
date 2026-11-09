# ADR-0013: Platform-funded discount funding under PSP split

Status: Proposed (owner and finance decision; gates real money)

## Context
In split model A the PSP pays each seller `min(seller_net_minor, store share of the charge)`. A platform-funded discount lowers the shopper's charge but not `seller_net_minor`. When the discount exceeds commission + commission VAT for a store, the store share falls below `seller_net_minor` and the seller is underpaid at the PSP.

## Options
1. Cap (implemented as the safe default): a platform-funded discount per store may not exceed commission + commission VAT. The quote refuses a code with `platform-discount-cap` (422, "voucher cannot be applied to this store"); an automatic promotion is simply not applied.
2. `promo_receivable_seller` posting plus payout top-up: the platform funds the gap from its own balance and tops up the seller through the payout run. Needs ledger chart changes, a funding source and finance sign-off.

## Decision
Option 1 until finance chooses option 2. Property test: for every capped split without store credit, the seller PSP share equals `seller_net_minor`.

## Consequences
Large platform promotions on low-commission stores are limited. Revisit with the funds-flow decision (ADR-0003 / 0019).
