import { allocate, fraction, money, percentOf } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { ReturnsError } from "./errors.js";

/** One returned order line. `discount` is the line's total platform + seller discount (order_lines columns). */
export interface ReturnedLine {
  readonly orderLineId: string;
  readonly unitPrice: bigint;
  readonly qty: number;
  readonly qtyAlreadyReturned: number;
  readonly returnQty: number;
  readonly discount: bigint;
}

export interface CalcInput {
  readonly currency: Currency;
  readonly lines: readonly ReturnedLine[];
  /** Commission base of the seller order: items - platform discount - seller discount. */
  readonly base: bigint;
  /** Sum of goods already refunded on this seller order (net of discount shares). */
  readonly goodsRefundedBefore: bigint;
  readonly commissionBp: number;
  readonly commissionVatBp: number;
  /** Delivery fee (VAT-inclusive) to give back now, or null (only when the seller is at fault, or whole order within 7 days). */
  readonly delivery: { readonly gross: bigint; readonly vat: bigint } | null;
}

export interface LineAllocation {
  readonly orderLineId: string;
  readonly qty: number;
  readonly gross: bigint;
  readonly discountShare: bigint;
  readonly amount: bigint;
  readonly commission: bigint;
  readonly commissionVat: bigint;
}

export interface RefundCalc {
  readonly lines: readonly LineAllocation[];
  readonly goods: Money;
  readonly deliveryFee: Money;
  readonly deliveryVat: Money;
  readonly total: Money;
  readonly commission: Money;
  readonly commissionVat: Money;
  readonly seller: Money;
}

/** Cumulative voucher share for the first k units of a line (floor, so the shares of any partition sum exactly to the discount). */
export const cumulativeDiscount = (discount: bigint, qty: number, k: number): bigint => (discount * BigInt(k)) / BigInt(qty);

/**
 * Ledger spec 4.5: commission and its VAT are computed on the REMAINING base before and after the refund and differenced, so any
 * sequence of partial refunds sums exactly to the original (I10). Voucher share is proportional per unit (floor-cumulative);
 * the delivery fee is included only when the caller says the seller is at fault. All rounding is banker's, in @outlet/money.
 */
export function computeRefund(i: CalcInput): RefundCalc {
  const cur = i.currency;
  const lines: LineAllocation[] = i.lines.map((l) => {
    if (l.returnQty < 1) throw new ReturnsError("nothing_to_return");
    if (l.qtyAlreadyReturned + l.returnQty > l.qty) throw new ReturnsError("qty_exceeds_purchased");
    const gross = fraction(money(l.unitPrice, i.currency), BigInt(l.returnQty), 1n).amountMinor;
    const share = cumulativeDiscount(l.discount, l.qty, l.qtyAlreadyReturned + l.returnQty) - cumulativeDiscount(l.discount, l.qty, l.qtyAlreadyReturned);
    return { orderLineId: l.orderLineId, qty: l.returnQty, gross, discountShare: share, amount: gross - share, commission: 0n, commissionVat: 0n };
  });
  const goods = lines.reduce((a, l) => a + l.amount, 0n);
  const before = i.base - i.goodsRefundedBefore;
  const after = before - goods;
  if (after < 0n) throw new ReturnsError("refund_exceeds_paid");
  const c = (x: bigint): bigint => percentOf(money(x, cur), BigInt(i.commissionBp)).amountMinor;
  const v = (x: bigint): bigint => percentOf(money(x, cur), BigInt(i.commissionVatBp)).amountMinor;
  const commission = c(before) - c(after);
  const commissionVat = v(c(before)) - v(c(after));
  const seller = goods - commission - commissionVat;
  if (seller < 0n) throw new ReturnsError("seller_net_negative");

  let withShares = lines;
  if (goods > 0n && commission + commissionVat > 0n) {
    const comm = allocate(money(commission, cur), lines.map((l) => l.amount));
    const vat = allocate(money(commissionVat, cur), lines.map((l) => l.amount));
    withShares = lines.map((l, idx) => ({ ...l, commission: comm[idx]?.amountMinor ?? 0n, commissionVat: vat[idx]?.amountMinor ?? 0n }));
  }
  const fee = i.delivery?.gross ?? 0n;
  const feeVat = i.delivery?.vat ?? 0n;
  return {
    lines: withShares, goods: money(goods, cur), deliveryFee: money(fee, cur), deliveryVat: money(feeVat, cur), total: money(goods + fee, cur),
    commission: money(commission, cur), commissionVat: money(commissionVat, cur), seller: money(seller, cur),
  };
}

/**
 * Split of one refund between the store-credit tender and the external tender, by cumulative differencing on the group's tender
 * ratio (same trick as 4.5), so repeated partial refunds never over- or under-pay either tender.
 */
export function tenderSplit(refund: Money, alreadyRefunded: bigint, creditPaid: bigint, externalPaid: bigint): { credit: Money; external: Money } {
  const grand = creditPaid + externalPaid;
  if (grand <= 0n || alreadyRefunded + refund.amountMinor > grand) throw new ReturnsError("refund_exceeds_paid");
  const cum = (x: bigint): bigint => fraction(money(x, refund.currency), creditPaid, grand).amountMinor;
  const credit = cum(alreadyRefunded + refund.amountMinor) - cum(alreadyRefunded);
  return { credit: money(credit, refund.currency), external: money(refund.amountMinor - credit, refund.currency) };
}
