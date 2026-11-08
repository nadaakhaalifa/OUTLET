import { allocate, fraction, money, percentOf } from "@outlet/money";
import type { Money } from "@outlet/money";
import { PromotionError } from "./errors.js";
import { requiresCode } from "./rules.js";
import type { Level, StackingClass } from "./rules.js";
import type {
  AppliedPromotion, EvalBag, EvalContext, EvalLine, EvaluationResult, LineDiscount, LineResult, PromotionCandidate, RejectReason, ShippingDiscount, StoreResult, UsageMap,
} from "./types.js";

const LEVEL_RANK: Record<Level, number> = { item: 0, store: 1, order: 2, shipping: 3, payment_partner: 4 };
const CLASS_RANK: Record<StackingClass, number> = { auto: 0, store_voucher: 1, platform_code: 2, payment_partner: 3 };
const MAX_CANDIDATES = 5;
const minB = (a: bigint, b: bigint): bigint => (a < b ? a : b);
// eslint-disable-next-line district/no-float-money -- exact bigint multiplication of a VAT-inclusive unit price by an integer quantity; no rounding happens here
export const lineGrossMinor = (l: Pick<EvalLine, "unitMinor" | "qty">): bigint => l.unitMinor * BigInt(l.qty);
const lineGross = lineGrossMinor;

const allLines = (bag: EvalBag): EvalLine[] => bag.stores.flatMap((s) => [...s.lines]);

/** Lines a promotion may touch: its store (if any) and its targeting. Sorted by id for determinism. */
const eligibleLines = (c: PromotionCandidate, bag: EvalBag): EvalLine[] => {
  const t = c.rules.targeting;
  return allLines(bag)
    .filter((l) => (c.storeId === null || l.storeId === c.storeId)
      && (t.storeIds === undefined || t.storeIds.includes(l.storeId))
      && (t.categoryIds === undefined || (l.categoryId !== undefined && t.categoryIds.includes(l.categoryId)))
      && (t.productIds === undefined || t.productIds.includes(l.productId)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
};

const NO_USAGE = { userUses: 0, totalUses: 0, usedMinor: 0n };

/** null = eligible. Pure; reads only the bag, the context, the candidate and the usage snapshot. */
export const rejectReason = (c: PromotionCandidate, ctx: EvalContext, bag: EvalBag, usage: UsageMap): RejectReason | null => {
  const t = c.rules.targeting;
  if (c.status !== "ACTIVE") return "inactive";
  if (ctx.now < c.startsAt) return "not_started";
  if (ctx.now >= c.endsAt) return "ended";
  if (c.currency !== bag.currency) return "currency_mismatch";
  if (c.type === "first_order" && !ctx.isFirstOrder) return "not_first_order";
  if (c.type === "birthday" && !ctx.birthdayToday) return "not_birthday";
  if (c.type === "win_back" && (ctx.daysSinceLastOrder === null || ctx.daysSinceLastOrder < (t.minDaysSinceLastOrder ?? 60))) return "win_back_window";
  if (t.plusOnly === true && !ctx.isPlus) return "plus_only";
  if (t.segments !== undefined && !t.segments.some((s) => ctx.segments.includes(s))) return "segment";
  if (t.tiers !== undefined && (ctx.tier === null || !t.tiers.includes(ctx.tier))) return "tier";
  if (t.cities !== undefined && (ctx.city === null || !t.cities.includes(ctx.city))) return "city";
  if (t.paymentMethods !== undefined && (ctx.paymentMethod === null || !t.paymentMethods.includes(ctx.paymentMethod))) return "payment_method";
  const u = usage.get(c.id) ?? NO_USAGE;
  if (c.perUserLimit !== null && u.userUses >= c.perUserLimit) return "per_user_limit";
  if (c.totalLimit !== null && u.totalUses >= c.totalLimit) return "total_limit";
  if (c.budgetMinor !== null && u.usedMinor >= c.budgetMinor) return "budget_exhausted";
  const lines = eligibleLines(c, bag);
  if (lines.length === 0) return "no_eligible_lines";
  if (c.type === "store_follower") {
    const stores = new Set(lines.map((l) => l.storeId));
    if (![...stores].some((s) => ctx.followedStoreIds.includes(s))) return "not_follower";
  }
  if (c.minOrderMinor !== null && lines.reduce((a, l) => a + lineGross(l), 0n) < c.minOrderMinor) return "min_order";
  return null;
};

/** stacking matrix: at most one platform code, one payment-partner offer, one store voucher per store; auto promos unlimited. */
export const validateStacking = (selected: readonly PromotionCandidate[]): void => {
  const ids = new Set<string>();
  const perClass = new Map<string, number>();
  for (const c of selected) {
    if (ids.has(c.id)) throw new PromotionError("STACKING_VIOLATION", `promotion ${c.id} selected twice`);
    ids.add(c.id);
    if (c.stackingClass === "auto") continue;
    const key = c.stackingClass === "store_voucher" ? `store_voucher:${c.storeId ?? ""}` : c.stackingClass;
    const n = (perClass.get(key) ?? 0) + 1;
    if (n > 1) throw new PromotionError("STACKING_VIOLATION", `more than one ${key}`);
    perClass.set(key, n);
  }
};

interface LineState { gross: bigint; remaining: bigint; platform: bigint; seller: bigint }
interface ShipState { fee: bigint; remaining: bigint; platform: bigint; seller: bigint }

interface Raw { readonly total: bigint; readonly weights: readonly (readonly [string, bigint])[] }

const rawPercentOrFixed = (kind: "percent" | "fixed", value: bigint | number, base: bigint): bigint =>
  kind === "percent" ? percentOf(money(base, "EGP"), BigInt(value)).amountMinor : minB(BigInt(value), base);

/** Raw (uncapped) discount for line-level promotions, with the weights used to spread the capped total over lines. */
const rawLineDiscount = (c: PromotionCandidate, lines: readonly EvalLine[], st: Map<string, LineState>): Raw => {
  const d = c.rules.discount;
  const rem = (l: EvalLine): bigint => must(st, l.id).remaining;
  const base = lines.reduce((a, l) => a + rem(l), 0n);
  const prop = (total: bigint): Raw => ({ total, weights: lines.map((l) => [l.id, rem(l)] as const) });
  switch (d.kind) {
    case "percent":
      return prop(rawPercentOrFixed("percent", d.bps, base));
    case "fixed":
      return prop(rawPercentOrFixed("fixed", BigInt(d.amountMinor), base));
    case "tiered": {
      const orig = lines.reduce((a, l) => a + lineGross(l), 0n);
      let bpsHit = 0;
      for (const tier of d.tiers) if (orig >= BigInt(tier.minSubtotalMinor)) bpsHit = tier.bps;
      return bpsHit === 0 ? { total: 0n, weights: [] } : prop(rawPercentOrFixed("percent", bpsHit, base));
    }
    case "bogo": {
      const units = lines.flatMap((l) => Array.from({ length: l.qty }, () => l)).sort((a, b) => (a.unitMinor < b.unitMinor ? -1 : a.unitMinor > b.unitMinor ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const free = Math.floor(units.length / (d.buyQty + d.getQty)) * d.getQty;
      const per = new Map<string, bigint>();
      for (const u of units.slice(0, free)) per.set(u.id, (per.get(u.id) ?? 0n) + percentOf(money(u.unitMinor, "EGP"), BigInt(d.getBps)).amountMinor);
      const weights = lines.map((l) => [l.id, minB(per.get(l.id) ?? 0n, rem(l))] as const);
      return { total: weights.reduce((a, [, w]) => a + w, 0n), weights };
    }
    case "bundle": {
      const perProduct = d.productIds.map((p) => lines.filter((l) => l.productId === p));
      if (perProduct.some((ls) => ls.length === 0)) return { total: 0n, weights: [] };
      const sets = Math.min(...perProduct.map((ls) => ls.reduce((a, l) => a + l.qty, 0)));
      const per = new Map<string, bigint>();
      for (const ls of perProduct) {
        let need = sets;
        for (const l of ls) {
          const take = Math.min(need, l.qty);
          need -= take;
          per.set(l.id, (per.get(l.id) ?? 0n) + percentOf(money(lineGrossMinor({ unitMinor: l.unitMinor, qty: take }), "EGP"), BigInt(d.bps)).amountMinor);
        }
      }
      const weights = lines.map((l) => [l.id, minB(per.get(l.id) ?? 0n, rem(l))] as const);
      return { total: weights.reduce((a, [, w]) => a + w, 0n), weights };
    }
    case "free_shipping":
      return { total: 0n, weights: [] };
  }
};

const must = <K, V>(m: ReadonlyMap<K, V>, k: K): V => {
  const v = m.get(k);
  if (v === undefined) throw new PromotionError("INVALID_PROMOTION", "internal: unknown line or store");
  return v;
};
const dedupe = (xs: readonly string[]): string[] => [...new Set(xs)];

/**
 * Applies exactly the selected promotions in the fixed order item -> store -> order -> shipping -> payment-partner (ties: stacking class, then id).
 * Ineligible selections are reported in `rejected` and skipped. Percent amounts round half-even once per promotion (money.percentOf).
 * Every discount is capped by max_discount, the remaining budget and what is left to pay, so no line or total goes negative.
 */
export const evaluate = (bag: EvalBag, ctx: EvalContext, selected: readonly PromotionCandidate[], usage: UsageMap = new Map()): EvaluationResult => {
  validateStacking(selected);
  const cur = bag.currency;
  const lineSt = new Map<string, LineState>();
  const lineStore = new Map<string, string>();
  for (const l of allLines(bag)) {
    lineSt.set(l.id, { gross: lineGross(l), remaining: lineGross(l), platform: 0n, seller: 0n });
    lineStore.set(l.id, l.storeId);
  }
  const shipSt = new Map<string, ShipState>(bag.stores.map((s) => [s.storeId, { fee: s.shippingFeeMinor, remaining: s.shippingFeeMinor, platform: 0n, seller: 0n }]));
  const rejected: { promotionId: string; reason: RejectReason }[] = [];
  const applied: AppliedPromotion[] = [];

  const ordered = [...selected].sort((a, b) => LEVEL_RANK[a.rules.level] - LEVEL_RANK[b.rules.level] || CLASS_RANK[a.stackingClass] - CLASS_RANK[b.stackingClass] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const c of ordered) {
    const why = rejectReason(c, ctx, bag, usage);
    if (why !== null) { rejected.push({ promotionId: c.id, reason: why }); continue; }
    const lines = eligibleLines(c, bag);
    const u = usage.get(c.id) ?? NO_USAGE;
    let cap = c.maxDiscountMinor ?? 2n ** 62n;
    if (c.budgetMinor !== null) cap = minB(cap, c.budgetMinor - u.usedMinor);
    const toMoney = (v: bigint): Money => money(v, cur);
    const split = (v: bigint): [bigint, bigint] => { const p = fraction(toMoney(v), BigInt(c.fundingPlatformBp), 10_000n).amountMinor; return [p, v - p]; };

    if (c.rules.discount.kind === "free_shipping") {
      const storeIds = dedupe(lines.map((l) => l.storeId));
      const weights = storeIds.map((s) => [s, must(shipSt, s).remaining] as const);
      const raw = weights.reduce((a, [, w]) => a + w, 0n);
      const total = minB(raw, cap);
      if (total <= 0n) { rejected.push({ promotionId: c.id, reason: raw === 0n ? "no_discount" : "budget_exhausted" }); continue; }
      const shares = allocate(toMoney(total), weights.map(([, w]) => w));
      const shipping: ShippingDiscount[] = [];
      let tp = 0n; let ts = 0n;
      weights.forEach(([sid], i) => {
        const v = shares[i]?.amountMinor ?? 0n;
        if (v === 0n) return;
        const [p, s] = split(v);
        const st = must(shipSt, sid);
        st.remaining -= v; st.platform += p; st.seller += s;
        tp += p; ts += s;
        shipping.push({ storeId: sid, amount: toMoney(v), platform: toMoney(p), seller: toMoney(s) });
      });
      applied.push({ promotionId: c.id, version: c.version, voucherId: c.voucherId, level: c.rules.level, stackingClass: c.stackingClass, total: toMoney(total), platform: toMoney(tp), seller: toMoney(ts), lines: [], shipping });
      continue;
    }

    const raw = rawLineDiscount(c, lines, lineSt);
    const base = lines.reduce((a, l) => a + must(lineSt, l.id).remaining, 0n);
    const total = minB(minB(raw.total, cap), base);
    if (total <= 0n) { rejected.push({ promotionId: c.id, reason: raw.total === 0n ? "no_discount" : "budget_exhausted" }); continue; }
    const shares = allocate(toMoney(total), raw.weights.map(([, w]) => w));
    const out: LineDiscount[] = [];
    let tp = 0n; let ts = 0n;
    raw.weights.forEach(([lid], i) => {
      const v = shares[i]?.amountMinor ?? 0n;
      if (v === 0n) return;
      const [p, s] = split(v);
      const st = must(lineSt, lid);
      st.remaining -= v; st.platform += p; st.seller += s;
      tp += p; ts += s;
      out.push({ lineId: lid, amount: toMoney(v), platform: toMoney(p), seller: toMoney(s) });
    });
    applied.push({ promotionId: c.id, version: c.version, voucherId: c.voucherId, level: c.rules.level, stackingClass: c.stackingClass, total: toMoney(total), platform: toMoney(tp), seller: toMoney(ts), lines: out, shipping: [] });
  }

  const m = (v: bigint): Money => money(v, cur);
  const lines: LineResult[] = allLines(bag).map((l) => {
    const st = must(lineSt, l.id);
    return { lineId: l.id, storeId: l.storeId, gross: m(st.gross), discount: m(st.platform + st.seller), platformDiscount: m(st.platform), sellerDiscount: m(st.seller), payable: m(st.remaining) };
  });
  const stores: StoreResult[] = bag.stores.map((s) => {
    const ls = lines.filter((l) => l.storeId === s.storeId);
    const sh = must(shipSt, s.storeId);
    const g = ls.reduce((a, l) => a + l.gross.amountMinor, 0n);
    const p = ls.reduce((a, l) => a + l.payable.amountMinor, 0n);
    return { storeId: s.storeId, goodsGross: m(g), goodsDiscount: m(g - p), goodsPayable: m(p), shippingFee: m(sh.fee), shippingDiscount: m(sh.fee - sh.remaining), shippingPayable: m(sh.remaining) };
  });
  const sum = (f: (s: StoreResult) => Money): bigint => stores.reduce((a, s) => a + f(s).amountMinor, 0n);
  const platformFunded = [...lineSt.values()].reduce((a, s) => a + s.platform, 0n) + [...shipSt.values()].reduce((a, s) => a + s.platform, 0n);
  const sellerFunded = [...lineSt.values()].reduce((a, s) => a + s.seller, 0n) + [...shipSt.values()].reduce((a, s) => a + s.seller, 0n);
  return {
    currency: cur, applied, rejected, lines, stores,
    totals: {
      goodsGross: m(sum((s) => s.goodsGross)), goodsDiscount: m(sum((s) => s.goodsDiscount)), shippingFee: m(sum((s) => s.shippingFee)), shippingDiscount: m(sum((s) => s.shippingDiscount)),
      platformFunded: m(platformFunded), sellerFunded: m(sellerFunded), payable: m(sum((s) => s.goodsPayable) + sum((s) => s.shippingPayable)),
    },
  };
};

const validSubset = (xs: readonly PromotionCandidate[]): boolean => {
  try { validateStacking(xs); return true; } catch { return false; }
};

const eligibleOnly = (bag: EvalBag, ctx: EvalContext, cands: readonly PromotionCandidate[], usage: UsageMap): PromotionCandidate[] =>
  [...cands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).filter((c) => rejectReason(c, ctx, bag, usage) === null);

export interface AutoBestResult { readonly result: EvaluationResult; readonly selectedIds: readonly string[]; readonly considered: number }

/**
 * Auto-best: exact search over every stacking-valid subset of the eligible candidates (at most 5, so at most 32 evaluations), minimising what the
 * shopper pays. Ties: fewest promotions, then the lexicographically smallest id list. Input order does not matter.
 */
export const autoBest = (bag: EvalBag, ctx: EvalContext, candidates: readonly PromotionCandidate[], usage: UsageMap = new Map()): AutoBestResult => {
  const pool = eligibleOnly(bag, ctx, candidates, usage);
  if (pool.length > MAX_CANDIDATES) throw new PromotionError("TOO_MANY_CANDIDATES", `auto-best is exact over at most ${String(MAX_CANDIDATES)} candidates; prune first`);
  let best: { result: EvaluationResult; ids: string[] } | null = null;
  let considered = 0;
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const subset = pool.filter((_, i) => (mask & (1 << i)) !== 0);
    if (!validSubset(subset)) continue;
    considered++;
    const result = evaluate(bag, ctx, subset, usage);
    const ids = result.applied.map((a) => a.promotionId).sort();
    const better = best === null
      || result.totals.payable.amountMinor < best.result.totals.payable.amountMinor
      || (result.totals.payable.amountMinor === best.result.totals.payable.amountMinor && (ids.length < best.ids.length || (ids.length === best.ids.length && ids.join(",") < best.ids.join(","))));
    if (better) best = { result, ids };
  }
  const chosen = best ?? { result: evaluate(bag, ctx, [], usage), ids: [] as string[] };
  return { result: chosen.result, selectedIds: chosen.ids, considered };
};

/** Keeps the 5 eligible candidates with the largest stand-alone saving (ties by id) so auto-best stays exact over its pool. */
export const pruneCandidates = (bag: EvalBag, ctx: EvalContext, candidates: readonly PromotionCandidate[], usage: UsageMap = new Map()): { kept: PromotionCandidate[]; prunedIds: string[] } => {
  const pool = eligibleOnly(bag, ctx, candidates, usage);
  if (pool.length <= MAX_CANDIDATES) return { kept: pool, prunedIds: [] };
  const scored = pool.map((c) => ({ c, save: evaluate(bag, ctx, [c], usage).totals.goodsDiscount.amountMinor + evaluate(bag, ctx, [c], usage).totals.shippingDiscount.amountMinor }));
  scored.sort((a, b) => (a.save === b.save ? (a.c.id < b.c.id ? -1 : 1) : a.save > b.save ? -1 : 1));
  return { kept: scored.slice(0, MAX_CANDIDATES).map((s) => s.c).sort((a, b) => (a.id < b.id ? -1 : 1)), prunedIds: scored.slice(MAX_CANDIDATES).map((s) => s.c.id).sort() };
};

export { requiresCode };
