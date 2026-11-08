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
  readonly discount: Money;
  /** what the shopper pays for this line */
  readonly payable: Money;
}
export interface AllocatedOrder {
  readonly lines: readonly AllocatedLine[];
  readonly invoiceVat: Money;
  readonly invoiceNet: Money;
  readonly payableTotal: Money;
}

/**
 * Order-level discount: largest-remainder allocation by gross (ties to lowest index), then VAT is
 * computed ONCE per line (the only rounding), and the invoice VAT is the sum of those line VATs.
 * net/vat/gross on a line describe the taxable base; `payable = gross - discount` is cash.
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
  const reducesBase = funder === "seller" || config.platformFundedDiscountReducesBase;
  const out = lines.map((l, i): AllocatedLine => {
    const share = shares[i] ?? zero(currency);
    const split = splitInclusive(reducesBase ? sub(l.gross, share) : l.gross, l.bps);
    return { ...split, id: l.id, bps: l.bps, discount: share, payable: sub(l.gross, share) };
  });
  const zeroM = zero(currency);
  return {
    lines: out,
    invoiceVat: out.reduce((a, l) => add(a, l.vat), zeroM),
    invoiceNet: out.reduce((a, l) => add(a, l.net), zeroM),
    payableTotal: out.reduce((a, l) => add(a, l.payable), zeroM),
  };
}
