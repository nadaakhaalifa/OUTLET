import { add, allocate, compare, sub, type Money } from "@outlet/money";
import { TaxError } from "./rates.js";
import { splitInclusive, zero, type VatSplit } from "./vat.js";

export type DiscountFunder = "platform" | "seller";

export interface TaxableLine {
  readonly id: string;
  /** VAT-inclusive list price x qty, before the order-level discount */
  readonly gross: Money;
  readonly bps: number;
}

export interface VatBaseConfig {
  /**
   * V62 (open): when the PLATFORM funds a discount, is the VAT base reduced?
   * false (default, conservative): VAT is charged on the full price, so the platform never under-declares.
   * A seller-funded discount is a real price cut and always reduces the base.
   */
  readonly platformFundedDiscountReducesBase: boolean;
}
export const CONSERVATIVE_VAT_BASE: VatBaseConfig = { platformFundedDiscountReducesBase: false };

export interface AllocatedLine extends VatSplit {
  readonly id: string;
  readonly bps: number;
  /** total discount on the line (platform + seller) */
  readonly discount: Money;
  readonly platformDiscount: Money;
  readonly sellerDiscount: Money;
  /** what the shopper pays for this line */
  readonly payable: Money;
}
/** A line with its own funder-split discounts (both may be present). */
export interface DiscountedTaxableLine extends TaxableLine {
  readonly platformDiscount?: Money;
  readonly sellerDiscount?: Money;
}

export interface AllocatedOrder {
  readonly lines: readonly AllocatedLine[];
  readonly invoiceVat: Money;
  readonly invoiceNet: Money;
  readonly payableTotal: Money;
}

const sum = (xs: readonly Money[], currency: Money["currency"]): Money => xs.reduce((a, m) => add(a, m), zero(currency));

/**
 * Per-line discounts by funder. base = gross - seller - (config.platformFundedDiscountReducesBase ? platform : 0);
 * exactly one splitInclusive (the only rounding) per line; invoice VAT = sum of line VATs.
 * payable = gross - seller - platform (cash), regardless of the flag.
 */
export function allocateVatWithLineDiscounts(lines: readonly DiscountedTaxableLine[], config: VatBaseConfig = CONSERVATIVE_VAT_BASE): AllocatedOrder {
  const first = lines[0];
  if (first === undefined) throw new TaxError("INVALID_INPUT", "no lines");
  const currency = first.gross.currency;
  const out = lines.map((l): AllocatedLine => {
    const platform = l.platformDiscount ?? zero(currency);
    const seller = l.sellerDiscount ?? zero(currency);
    if (platform.amountMinor < 0n || seller.amountMinor < 0n) throw new TaxError("INVALID_INPUT", "discount must be non-negative");
    const total = add(platform, seller);
    if (compare(total, l.gross) > 0) throw new TaxError("INVALID_INPUT", "line discounts exceed the line gross");
    const base = sub(sub(l.gross, seller), config.platformFundedDiscountReducesBase ? platform : zero(currency));
    const split = splitInclusive(base, l.bps);
    return { ...split, id: l.id, bps: l.bps, discount: total, platformDiscount: platform, sellerDiscount: seller, payable: sub(l.gross, total) };
  });
  return {
    lines: out,
    invoiceVat: sum(out.map((l) => l.vat), currency),
    invoiceNet: sum(out.map((l) => l.net), currency),
    payableTotal: sum(out.map((l) => l.payable), currency),
  };
}

/**
 * Order-level discount, single funder (thin wrapper): largest-remainder allocation by gross (ties to lowest index), then the
 * per-line path above. net/vat/gross on a line describe the taxable base; `payable = gross - discount` is cash.
 */
export function allocateVatAcrossLines(
  lines: readonly TaxableLine[],
  discount: Money,
  funder: DiscountFunder,
  config: VatBaseConfig = CONSERVATIVE_VAT_BASE,
): AllocatedOrder {
  if (lines.length === 0) throw new TaxError("INVALID_INPUT", "no lines");
  const currency = discount.currency;
  const total = lines.reduce((acc, l) => add(acc, l.gross), zero(currency));
  if (discount.amountMinor < 0n || compare(discount, total) > 0) {
    throw new TaxError("INVALID_INPUT", "discount must be within 0..order gross");
  }
  const shares =
    discount.amountMinor === 0n || total.amountMinor === 0n
      ? lines.map(() => zero(currency))
      : allocate(discount, lines.map((l) => l.gross.amountMinor));
  return allocateVatWithLineDiscounts(
    lines.map((l, i) => {
      const share = shares[i] ?? zero(currency);
      return funder === "seller" ? { ...l, sellerDiscount: share } : { ...l, platformDiscount: share };
    }),
    config,
  );
}
