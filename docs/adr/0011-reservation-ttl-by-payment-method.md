# ADR-0011: Reservation TTL by payment method

- Status: **Proposed, ready for owner approval** (values depend on PSP behaviour, VR-04, VR-12)
- Date: 2026-10-10
- Deciders: CTO, Product, Finance
- Spec refs: checkout saga (`ReserveInventory` TTL 10 min, one reservation per order group), inventory section (`expires_at = now() + 10 min`), async methods (30 min wallets, 24 h Fawry on a separate non-drop pool), ADR-0005

## Context and problem statement

The spec states a flat 10-minute reservation TTL in the saga and the inventory SQL, then gives 30 minutes for wallet redirects and 24 hours for Fawry. Row-per-unit reservations (ADR-0005) hold real stock, so a long TTL on scarce stock lets slow payment methods starve other shoppers, and a short TTL abandons valid payments. A flat constant is therefore wrong; the TTL must be keyed by payment method and stock type.

## Decision drivers

- Fairness and oversell protection on scarce clearance units.
- Payment windows differ by method and are partly provider-defined (unverified).
- COD has no payment step, so no long hold is justified.
- Late payment success after expiry must not oversell.

## Considered options

1. **TTL table by payment method with a stock-pool rule** (default).
2. One flat 10 minutes for all methods.
3. Flat 30 minutes for all methods.

## Decision (proposed default)

Option 1, as configuration, not constants:

| Method | Default TTL | Notes |
|---|---|---|
| Card, Apple Pay (synchronous) | 10 min | Includes 3-DS challenge time; extend once by 5 min on an active challenge |
| COD | 10 min | Order is confirmed at placement; reservation converts to claimed immediately |
| Wallet redirect, InstaPay request-to-pay | 30 min | Provider window to be confirmed (VR-04) |
| BNPL | 15 min | Provider approval flow; value to be confirmed (VR-05) |
| Fawry reference | 24 h | Only for SKUs in the separate non-drop pool; drop SKUs excluded |

Rules: a payment confirmation arriving after expiry attempts to re-reserve; if no unit is free the payment is refunded automatically, with a ledger reversal and a shopper notification. Quantity per unit in a long-TTL pool is capped by configuration.

## Consequences

- Long holds reduce sellable stock for the pool; the pool size must be monitored.
- Test matrix grows per method.
- The expiry reaper must handle per-row `expires_at`, which ADR-0005 already supports.

## Owner decision required

Approve the table values and the Fawry pool size limit. Confirm provider windows once contracts exist.

## Safe default if no answer

The table above.
