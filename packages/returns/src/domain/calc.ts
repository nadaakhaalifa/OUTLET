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

/** Largest shortfall (piastres) of a differenced refund the platform absorbs as rounding; beyond it the refund is a configuration error. */
export const MAX_ABSORBED_ROUNDING_MINOR = 2n;

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
  let commission = c(before) - c(after);
  let commissionVat = v(c(before)) - v(c(after));
  let seller = goods - commission - commissionVat;
  if (seller < 0n) {
    // Cumulative differencing can overshoot by 1-2 piastres on tiny steps. CPL 181/2018: never refuse a refund for it; the platform
    // absorbs the rounding piastre (VAT first, then commission) so seller = 0 and the refund CHECKs still hold.
    let short = -seller;
    if (short > MAX_ABSORBED_ROUNDING_MINOR) throw new ReturnsError("seller_net_negative"); // a real misconfiguration (commission + VAT above the goods), not rounding
    const dv = short < commissionVat ? short : commissionVat;
    commissionVat -= dv; short -= dv;
    commission -= short;
    seller = 0n;
  }

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

/** One cancelled seller order as stored at placement (seller_orders snapshot, piastres). */
export interface CancelledSellerOrder {
  readonly currency: Currency;
  /** What the shopper paid for this seller order: items - platform discount - seller discount + delivery. */
  readonly total: bigint;
  readonly shipping: bigint;
  readonly shippingVat: bigint;
  readonly commission: bigint;
  readonly commissionVat: bigint;
  /** seller_net_minor: what order_recognised credited to seller_pending. */
  readonly sellerNet: bigint;
  /** platform_discount_minor: what order_recognised debited to promo_expense_platform. */
  readonly platformDiscount: bigint;
  /**
   * Discount on the delivery fee (platform + seller funded): seller order discounts minus the order lines' discounts. The shopper paid
   * `shipping - deliveryDiscount` for delivery, which is what the refund row reports as delivery fee (L2). Default 0.
   */
  readonly deliveryDiscount?: bigint;
}

export interface CancellationAmounts {
  /** The refund row (refunds CHECKs: amount = goods + fee, goods = seller + commission + commission VAT, every part >= 0). */
  readonly refund: {
    readonly amount: Money; readonly goods: Money; readonly deliveryFee: Money; readonly deliveryVat: Money;
    readonly commission: Money; readonly commissionVat: Money; readonly seller: Money;
  };
  /**
   * What the refund entry does not reverse, posted with the refund row (key cancel_adjust:{seller order}): debits seller_pending,
   * commission revenue, VAT output and delivery revenue; credits promo_expense_platform. Its debits always sum to the platform discount.
   */
  readonly residual: { readonly seller: bigint; readonly commission: bigint; readonly vat: bigint; readonly shippingNet: bigint; readonly platformPromo: bigint };
}

/**
 * Ledger spec 4.1 reversed by differencing for a WHOLE seller order cancelled before shipping. The refund entry (refundDraft) gives the
 * shopper back exactly `total`; the residual entry reverses the rest of the seller order's share of order_recognised (the platform-funded
 * discount, which a return keeps, and any delivery discount). Together they negate that share exactly, so seller_pending, commission,
 * VAT output, delivery revenue and promo expense return to their pre-order values and the trial balance stays 0. Pure, integer only.
 */
export function cancellationAmounts(i: CancelledSellerOrder): CancellationAmounts {
  const deliveryDiscount = i.deliveryDiscount ?? 0n;
  const nonNeg = [i.total, i.shipping, i.shippingVat, i.commission, i.commissionVat, i.sellerNet, i.platformDiscount, deliveryDiscount];
  if (nonNeg.some((x) => x < 0n) || i.shippingVat > i.shipping || deliveryDiscount > i.shipping) throw new ReturnsError("refund_exceeds_paid", "seller order amounts are inconsistent");
  const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
  // delivery the shopper actually paid, and the VAT inside it (floor, proportional); the residual entry reverses the rest
  const fee = min(i.shipping - deliveryDiscount, i.total);
  const feeVat = i.shipping === 0n ? 0n : min((i.shippingVat * fee) / i.shipping, fee);
  const goods = i.total - fee;
  const commission = min(i.commission, goods);
  const commissionVat = min(i.commissionVat, goods - commission);
  const seller = goods - commission - commissionVat;
  const residual = {
    seller: i.sellerNet - seller,
    commission: i.commission - commission,
    vat: i.commissionVat - commissionVat + (i.shippingVat - feeVat),
    shippingNet: i.shipping - i.shippingVat - (fee - feeVat),
    platformPromo: i.platformDiscount,
  };
  const debits = residual.seller + residual.commission + residual.vat + residual.shippingNet;
  // residual.seller may be negative (a seller-funded delivery waiver larger than the platform goods discount): refund + residual stay exact.
  if (residual.commission < 0n || residual.vat < 0n || residual.shippingNet < 0n || debits !== residual.platformPromo) {
    throw new ReturnsError("refund_exceeds_paid", "seller order snapshot does not match its order_recognised share");
  }
  const m = (x: bigint): Money => money(x, i.currency);
  return {
    refund: { amount: m(i.total), goods: m(goods), deliveryFee: m(fee), deliveryVat: m(feeVat), commission: m(commission), commissionVat: m(commissionVat), seller: m(seller) },
    residual,
  };
}
