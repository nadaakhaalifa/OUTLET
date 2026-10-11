import { divideRoundHalfEven, money, type Money } from "../money";
import { InvalidReturnAllocationError } from "./errors";

/**
 * Pure refund allocation (spec 22, 15.6). Integer piastres only. The single rounding point is
 * `divideRoundHalfEven` (banker's rounding) from money.ts, applied to a cumulative share so that
 * successive partial returns of one line add up to the line's exact total.
 *
 * No money moves here: the result becomes the payload of a `return.refund_intent` event.
 */
export interface LineAllocationInput {
  readonly orderLineId: string;
  readonly qtyOrdered: number;
  readonly unitPrice: Money;
  /** Whole-line voucher and discount share allocated at checkout (order_lines.discount_alloc). */
  readonly discountAlloc: Money;
  /** Whole-line share of the seller order's delivery fee. */
  readonly deliveryFeeAlloc: Money;
  readonly alreadyReturnedQty: number;
  readonly returningQty: number;
  readonly deliveryFeeRefundable: boolean;
}

export interface LineRefundAllocation {
  readonly orderLineId: string;
  readonly qty: number;
  readonly itemAmount: Money;
  readonly voucherShare: Money;
  readonly deliveryFeeShare: Money;
  readonly netAmount: Money;
}

export interface RefundAllocation {
  readonly currency: "EGP";
  readonly lines: readonly LineRefundAllocation[];
  readonly itemTotal: Money;
  readonly voucherTotal: Money;
  readonly deliveryFeeTotal: Money;
  readonly netTotal: Money;
}

/** Share of `total` attributable to the first `k` of `qty` units, rounded half-even once. */
export function cumulativeShare(total: bigint, k: number, qty: number): bigint {
  if (k === 0) return 0n;
  if (k === qty) return total;
  return divideRoundHalfEven(total * BigInt(k), BigInt(qty));
}

function check(l: LineAllocationInput): void {
  const bad = (msg: string): never => {
    throw new InvalidReturnAllocationError(`${l.orderLineId}: ${msg}`);
  };
  for (const n of [l.qtyOrdered, l.alreadyReturnedQty, l.returningQty]) {
    if (!Number.isInteger(n)) bad("quantities must be integers");
  }
  if (l.qtyOrdered < 1) bad("qtyOrdered must be at least 1");
  if (l.returningQty < 1) bad("returningQty must be at least 1");
  if (l.alreadyReturnedQty < 0) bad("alreadyReturnedQty must not be negative");
  if (l.alreadyReturnedQty + l.returningQty > l.qtyOrdered) bad("returned quantity exceeds ordered quantity");
  if (l.unitPrice.currency !== "EGP" || l.discountAlloc.currency !== "EGP" || l.deliveryFeeAlloc.currency !== "EGP") {
    bad("only EGP is supported");
  }
  if (l.unitPrice.amount < 0n || l.discountAlloc.amount < 0n || l.deliveryFeeAlloc.amount < 0n) {
    bad("amounts must not be negative");
  }
  if (l.discountAlloc.amount > l.unitPrice.amount * BigInt(l.qtyOrdered)) bad("discount exceeds the line value");
}

export function allocateRefund(inputs: readonly LineAllocationInput[]): RefundAllocation {
  if (inputs.length === 0) throw new InvalidReturnAllocationError("at least one line is required");
  const lines: LineRefundAllocation[] = [];
  let itemTotal = 0n;
  let voucherTotal = 0n;
  let feeTotal = 0n;
  for (const l of inputs) {
    check(l);
    const p = l.alreadyReturnedQty;
    const upto = p + l.returningQty;
    const item = l.unitPrice.amount * BigInt(l.returningQty);
    const voucher =
      cumulativeShare(l.discountAlloc.amount, upto, l.qtyOrdered) -
      cumulativeShare(l.discountAlloc.amount, p, l.qtyOrdered);
    const fee = l.deliveryFeeRefundable
      ? cumulativeShare(l.deliveryFeeAlloc.amount, upto, l.qtyOrdered) -
        cumulativeShare(l.deliveryFeeAlloc.amount, p, l.qtyOrdered)
      : 0n;
    const net = item - voucher + fee;
    if (net < 0n) throw new InvalidReturnAllocationError(`${l.orderLineId}: negative refund`);
    lines.push({
      orderLineId: l.orderLineId,
      qty: l.returningQty,
      itemAmount: money(item),
      voucherShare: money(voucher),
      deliveryFeeShare: money(fee),
      netAmount: money(net),
    });
    itemTotal += item;
    voucherTotal += voucher;
    feeTotal += fee;
  }
  return {
    currency: "EGP",
    lines,
    itemTotal: money(itemTotal),
    voucherTotal: money(voucherTotal),
    deliveryFeeTotal: money(feeTotal),
    netTotal: money(itemTotal - voucherTotal + feeTotal),
  };
}
