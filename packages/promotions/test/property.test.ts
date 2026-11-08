import fc from "fast-check";
import { allocateVatWithLineDiscounts } from "@outlet/tax";
import { describe, expect, it } from "vitest";
import { autoBest, evaluate, ledgerFunding, toTaxableLines, validateStacking } from "../src/index.js";
import type { EvalBag, PromotionCandidate } from "../src/index.js";
import { A, B, cand, ctx } from "./fixtures.js";

const RUNS = { numRuns: 1000 };
const stores = [A, B];

const bagArb: fc.Arbitrary<EvalBag> = fc
  .array(fc.record({ store: fc.constantFrom(...stores), cat: fc.constantFrom("dress", "shoes", "bag"), qty: fc.integer({ min: 1, max: 4 }), unit: fc.bigInt({ min: 100n, max: 900_000n }) }), { minLength: 1, maxLength: 6 })
  .chain((ls) =>
    fc.tuple(fc.bigInt({ min: 0n, max: 20_000n }), fc.bigInt({ min: 0n, max: 20_000n })).map(([sa, sb]): EvalBag => ({
      currency: "EGP",
      stores: stores.map((s, si) => ({
        storeId: s, shippingFeeMinor: si === 0 ? sa : sb,
        lines: ls.map((l, i) => ({ l, i })).filter(({ l }) => l.store === s).map(({ l, i }) => ({ id: `l${String(i)}`, storeId: s, productId: `p${String(i % 3)}`, categoryId: l.cat, qty: l.qty, unitMinor: l.unit, vatBp: 1400 })),
      })).filter((s) => s.lines.length > 0),
    })),
  );

const discountArb = fc.oneof(
  fc.integer({ min: 1, max: 10_000 }).map((bps) => ({ kind: "percent", bps })),
  fc.bigInt({ min: 1n, max: 2_000_000n }).map((a) => ({ kind: "fixed", amountMinor: a.toString() })),
  fc.record({ buyQty: fc.integer({ min: 1, max: 3 }), getQty: fc.integer({ min: 1, max: 2 }), getBps: fc.integer({ min: 1, max: 10_000 }) }).map((r) => ({ kind: "bogo", ...r })),
  fc.integer({ min: 1, max: 10_000 }).map((bps) => ({ kind: "tiered", tiers: [{ minSubtotalMinor: "1000", bps }] })),
  fc.integer({ min: 1, max: 10_000 }).map((bps) => ({ kind: "bundle", productIds: ["p0", "p1"], bps })),
);

const candArb = (i: number): fc.Arbitrary<PromotionCandidate> =>
  fc.record({
    d: discountArb, level: fc.constantFrom("item", "order"), cls: fc.constantFrom("auto", "platform_code"), ship: fc.boolean(), fp: fc.integer({ min: 0, max: 10_000 }),
    max: fc.option(fc.bigInt({ min: 1n, max: 100_000n }), { nil: null }), budget: fc.option(fc.bigInt({ min: 1n, max: 100_000n }), { nil: null }), store: fc.constantFrom(null, A, B),
  }).map((x) => {
    const type = x.ship ? "free_shipping" : x.d.kind === "percent" || x.d.kind === "fixed" ? "percent" : (x.d.kind as "bogo");
    const discount = x.ship ? { kind: "free_shipping" } : x.d;
    const storeId = x.store;
    return cand({ id: `c${String(i)}`, storeId, type: type === "percent" && x.d.kind === "fixed" ? "fixed" : type, cls: x.cls === "platform_code" && storeId !== null ? "auto" : x.cls, owner: storeId === null ? "platform" : "co_funded", fp: storeId === null ? 10_000 : x.fp, fs: storeId === null ? 0 : 10_000 - x.fp,
      rules: { level: x.ship ? "shipping" : x.level, discount }, max: x.max, budget: x.budget });
  });
const candsArb = fc.integer({ min: 0, max: 5 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => candArb(i))).map((xs) => xs));

const validSubsets = (cs: PromotionCandidate[]): PromotionCandidate[][] => {
  const out: PromotionCandidate[][] = [];
  for (let m = 0; m < 1 << cs.length; m++) {
    const s = cs.filter((_, i) => (m & (1 << i)) !== 0);
    try { validateStacking(s); out.push(s); } catch { /* invalid */ }
  }
  return out;
};

describe("properties", () => {
  it("caps are never exceeded and nothing goes negative", () => {
    fc.assert(fc.property(bagArb, candsArb, (bag, cs) => {
      const subset = validSubsets(cs).at(-1) ?? [];
      const r = evaluate(bag, ctx(), subset);
      for (const l of r.lines) {
        expect(l.payable.amountMinor).toBeGreaterThanOrEqual(0n);
        expect(l.discount.amountMinor).toBeLessThanOrEqual(l.gross.amountMinor);
        expect(l.discount.amountMinor).toBe(l.platformDiscount.amountMinor + l.sellerDiscount.amountMinor);
      }
      for (const s of r.stores) {
        expect(s.shippingPayable.amountMinor).toBeGreaterThanOrEqual(0n);
        expect(s.goodsPayable.amountMinor).toBeGreaterThanOrEqual(0n);
      }
      expect(r.totals.payable.amountMinor).toBeGreaterThanOrEqual(0n);
      for (const a of r.applied) {
        const c = subset.find((x) => x.id === a.promotionId);
        if (c?.maxDiscountMinor != null) expect(a.total.amountMinor).toBeLessThanOrEqual(c.maxDiscountMinor);
        if (c?.budgetMinor != null) expect(a.total.amountMinor).toBeLessThanOrEqual(c.budgetMinor);
        expect(a.platform.amountMinor + a.seller.amountMinor).toBe(a.total.amountMinor);
        expect(a.lines.reduce((x, d) => x + d.amount.amountMinor, 0n) + a.shipping.reduce((x, d) => x + d.amount.amountMinor, 0n)).toBe(a.total.amountMinor);
      }
    }), RUNS);
  });

  it("evaluation is idempotent and independent of candidate order", () => {
    fc.assert(fc.property(bagArb, candsArb, (bag, cs) => {
      const subset = validSubsets(cs).at(-1) ?? [];
      const once = evaluate(bag, ctx(), subset);
      expect(evaluate(bag, ctx(), subset)).toEqual(once);
      expect(evaluate(bag, ctx(), [...subset].reverse())).toEqual(once);
      const b1 = autoBest(bag, ctx(), cs);
      expect(autoBest(bag, ctx(), [...cs].reverse())).toEqual(b1);
    }), RUNS);
  });

  it("auto-best is never worse than any valid combination (brute force)", () => {
    fc.assert(fc.property(bagArb, candsArb, (bag, cs) => {
      const best = autoBest(bag, ctx(), cs).result.totals.payable.amountMinor;
      for (const s of validSubsets(cs)) expect(best).toBeLessThanOrEqual(evaluate(bag, ctx(), s).totals.payable.amountMinor);
    }), RUNS);
  });

  it("funding split sums exactly and feeds the VAT allocator and the ledger consistently", () => {
    fc.assert(fc.property(bagArb, candsArb, (bag, cs) => {
      const r = autoBest(bag, ctx(), cs).result;
      const f = ledgerFunding(bag, r);
      expect(f.promoExpensePlatform.amountMinor + f.sellerFunded.amountMinor).toBe(r.totals.goodsDiscount.amountMinor + r.totals.shippingDiscount.amountMinor);
      const perStore = f.perStore.reduce((a, s) => a + s.platformGoods.amountMinor + s.sellerGoods.amountMinor + s.platformShipping.amountMinor + s.sellerShipping.amountMinor, 0n);
      expect(perStore).toBe(f.promoExpensePlatform.amountMinor + f.sellerFunded.amountMinor);
      const tax = allocateVatWithLineDiscounts(toTaxableLines(bag, r));
      expect(tax.payableTotal.amountMinor).toBe(r.totals.goodsGross.amountMinor - r.totals.goodsDiscount.amountMinor);
    }), RUNS);
  });

  it("bogo and bundle: one rounding of the raw total, and the line discounts sum to it exactly", () => {
    const rawArb = fc.oneof(
      fc.record({ buyQty: fc.constant(1), getQty: fc.constant(1), getBps: fc.integer({ min: 1, max: 9_999 }) }).map((r) => ({ kind: "bogo" as const, ...r })),
      fc.integer({ min: 1, max: 9_999 }).map((bps) => ({ kind: "bundle" as const, productIds: ["p0", "p1"], bps })),
    );
    fc.assert(fc.property(bagArb, rawArb, (bag, d) => {
      const c = cand({ id: "x", type: d.kind, rules: { level: "item", discount: d } });
      const r = evaluate(bag, ctx(), [c]);
      const a = r.applied[0];
      if (a === undefined) return;
      expect(a.lines.reduce((x, l) => x + l.amount.amountMinor, 0n)).toBe(a.total.amountMinor);
      if (d.kind !== "bogo") return; // bundle: which unit of a split product is matched depends on line order, so only the exact-sum invariant is asserted
      // single rounding: within half a piastre of free-unit value x bps (bogo picks the cheapest units, independent of line order)
      const units = bag.stores.flatMap((st) => st.lines).flatMap((l) => Array.from({ length: l.qty }, () => l.unitMinor)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const value = units.slice(0, Math.floor(units.length / 2)).reduce((n, u) => n + u, 0n);
      const t = a.total.amountMinor;
      const bps = BigInt(d.getBps);
      const diff = t * 10_000n - value * bps;
      expect(diff <= 5_000n && diff >= -5_000n).toBe(true);
    }), RUNS);
  });
});
