import { allocate, money, type Money } from "../money";
import { InvalidTaxInputError } from "./errors";
import { effectiveRateBps, type TaxCategory } from "./exemptions";
import { splitVatInclusive } from "./vat";

export interface TaxLineInput {
  readonly id: string;
  /** VAT-inclusive unit price in piastres, before any order-level discount. */
  readonly unitGross: Money;
  readonly qty: number;
  readonly categoryCode: string;
}

export interface TaxedLine {
  readonly id: string;
  readonly categoryCode: string;
  readonly rateBps: bigint;
  readonly exempt: boolean;
  readonly grossBeforeDiscount: Money;
  readonly discountShare: Money;
  readonly net: Money;
  readonly vat: Money;
  readonly gross: Money;
}

export interface OrderTax {
  readonly lines: readonly TaxedLine[];
  readonly totals: {
    readonly grossBeforeDiscount: Money;
    readonly discount: Money;
    readonly net: Money;
    readonly vat: Money;
    readonly gross: Money;
  };
}

export interface ComputeOrderTaxInput {
  readonly lines: readonly TaxLineInput[];
  /** Order-level discount (vouchers, platform promos), VAT-inclusive, non-negative. Spread across lines. */
  readonly orderDiscount: Money;
  readonly categories: ReadonlyMap<string, TaxCategory>;
  readonly atMs: number;
}

/**
 * Computes line-level net/vat/gross for an order.
 *
 * 1. Each line's gross is `unitGross * qty`.
 * 2. The order discount is allocated across lines by line gross with the largest-remainder
 *    method (`allocate`), so the shares sum exactly to the discount: no piastre is lost.
 * 3. Each discounted line gross is split once, half-even (`splitVatInclusive`), at the line's
 *    effective rate. VAT is derived by subtraction, so `net + vat == gross` per line, and the
 *    order totals are the plain sums of the line values.
 *
 * Default base for platform-funded discounts: VAT is computed on the post-discount price paid
 * by the shopper (VERIFY BEFORE LAUNCH, register VR-B4-04).
 */
export function computeOrderTax(input: ComputeOrderTaxInput): OrderTax {
  if (input.lines.length === 0) throw new InvalidTaxInputError("an order needs at least one line");
  if (input.orderDiscount.amount < 0n) throw new InvalidTaxInputError("discount must not be negative");
  const seen = new Set<string>();
  const subtotals: Money[] = [];
  for (const l of input.lines) {
    if (seen.has(l.id)) throw new InvalidTaxInputError(`duplicate line id ${l.id}`);
    seen.add(l.id);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 100_000) throw new InvalidTaxInputError("qty must be an integer between 1 and 100000");
    if (l.unitGross.amount < 0n) throw new InvalidTaxInputError("unit price must not be negative");
    subtotals.push(money(l.unitGross.amount * BigInt(l.qty), l.unitGross.currency));
  }
  const merchandise = subtotals.reduce((s, m) => s + m.amount, 0n);
  if (input.orderDiscount.amount > merchandise) throw new InvalidTaxInputError("discount exceeds the merchandise total");
  const shares =
    input.orderDiscount.amount === 0n || merchandise === 0n
      ? subtotals.map(() => money(0n))
      : allocate(input.orderDiscount, subtotals.map((s) => s.amount));

  const taxed: TaxedLine[] = input.lines.map((l, i) => {
    const cat = input.categories.get(l.categoryCode);
    if (cat === undefined) throw new InvalidTaxInputError(`unknown tax category ${l.categoryCode}`);
    const before = subtotals[i] ?? money(0n);
    const share = shares[i] ?? money(0n);
    const gross = money(before.amount - share.amount);
    const rate = effectiveRateBps(cat, input.atMs);
    const split = splitVatInclusive(gross, rate);
    return {
      id: l.id,
      categoryCode: l.categoryCode,
      rateBps: rate,
      exempt: rate === 0n && cat.rateBps !== 0n,
      grossBeforeDiscount: before,
      discountShare: share,
      net: split.net,
      vat: split.vat,
      gross,
    };
  });
  const sum = (pick: (l: TaxedLine) => Money): Money => money(taxed.reduce((s, l) => s + pick(l).amount, 0n));
  return {
    lines: taxed,
    totals: {
      grossBeforeDiscount: sum((l) => l.grossBeforeDiscount),
      discount: sum((l) => l.discountShare),
      net: sum((l) => l.net),
      vat: sum((l) => l.vat),
      gross: sum((l) => l.gross),
    },
  };
}
