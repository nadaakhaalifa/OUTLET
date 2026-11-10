# @outlet/tax

Pure VAT engine (master prompt B4). Integer minor units; all arithmetic through `@outlet/money`, one rounding point per VAT figure.

- `splitInclusive(gross, bps)`: shopper prices are VAT-inclusive. vat = fraction(gross, bps, 10000+bps), net = gross - vat.
- `addExclusive(net, bps)`: B2B commission invoices (HAUL to seller).
- `allocateVatAcrossLines`: order-level discount allocated by largest remainder, VAT computed once per line, invoice VAT = sum of line VAT.
- `commissionInvoiceLines` / `ourB2cSupplies`: e-invoice and e-receipt lines (goods e-receipts are the seller's supply).
- `TaxRateProviderPort`: every rate has `validFrom/validTo`, so old orders recompute with their day's rate. `reduced` has no default rate and throws until configured.
- No migration: categories are code + config; persistence of admin overrides is a later adapter.

## V62 (open): VAT base when the platform funds a discount
Flag `platformFundedDiscountReducesBase`, default `false` (conservative: VAT on the full price). Seller-funded discounts always reduce the base. Also open: V60 (commission base, caller supplies it), V61 (agent vs deemed supplier), V59 (input VAT).

## Notes
- `allocateVatWithLineDiscounts`: per-line `{platformDiscount, sellerDiscount}`; base = gross - seller - (flag ? platform : 0), one `splitInclusive` per line. `allocateVatAcrossLines` is the single-funder wrapper. Note `AllocatedLine.gross` is the taxable base; the shopper-facing gross is `payable + discount`.
- `commissionInvoiceLines(..., { posted })` only shapes lines from POSTED ledger figures (invariant I14); never recompute for an invoice.
- Rates: `close()` and auto-close of the open period when a later-starting rate is upserted keep exactly one rate per instant.
- `buildReceipt` emits `discount` lines (`voucher -X`, V62/CPL): paid total = gross - discount on every document.
- Deferred: `ourB2cSupplies` covers delivery fees only; Plus subscriptions and gift-card sales (our other B2C supplies, B4) are not built yet.
