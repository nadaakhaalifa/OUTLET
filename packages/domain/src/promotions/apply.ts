import { InvalidAmountError } from "../errors";
import { allocate, money, percentOfBps } from "../money";
import { capAmounts, splitFunding } from "./funding";
import { applicationOrder } from "./stacking";
import type {
  AppliedPromotion,
  EvalLine,
  LineAllocation,
  Promotion,
  RejectReason,
  ShippingAllocation,
  ShippingFee,
  Usage,
} from "./types";

/** Mutable working state for one evaluation pass over one subset. */
export interface Basket {
  readonly lines: readonly EvalLine[];
  /** List subtotal per line (qty x unit price), before any promotion. */
  readonly listTotals: readonly bigint[];
  /** What each line still costs after the promotions applied so far. */
  readonly remaining: bigint[];
  /** Shipping fee still payable per store. */
  readonly fees: Map<string, bigint>;
}

export function newBasket(lines: readonly EvalLine[], shippingFees: readonly ShippingFee[], isPlus: boolean): Basket {
  const listTotals = lines.map((l) => {
    if (!Number.isInteger(l.qty) || l.qty < 1) throw new InvalidAmountError("qty must be a positive integer");
    if (l.unitPrice.amount < 0n) throw new InvalidAmountError("unit price must not be negative");
    return l.unitPrice.amount * BigInt(l.qty);
  });
  const stores = new Set(lines.map((l) => l.storeId));
  const fees = new Map<string, bigint>();
  for (const s of stores) fees.set(s, 0n);
  for (const f of shippingFees) {
    if (f.fee.amount < 0n) throw new InvalidAmountError("shipping fee must not be negative");
    // Plus delivery is already free: a free-shipping promotion is never added on top (spec 17 edge case).
    if (stores.has(f.storeId)) fees.set(f.storeId, isPlus ? 0n : f.fee.amount);
  }
  return { lines, listTotals, remaining: [...listTotals], fees };
}

export function cloneBasket(b: Basket): Basket {
  return { lines: b.lines, listTotals: b.listTotals, remaining: [...b.remaining], fees: new Map(b.fees) };
}

export function payableOf(b: Basket): bigint {
  let t = 0n;
  for (const r of b.remaining) t += r;
  for (const f of b.fees.values()) t += f;
  return t;
}

/** Time, status, caps, budget, payment method and membership. No basket needed. */
export function gate(
  p: Promotion,
  ctx: { atMs: number; paymentMethod: string | null; isPlus: boolean; usage: Usage | undefined },
): RejectReason | null {
  if (p.status !== "active") return "not_active";
  if (ctx.atMs < p.startsAtMs) return "not_started";
  if (ctx.atMs >= p.endsAtMs) return "expired";
  if (p.targeting.plusOnly && !ctx.isPlus) return "plus_members_only";
  const methods = p.targeting.paymentMethods;
  if (methods.length > 0 && (ctx.paymentMethod === null || !methods.some((m) => m === ctx.paymentMethod))) {
    return "payment_method_not_eligible";
  }
  const u = ctx.usage;
  if (p.perUserCap !== null && (u?.userRedemptions ?? 0) >= p.perUserCap) return "per_user_cap_reached";
  if (p.perDayCap !== null && (u?.dayRedemptions ?? 0) >= p.perDayCap) return "per_day_cap_reached";
  if (p.totalBudget !== null && (u?.spent ?? 0n) >= p.totalBudget.amount) return "budget_exhausted";
  return null;
}

function eligibleIndexes(p: Promotion, b: Basket): number[] {
  const out: number[] = [];
  b.lines.forEach((l, i) => {
    if (p.owner.kind === "store" && l.storeId !== p.owner.storeId) return;
    if (p.targeting.storeIds.length > 0 && !p.targeting.storeIds.includes(l.storeId)) return;
    if (p.targeting.skuIds.length > 0 && !p.targeting.skuIds.includes(l.skuId)) return;
    out.push(i);
  });
  return out;
}

/** Groups line indexes by store. Groups are independent (disjoint lines), so map order never matters. */
function groupByStore(idx: readonly number[], b: Basket): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const i of idx) {
    const s = b.lines[i]?.storeId ?? "";
    m.set(s, [...(m.get(s) ?? []), i]);
  }
  return m;
}

const at = (xs: readonly bigint[], i: number): bigint => xs[i] ?? 0n;

function tierPercent(p: Promotion, listSubtotal: bigint): number | null {
  if (p.value.kind !== "tiered") return null;
  let bps: number | null = null;
  for (const t of p.value.tiers) if (listSubtotal >= t.minSubtotal.amount) bps = t.percentBps;
  return bps;
}

export interface PromoAmounts {
  /** Discount per line index. */
  readonly lines: readonly bigint[];
  /** Shipping discount per store. */
  readonly shipping: ReadonlyMap<string, bigint>;
  /** Why nothing was discounted, when total is zero. */
  readonly emptyReason: RejectReason | null;
}

/** Per-line discount of an item-scope promotion, before caps. */
function itemDiscount(p: Promotion, line: EvalLine, remaining: bigint): bigint {
  const v = p.value;
  switch (v.kind) {
    case "percent":
      return percentOfBps(money(remaining), BigInt(v.percentBps)).amount;
    case "fixed":
      return v.amount.amount * BigInt(line.qty);
    case "bogo": {
      const freeUnits = Math.floor(line.qty / (v.buyQty + v.getQty)) * v.getQty;
      return percentOfBps(line.unitPrice, BigInt(v.getPercentBps)).amount * BigInt(freeUnits);
    }
    default:
      return 0n;
  }
}

/** Discount of a store- or order-scope promotion on one group, before caps. Null: tier not reached. */
function groupDiscount(p: Promotion, base: bigint, listSubtotal: bigint): bigint | null {
  const v = p.value;
  switch (v.kind) {
    case "percent":
      return percentOfBps(money(base), BigInt(v.percentBps)).amount;
    case "fixed":
      return v.amount.amount;
    case "tiered": {
      const bps = tierPercent(p, listSubtotal);
      return bps === null ? null : percentOfBps(money(base), BigInt(bps)).amount;
    }
    default:
      return 0n;
  }
}

/** Discount a promotion gives against the current basket state (before the max-discount and budget cap). */
function rawAmounts(p: Promotion, b: Basket): PromoAmounts {
  const lines = b.lines.map(() => 0n);
  const shipping = new Map<string, bigint>();
  const eligible = eligibleIndexes(p, b);
  if (eligible.length === 0) return { lines, shipping, emptyReason: "no_eligible_lines" };
  const minOrder = p.minOrder?.amount ?? 0n;
  const listOf = (idx: readonly number[]): bigint => idx.reduce((s, i) => s + at(b.listTotals, i), 0n);
  let minOrderFailed = false;

  const distribute = (idx: readonly number[], amount: bigint): void => {
    const room = idx.reduce((s, i) => s + at(b.remaining, i), 0n);
    if (room <= 0n) return;
    const d = amount < room ? amount : room;
    const parts = allocate(money(d), idx.map((i) => at(b.remaining, i)));
    idx.forEach((lineIndex, k) => {
      lines[lineIndex] = (lines[lineIndex] ?? 0n) + (parts[k]?.amount ?? 0n);
    });
  };

  if (p.scope === "item") {
    if (listOf(eligible) < minOrder) return { lines, shipping, emptyReason: "min_order_not_met" };
    for (const i of eligible) {
      const line = b.lines[i];
      if (line === undefined) continue;
      const rem = at(b.remaining, i);
      const d = itemDiscount(p, line, rem);
      lines[i] = d < rem ? d : rem;
    }
  } else if (p.scope === "shipping") {
    for (const [storeId, idx] of groupByStore(eligible, b)) {
      if (listOf(idx) < minOrder) {
        minOrderFailed = true;
        continue;
      }
      const fee = b.fees.get(storeId) ?? 0n;
      if (fee > 0n) shipping.set(storeId, fee);
    }
  } else {
    const groups = p.scope === "store" ? groupByStore(eligible, b) : new Map([["order", eligible]]);
    for (const idx of groups.values()) {
      const list = listOf(idx);
      if (list < minOrder) {
        minOrderFailed = true;
        continue;
      }
      const base = idx.reduce((s, i) => s + at(b.remaining, i), 0n);
      const d = groupDiscount(p, base, list);
      if (d === null) {
        minOrderFailed = true;
        continue;
      }
      distribute(idx, d);
    }
  }

  const any = lines.some((x) => x > 0n) || shipping.size > 0;
  return { lines, shipping, emptyReason: any ? null : minOrderFailed ? "min_order_not_met" : "no_discount" };
}

/** Applies the cap (max discount and remaining budget) to a raw result, line and shipping together. */
function capped(p: Promotion, raw: PromoAmounts, spent: bigint): PromoAmounts {
  let cap: bigint | null = p.maxDiscount?.amount ?? null;
  if (p.totalBudget !== null) {
    const left = p.totalBudget.amount - spent;
    // Stryker disable next-line EqualityOperator: equal values pick the same cap.
    cap = cap === null || left < cap ? left : cap;
  }
  if (cap === null) return raw;
  const storeIds = [...raw.shipping.keys()].sort();
  const flat = [...raw.lines, ...storeIds.map((s) => raw.shipping.get(s) ?? 0n)];
  const out = capAmounts(flat, cap);
  const shipping = new Map<string, bigint>();
  storeIds.forEach((s, k) => shipping.set(s, out[raw.lines.length + k] ?? 0n));
  return { lines: out.slice(0, raw.lines.length), shipping, emptyReason: raw.emptyReason };
}

export function amountsFor(p: Promotion, b: Basket, usage: Usage | undefined): PromoAmounts {
  return capped(p, rawAmounts(p, b), usage?.spent ?? 0n);
}

/**
 * Applies the set in the fixed evaluation order against a copy of the basket. Returns the applied
 * promotions (with per-line funding) and the final basket.
 */
export function applySet(
  set: readonly Promotion[],
  start: Basket,
  usage: ReadonlyMap<string, Usage>,
): { applied: AppliedPromotion[]; basket: Basket } {
  const basket = cloneBasket(start);
  const applied: AppliedPromotion[] = [];
  for (const p of applicationOrder(set)) {
    const amounts = amountsFor(p, basket, usage.get(p.id));
    const lineAllocs: LineAllocation[] = [];
    amounts.lines.forEach((amount, lineIndex) => {
      if (amount <= 0n) return;
      basket.remaining[lineIndex] = at(basket.remaining, lineIndex) - amount;
      lineAllocs.push({ lineIndex, ...splitFunding(amount, p.funding) });
    });
    const shipAllocs: ShippingAllocation[] = [];
    for (const storeId of [...amounts.shipping.keys()].sort()) {
      const amount = amounts.shipping.get(storeId) ?? 0n;
      if (amount <= 0n) continue;
      basket.fees.set(storeId, (basket.fees.get(storeId) ?? 0n) - amount);
      shipAllocs.push({ storeId, ...splitFunding(amount, p.funding) });
    }
    const parts = [...lineAllocs, ...shipAllocs];
    if (parts.length === 0) continue;
    applied.push({
      promotionId: p.id,
      promotionVersion: p.version,
      code: p.code,
      scope: p.scope,
      display: "voucher_minus",
      amount: parts.reduce((s, x) => s + x.amount, 0n),
      platformFunded: parts.reduce((s, x) => s + x.platformFunded, 0n),
      sellerFunded: parts.reduce((s, x) => s + x.sellerFunded, 0n),
      lines: lineAllocs,
      shipping: shipAllocs,
    });
  }
  return { applied, basket };
}
