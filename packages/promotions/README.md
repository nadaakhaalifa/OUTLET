# @outlet/promotions

Master prompt section 17. `evaluate` / `autoBest` are pure (bigint piastres via @outlet/money); `PromotionService`, `VoucherService`, `PromotionEvaluator.evaluateForQuote` sit on Postgres (migration 0027).

- Order: item, store, order, shipping, payment-partner. Stacking: one platform code, one payment-partner offer, one store voucher per store, any number of auto promotions. Auto-best is exact over at most 5 candidates (`pruneCandidates` trims larger pools).
- Funding is recorded per line and per funder; `toTaxableLines` feeds `allocateVatWithLineDiscounts`, `ledgerFunding` gives the `promo_expense_platform` amount (seller-funded only shrinks the seller share, ledger chart 4.2).
- `displayLabels` only ever says "Voucher -X" / "Discount -X": no percentage, no reference price.
- Budget data never enters: no budget import, no budget field in targeting (guard test).
- Reservations are place-time, idempotent per (order group, promotion); reinstatement only for a whole order cancelled before shipping (`OrderFactsPort`).
- Kill switch `promotions.enabled` is a port (`KillSwitchPort`); register it in @outlet/flags when wiring. Not wired into checkout yet.

## Hardening notes (chief review)
- Concurrency: `reserve` takes `pg_advisory_xact_lock` on the shopper (velocity) and then on each (shopper, promotion) pair in sorted order, so concurrent order groups cannot both pass the per-user limit or velocity check.
- `reserve` does not trust the caller: the voucher must belong to the applied promotion and the total must be within `max_discount` (typed `CODE_INVALID` / `CAP_EXCEEDED`).
- Counters (`promotion_usage`, `vouchers.uses`) change only through the SECURITY DEFINER functions `promotion_usage_bump` / `promotion_usage_giveback` (migration 0027); `outlet_app` has no direct UPDATE. The bump sets the promotion to EXHAUSTED when `budget_minor` or `total_limit` is reached; a give-back re-opens it while inside its window. The function owner must bypass FORCE RLS (the migrator does).
- Public codes are 8-32 chars (service and CHECK). `CodeResolutionBudget` (attempts per user/device) is consulted by `resolveCode`; it is a second line only: the API layer MUST rate-limit the code-entry route per user, device and IP.
- `transition` to ACTIVE requires `starts_at <= now < ends_at`. The kill switch is enforced on `reserve` (throws `DISABLED`); admin lifecycle calls and release/confirm/reinstate still work while it is off, so in-flight reservations can be cleaned up.
- bogo/bundle round once: the percentage is applied to the undiscounted value of the free/bundled units, then spread across lines (largest remainder).

