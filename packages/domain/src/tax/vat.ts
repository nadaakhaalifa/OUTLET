import { InvalidAmountError } from "../errors";
import { divideRoundHalfEven, money, percentOfBps, type Money } from "../money";

/** Standard Egyptian VAT, 14% (spec B4). 1_400 basis points. Admin cannot raise it; exemptions only. */
export const DEFAULT_VAT_BPS = 1_400n;
export const MAX_VAT_BPS = 10_000n;

export interface VatSplit {
  readonly net: Money;
  readonly vat: Money;
  readonly gross: Money;
}

function assertRate(rateBps: bigint): void {
  if (rateBps < 0n || rateBps > MAX_VAT_BPS) throw new InvalidAmountError("VAT rate must be between 0 and 10000 bps");
}

/**
 * Splits a VAT-INCLUSIVE gross amount (shopper prices are VAT-inclusive, spec B4).
 *
 * THE single rounding point of the tax engine: `net = round_half_even(gross * 10000 / (10000 + rate))`.
 * VAT is the exact remainder `gross - net`, so `net + vat == gross` always holds and no piastre is
 * created or lost. Works for negative grosses (credit notes mirror the original exactly).
 */
export function splitVatInclusive(gross: Money, rateBps: bigint): VatSplit {
  assertRate(rateBps);
  const net = money(divideRoundHalfEven(gross.amount * 10_000n, 10_000n + rateBps), gross.currency);
  return { net, vat: money(gross.amount - net.amount, gross.currency), gross };
}

/**
 * Adds VAT to a VAT-EXCLUSIVE net amount (B2B invoices from Z-OUTLET to sellers: commission and
 * fees are quoted net). VAT is rounded half-even once; gross is the exact sum.
 */
export function addVatToNet(net: Money, rateBps: bigint): VatSplit {
  assertRate(rateBps);
  const vat = percentOfBps(net, rateBps);
  return { net, vat, gross: money(net.amount + vat.amount, net.currency) };
}
