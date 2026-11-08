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
