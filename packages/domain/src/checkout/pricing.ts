import { planStoreCreditSpend, type SubBalanceState } from "../chart-of-accounts/spend";
import { vatIncluded } from "../chart-of-accounts/builders";
import { money, type Money } from "../money";
import type { EvaluationResult, ShippingFee } from "../promotions/types";
import { InvalidCheckoutError } from "./errors";
import type {
  CheckoutLine,
  CheckoutMethod,
  CheckoutQuote,
  QuoteLine,
  StoreQuote,
  StoreTermsForCheckout,
  TenderPlan,
} from "./types";

const ZERO = money(0n);

export interface ShippingWaiver {
  readonly fees: readonly ShippingFee[];
  readonly reasons: ReadonlyMap<string, "plus" | "threshold" | "none">;
}

/** Item-scope promotion value per store, from the first evaluation pass. */
export function itemDiscountByStore(result: EvaluationResult, lines: readonly CheckoutLine[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const a of result.applied) {
    if (a.scope !== "item") continue;
    for (const alloc of a.lines) {
      const line = lines[alloc.lineIndex];
      if (line === undefined) continue;
      out.set(line.storeId, (out.get(line.storeId) ?? 0n) + alloc.amount);
    }
  }
  return out;
}

/**
 * Delivery fee per store before shipping promotions (spec 6). Plus waives every fee. Otherwise the
 * threshold applies to merchandise after item-level discounts and before vouchers.
 */
export function shippingBeforePromotions(input: {
  readonly lines: readonly CheckoutLine[];
  readonly stores: ReadonlyMap<string, StoreTermsForCheckout>;
  readonly itemDiscounts: ReadonlyMap<string, bigint>;
  readonly plus: boolean;
}): ShippingWaiver {
  const storeIds = [...new Set(input.lines.map((l) => l.storeId))].sort();
  const fees: ShippingFee[] = [];
  const reasons = new Map<string, "plus" | "threshold" | "none">();
  for (const storeId of storeIds) {
    const terms = input.stores.get(storeId);
    if (terms === undefined) throw new InvalidCheckoutError(`no delivery terms for store ${storeId}`);
    const merch = input.lines
      .filter((l) => l.storeId === storeId)
      .reduce((a, l) => a + l.unitPrice.amount * BigInt(l.qty), 0n);
    const net = merch - (input.itemDiscounts.get(storeId) ?? 0n);
    if (input.plus) {
      fees.push({ storeId, fee: ZERO });
      reasons.set(storeId, "plus");
    } else if (terms.freeDeliveryThreshold !== null && net >= terms.freeDeliveryThreshold.amount) {
      fees.push({ storeId, fee: ZERO });
      reasons.set(storeId, "threshold");
    } else {
      fees.push({ storeId, fee: terms.standardDeliveryFee });
      reasons.set(storeId, "none");
    }
  }
  return { fees, reasons };
}

/**
 * Split tender: store credit first (spend order from the chart), one external method for the rest.
 * Cash on delivery never combines with store credit (ledger recognition for COD happens at delivery).
 */
export function planTender(input: {
  readonly total: Money;
  readonly method: CheckoutMethod;
  readonly useStoreCredit: boolean;
  readonly balances: readonly SubBalanceState[];
}): TenderPlan {
  if (input.total.amount < 0n) throw new InvalidCheckoutError("negative total");
  const available = input.balances.reduce((a, b) => a + (b.balance.amount > 0n ? b.balance.amount : 0n), 0n);
  const wanted =
    input.useStoreCredit && input.method !== "cod" && input.total.amount > 0n
      ? available < input.total.amount
        ? available
        : input.total.amount
      : 0n;
  if (wanted === 0n) return { storeCredit: [], storeCreditTotal: ZERO, externalDue: input.total };
  const plan = planStoreCreditSpend(input.balances, money(wanted));
  return {
    storeCredit: plan.map((p) => ({ sub: p.sub, amount: p.amount })),
    storeCreditTotal: money(wanted),
    externalDue: money(input.total.amount - wanted),
  };
}

export interface AssembleInput {
  readonly method: CheckoutMethod;
  readonly lines: readonly CheckoutLine[];
  readonly evaluation: EvaluationResult;
  readonly shippingReasons: ReadonlyMap<string, "plus" | "threshold" | "none">;
  readonly deliveryFees: ReadonlyMap<string, Money>;
  /** VAT per bag line id, from the tax port (already net of order-level discount). */
  readonly lineVat: ReadonlyMap<string, Money>;
  readonly vatBps: bigint;
  readonly balances: readonly SubBalanceState[];
  readonly useStoreCredit: boolean;
}

/** Pure assembly of the final quote from the engines' outputs. Fails closed on any inconsistency. */
export function assembleQuote(input: AssembleInput): CheckoutQuote {
  const { evaluation: ev, lines } = input;
  if (lines.length === 0) throw new InvalidCheckoutError("empty checkout");
  if (ev.lines.length !== lines.length) throw new InvalidCheckoutError("evaluation does not match lines");

  const quoteLines: QuoteLine[] = lines.map((l, i) => {
    const r = ev.lines[i];
    if (r === undefined || r.lineIndex !== i) throw new InvalidCheckoutError("evaluation line order mismatch");
    if (r.subtotal !== l.unitPrice.amount * BigInt(l.qty)) {
      throw new InvalidCheckoutError("evaluation subtotal differs from server price");
    }
    const vat = input.lineVat.get(l.lineId);
    if (vat === undefined) throw new InvalidCheckoutError(`no tax for line ${l.lineId}`);
    return {
      lineId: l.lineId,
      skuId: l.skuId,
      productId: l.productId,
      storeId: l.storeId,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discount: money(r.discount),
      vat,
    };
  });

  const funding = new Map<string, { platform: bigint; seller: bigint }>();
  for (const a of ev.applied) {
    for (const alloc of a.lines) {
      const line = lines[alloc.lineIndex];
      if (line === undefined) throw new InvalidCheckoutError("allocation outside lines");
      const f = funding.get(line.storeId) ?? { platform: 0n, seller: 0n };
      funding.set(line.storeId, {
        platform: f.platform + alloc.platformFunded,
        seller: f.seller + alloc.sellerFunded,
      });
    }
  }

  const shipByStore = new Map(ev.shipping.map((s) => [s.storeId, s]));
  const storeIds = [...new Set(lines.map((l) => l.storeId))].sort();
  const stores: StoreQuote[] = storeIds.map((storeId) => {
    const own = quoteLines.filter((l) => l.storeId === storeId);
    const merchandise = own.reduce((a, l) => a + l.unitPrice.amount * BigInt(l.qty), 0n);
    const discount = own.reduce((a, l) => a + l.discount.amount, 0n);
    const f = funding.get(storeId) ?? { platform: 0n, seller: 0n };
    if (f.platform + f.seller !== discount) {
      throw new InvalidCheckoutError(`funding split ${f.platform + f.seller} differs from discount ${discount}`);
    }
    if (discount > merchandise) throw new InvalidCheckoutError("discount exceeds merchandise");
    const ship = shipByStore.get(storeId);
    if (ship === undefined) throw new InvalidCheckoutError(`no shipping result for ${storeId}`);
    const baseReason = input.shippingReasons.get(storeId) ?? "none";
    const reason: StoreQuote["freeDeliveryReason"] =
      baseReason !== "none" ? baseReason : ship.fee > 0n && ship.payable === 0n ? "promotion" : "none";
    const shipping = money(ship.payable);
    const shipVat = shipping.amount === 0n ? 0n : vatIncluded(shipping, input.vatBps).amount;
    const vat = own.reduce((a, l) => a + l.vat.amount, 0n) + shipVat;
    return {
      storeId,
      merchandise: money(merchandise),
      platformFundedDiscount: money(f.platform),
      sellerFundedDiscount: money(f.seller),
      deliveryFee: input.deliveryFees.get(storeId) ?? money(ship.fee),
      shipping,
      freeDeliveryReason: reason,
      vat: money(vat),
      total: money(merchandise - discount + shipping.amount),
    };
  });

  const sum = (f: (s: StoreQuote) => bigint): Money => money(stores.reduce((a, s) => a + f(s), 0n));
  const total = sum((s) => s.total.amount);
  const tender = planTender({
    total,
    method: input.method,
    useStoreCredit: input.useStoreCredit,
    balances: input.balances,
  });
  return {
    method: input.method,
    lines: quoteLines,
    stores,
    subtotal: sum((s) => s.merchandise.amount),
    discount: sum((s) => s.platformFundedDiscount.amount + s.sellerFundedDiscount.amount),
    shipping: sum((s) => s.shipping.amount),
    vat: sum((s) => s.vat.amount),
    total,
    tender,
    vatBps: input.vatBps,
  };
}

/** Deterministic text form of a quote, for hashing (price-lock tokens, saga request hash). */
export function canonicalQuote(q: CheckoutQuote): string {
  const parts: string[] = [q.method, String(q.total.amount), String(q.tender.storeCreditTotal.amount)];
  for (const l of q.lines) parts.push(`${l.skuId}:${l.qty}:${l.unitPrice.amount}:${l.discount.amount}`);
  for (const s of q.stores) parts.push(`${s.storeId}:${s.shipping.amount}:${s.total.amount}`);
  return parts.join("|");
}
