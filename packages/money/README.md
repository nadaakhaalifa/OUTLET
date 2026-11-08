# @outlet/money

`Money` is `{ amountMinor: bigint, currency }`. Integer minor units only (EGP: piastres); floats never appear.

## The single rounding point

`roundHalfEven(numerator, denominator)` in `src/rounding.ts` is the only place a fraction becomes an integer
(banker's rounding, half to even). `fraction(money, numerator, denominator)` calls it once: `amount * numerator / denominator`. `percentOf(money, bps: bigint)` is `fraction(money, bps, 10000n)`; VAT-inclusive extraction is `fraction(gross, 1400n, 11400n)`.
New code that needs rounding (tax, proration, FX) must call it, not reimplement it.

## Other rules
- Mixed currencies throw `MoneyError("CURRENCY_MISMATCH")`.
- `allocate(total, ratios)` uses largest remainder, ties to the lowest index; parts sum exactly to the total.
- Wire format: `amountMinor` is a decimal string; parse with `moneySchema`, emit with `toWire`.
- The `district/no-float-money` lint rule is off inside `src/` only (bigint math lives here); everywhere else it applies.
