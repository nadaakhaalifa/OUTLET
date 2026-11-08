import { add, fraction, money, percentOf, sub, type Money } from "@outlet/money";
import { TaxError } from "./rates.js";

export interface VatSplit {
  readonly net: Money;
  readonly vat: Money;
  readonly gross: Money;
}

const checkBps = (bps: number): bigint => {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new TaxError("INVALID_RATE", "bps must be an integer in 0..10000");
  return BigInt(bps);
};

/** Extracts VAT from a VAT-inclusive gross. The single rounding point is fraction(); net is the remainder, so net + vat === gross. */
export function splitInclusive(gross: Money, bps: number): VatSplit {
  const b = checkBps(bps);
  if (gross.amountMinor < 0n) throw new TaxError("INVALID_INPUT", "gross must be non-negative");
  const vat = fraction(gross, b, 10_000n + b);
  return { net: sub(gross, vat), vat, gross };
}

/** Adds VAT on top of a net amount (B2B invoices). */
export function addExclusive(net: Money, bps: number): VatSplit {
  const b = checkBps(bps);
  if (net.amountMinor < 0n) throw new TaxError("INVALID_INPUT", "net must be non-negative");
  const vat = percentOf(net, b);
  return { net, vat, gross: add(net, vat) };
}

export const zero = (currency: Money["currency"]): Money => money(0n, currency);
