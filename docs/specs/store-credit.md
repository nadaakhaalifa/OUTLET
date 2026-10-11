# Spec: Store credit wallet (closed loop)

Status: implemented for Phase 1 on synthetic data. Sources: master prompt 15.2, B2, 15.1, 7; ADR-0003; ADR-0021 decision 3.
Code: `packages/domain/src/store-credit`, `apps/api/src/modules/store-credit`, migration `0034_refunds_store_credit.sql`.

## Flow
1. Value enters only as: refund the shopper took as credit (`RestoreRefundCredit`), gift-card redemption (`GrantCredit.giftCardRedeemed`), cashback coins, referral credit, goodwill (`GrantCredit.promo`). Each grant posts its ledger entry first (idempotent on key), then writes a lot and a `credit_added` transaction (idempotent on the same key).
2. Checkout split tender: `CreditHolds.hold` plans a spend over the user's lots and holds it (TTL 10 min); on payment `capture` consumes it, on failure or timeout `release` (or the expired-hold sweeper) returns it.
3. `SweepExpiredCredit` writes off expired platform credit (coins, referral, goodwill) once, ledger first. Gift cards and refund credit are never written off here.
4. `ReconcileWallets` (nightly) compares the lot projection to postings on `store_credit:{user}:{sub}` and reports drift. It never repairs.
5. Reads: `GET /v1/me/wallet`, `GET /v1/me/wallet/transactions?cursor=&limit=`.

## Rules
- Sub-balances and expiry (VERIFY VR-RF-07): `refund_credit` never; `gift_card` per card (default 3 years); `cashback_coins` 12 months; `referral_credit` 6 months; `goodwill` 90 days. A refund restored to an expiring sub gets the full term again (VR-RF-06).
- Spend order: sub-balances by soonest expiry first, non-expiring next, `refund_credit` last, so refund credit can still go back to the original method if ever needed (`planStoreCreditSpend`, reused). Inside a sub-balance, earliest-expiring lot first. Algorithm choice: FIFO by grant date versus soonest-expiry-first. Soonest-expiry-first, because FIFO lets short-lived credit lapse while longer-lived credit is spent.
- No top-up, no withdrawal, no peer transfer. The UI says "HAUL credit" (Arabic: رصيد Z-OUTLET), never cash or money; labels come only from `labelFor`, and a lint test checks every wire string.
- Gift-card SALES stay behind a kill switch default OFF (`GIFT_CARD_SALES_GATE`, `giftCardSalesEnabled`); redemption is a separate path.
- Amounts are integer piastres (bigint), currency EGP, serialized as decimal strings.

## Edge cases
Insufficient credit: `insufficient` with the available amount, nothing held. Same `(user, ref)` hold twice: `exists`, one hold. Expired lot before the sweeper runs: not spendable (`availableOf`). Capture of a released hold: `not_held`. Order ledger entry not posted yet at reconciliation: captured amounts are tolerated, not reported as drift. A user with no credit: empty wallet, 200.

## Data
`credit_lots` (CHECK remaining <= granted, held <= remaining; refund credit has no expiry, all others have one; unique source_key), `credit_holds` (unique user + ref), `credit_hold_lines`, `credit_transactions` (unique dedupe_key). No column or table named for withdrawal, top-up or transfer (asserted by a migration test). RLS: owner read, staff read, writes under `app.role = 'system'`. P2 for user-linked rows; tags in `data_inventory.yaml`.

## API
| Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/me/wallet` | buyer token, subject only | read | 60/min/user |
| `GET /v1/me/wallet/transactions` | buyer token | read | 60/min/user |

Only these two routes exist. A route-absence test posts, puts, patches and deletes to the wallet and to top-up, withdraw, transfer and deposit paths and expects 404 or 405.

## Events and failure handling
Internal use cases are called by other modules (checkout saga, refunds, rewards, referrals, gift cards). Sweepers and the reconciler are idempotent and safe to run concurrently (`FOR UPDATE` on lots, guarded `expireLot`). The ledger adapter is the ledger module's `CreditLedgerPort` (in-memory fake here).

## Security and abuse
Subject comes from the token only, so there is no object id to enumerate (BOLA by construction). Grants are idempotent on key, so a replayed event cannot double-credit. Abuse of gift-card redemption (brute force) belongs to the gift-card module (15.1).

## Metrics
Wallet projection drift (0), credit expired value by sub-balance, hold-to-capture rate, expiring-soon notifications sent.

## Acceptance
- Spend 2,500 over goodwill 1,000, coins 1,000, refund credit 3,000: takes 1,000, 1,000, 500; release restores 5,000.
- Property: a hold takes exactly the amount, release returns exactly it, no balance goes negative.
- Sweeper twice writes off once; gift card and refund credit survive; reconciliation shows no drift.

## Holds (wave 4 review F-1, ADV-W4-2)

- A hold carries the TTL its caller needs (checkout: payment window plus grace). The expiry sweeper skips holds whose owner process is still live.
- `placeHold` is atomic per user: the Postgres adapter takes a transaction advisory lock per user and then `FOR UPDATE` on the lots; the in-memory reference serialises holds per user. Two concurrent holds cannot take the same credit.
- `captureHold` is idempotent for the same `orderEntryKey` (returns `captured`); a released, expired or foreign-key capture returns `not_held`, and an unknown hold `not_found`. Callers must treat both as a hard failure.
