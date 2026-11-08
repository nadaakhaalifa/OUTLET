# @outlet/promotions

Master prompt section 17. `evaluate` / `autoBest` are pure (bigint piastres via @outlet/money); `PromotionService`, `VoucherService`, `PromotionEvaluator.evaluateForQuote` sit on Postgres (migration 0027).

- Order: item, store, order, shipping, payment-partner. Stacking: one platform code, one payment-partner offer, one store voucher per store, any number of auto promotions. Auto-best is exact over at most 5 candidates (`pruneCandidates` trims larger pools).
- Funding is recorded per line and per funder; `toTaxableLines` feeds `allocateVatWithLineDiscounts`, `ledgerFunding` gives the `promo_expense_platform` amount (seller-funded only shrinks the seller share, ledger chart 4.2).
- `displayLabels` only ever says "Voucher -X" / "Discount -X": no percentage, no reference price.
- Budget data never enters: no budget import, no budget field in targeting (guard test).
- Reservations are place-time, idempotent per (order group, promotion); reinstatement only for a whole order cancelled before shipping (`OrderFactsPort`).
- Kill switch `promotions.enabled` is a port (`KillSwitchPort`); register it in @outlet/flags when wiring. Not wired into checkout yet.
