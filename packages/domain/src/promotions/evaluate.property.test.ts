import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "../money";
import { evaluatePromotions } from "./evaluate";
import { NOW, S1, S2, S3 } from "./fixtures";
import { violatesStacking } from "./stacking";
import { validatePromotion } from "./validate";
import {
  DEFAULT_STACKING_POLICY,
  type EvalLine,
  type EvalRequest,
  type Promotion,
  type PromotionScope,
  type PromotionValue,
  type Usage,
} from "./types";

const STORES = [S1, S2, S3] as const;
const piastres = (hi: bigint) => fc.bigInt({ min: 0n, max: hi });

const lineArb: fc.Arbitrary<EvalLine> = fc.record({
  skuId: fc.constantFrom("sku-1", "sku-2", "sku-3", "sku-4"),
  storeId: fc.constantFrom(...STORES),
  qty: fc.integer({ min: 1, max: 10 }),
  unitPrice: piastres(2_000_000n).map((a) => money(a)),
});

const valueArb: fc.Arbitrary<{ value: PromotionValue; scope: PromotionScope }> = fc.oneof(
  fc
    .record({ bps: fc.integer({ min: 1, max: 10_000 }), scope: fc.constantFrom<PromotionScope>("item", "store", "order") })
    .map((x) => ({ value: { kind: "percent" as const, percentBps: x.bps }, scope: x.scope })),
  fc
    .record({ amt: fc.bigInt({ min: 1n, max: 500_000n }), scope: fc.constantFrom<PromotionScope>("item", "store", "order") })
    .map((x) => ({ value: { kind: "fixed" as const, amount: money(x.amt) }, scope: x.scope })),
  fc
    .record({ buy: fc.integer({ min: 1, max: 3 }), get: fc.integer({ min: 1, max: 3 }), bps: fc.integer({ min: 1, max: 10_000 }) })
    .map((x) => ({
      value: { kind: "bogo" as const, buyQty: x.buy, getQty: x.get, getPercentBps: x.bps },
      scope: "item" as const,
    })),
  fc
    .record({
      t1: fc.bigInt({ min: 1n, max: 500_000n }),
      d: fc.bigInt({ min: 1n, max: 500_000n }),
      b1: fc.integer({ min: 1, max: 5000 }),
      b2: fc.integer({ min: 0, max: 5000 }),
      scope: fc.constantFrom<PromotionScope>("store", "order"),
    })
    .map((x) => ({
      value: {
        kind: "tiered" as const,
        tiers: [
          { minSubtotal: money(x.t1), percentBps: x.b1 },
          { minSubtotal: money(x.t1 + x.d), percentBps: x.b1 + x.b2 },
        ],
      },
      scope: x.scope,
    })),
  fc.constant({ value: { kind: "free_shipping" as const }, scope: "shipping" as const }),
);

let seq = 0;
const promoArb: fc.Arbitrary<Promotion> = fc
  .record({
    vs: valueArb,
    owner: fc.option(fc.constantFrom(...STORES), { nil: undefined }),
    auto: fc.boolean(),
    platformPct: fc.integer({ min: 0, max: 100 }),
    minOrder: fc.option(piastres(1_000_000n).filter((x) => x > 0n), { nil: null }),
    maxDiscount: fc.option(piastres(500_000n).filter((x) => x > 0n), { nil: null }),
    budget: fc.option(piastres(500_000n).filter((x) => x > 0n), { nil: null }),
    perUser: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
    perDay: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
  })
  .map((r): Promotion => {
    seq += 1;
    const owner = r.owner === undefined ? ({ kind: "platform" } as const) : ({ kind: "store", storeId: r.owner } as const);
    return {
      id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      version: 1,
      owner,
      scope: r.vs.scope,
      value: r.vs.value,
      code: r.auto ? null : `PRM${seq}`,
      autoApply: r.auto,
      funding: owner.kind === "store" ? { platformPct: 0, sellerPct: 100 } : { platformPct: r.platformPct, sellerPct: 100 - r.platformPct },
      targeting: { storeIds: [], skuIds: [], paymentMethods: [], plusOnly: false },
      minOrder: r.minOrder === null ? null : money(r.minOrder),
      maxDiscount: r.maxDiscount === null ? null : money(r.maxDiscount),
      perUserCap: r.perUser,
      perDayCap: r.perDay,
      totalBudget: r.budget === null ? null : money(r.budget),
      startsAtMs: NOW - 1000,
      endsAtMs: NOW + 1000,
      status: "active",
    };
  });

const usageFor = (pool: readonly Promotion[], used: readonly number[]): Map<string, Usage> =>
  new Map(
    pool.map((p, i) => [
      p.id,
      { userRedemptions: (used[i] ?? 0) % 2, dayRedemptions: (used[i] ?? 0) % 3, spent: BigInt(((used[i] ?? 0) * 7919) % 100_000) },
    ]),
  );

const scenario = fc.record({
  lines: fc.array(lineArb, { minLength: 1, maxLength: 6 }),
  fees: fc.array(piastres(30_000n), { minLength: 3, maxLength: 3 }),
  pool: fc.array(promoArb, { minLength: 0, maxLength: 5 }),
  used: fc.array(fc.integer({ min: 0, max: 20 }), { minLength: 5, maxLength: 5 }),
  isPlus: fc.boolean(),
});

type Scenario = {
  lines: EvalLine[];
  fees: bigint[];
  pool: Promotion[];
  used: number[];
  isPlus: boolean;
};

const toReq = (s: Scenario, pool: readonly Promotion[] = s.pool): EvalRequest => ({
  userId: "u",
  lines: s.lines,
  shippingFees: STORES.map((storeId, i) => ({ storeId, fee: money(s.fees[i] ?? 0n) })),
  codes: pool.flatMap((p) => (p.code === null ? [] : [p.code])),
  paymentMethod: "card",
  isPlus: s.isPlus,
  atMs: NOW,
  usage: usageFor(s.pool, s.used),
});

// Stryker re-runs this file for every mutant; keep the shrunk budget there and the full one in CI.
const UNDER_MUTATION = process.env["STRYKER_MUTATOR_RUNNER"] !== undefined;
const OPTS = { numRuns: UNDER_MUTATION ? 40 : 300 };

describe("promotion evaluation properties (spec 17)", () => {
  it("generated promotions are valid definitions", () => {
    fc.assert(
      fc.property(promoArb, (p) => {
        expect(validatePromotion(p)).toEqual([]);
      }),
      OPTS,
    );
  });

  it("no total goes negative and totals reconcile", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluatePromotions(toReq(s), s.pool);
        for (const l of r.lines) {
          expect(l.payable).toBeGreaterThanOrEqual(0n);
          expect(l.discount).toBeGreaterThanOrEqual(0n);
          expect(l.payable + l.discount).toBe(l.subtotal);
        }
        for (const x of r.shipping) {
          expect(x.payable).toBeGreaterThanOrEqual(0n);
          expect(x.discount).toBeGreaterThanOrEqual(0n);
        }
        expect(r.payableTotal).toBe(
          r.merchandiseSubtotal - r.merchandiseDiscount + r.shippingFee - r.shippingDiscount,
        );
        expect(r.payableTotal).toBeGreaterThanOrEqual(0n);
        expect(r.totalDiscount).toBe(r.merchandiseDiscount + r.shippingDiscount);
        const applied = r.applied.reduce((t, a) => t + a.amount, 0n);
        expect(applied).toBe(r.totalDiscount);
      }),
      OPTS,
    );
  });

  it("no promotion exceeds its max discount, its remaining budget or its cap counters", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const usage = usageFor(s.pool, s.used);
        const r = evaluatePromotions(toReq(s), s.pool);
        for (const a of r.applied) {
          const p = s.pool.find((x) => x.id === a.promotionId);
          expect(p).toBeDefined();
          if (p === undefined) continue;
          if (p.maxDiscount !== null) expect(a.amount).toBeLessThanOrEqual(p.maxDiscount.amount);
          const u = usage.get(p.id);
          if (p.totalBudget !== null) expect(a.amount).toBeLessThanOrEqual(p.totalBudget.amount - (u?.spent ?? 0n));
          if (p.perUserCap !== null) expect(u?.userRedemptions ?? 0).toBeLessThan(p.perUserCap);
          if (p.perDayCap !== null) expect(u?.dayRedemptions ?? 0).toBeLessThan(p.perDayCap);
        }
      }),
      OPTS,
    );
  });

  it("funding splits sum to the discount, per promotion, line and store; seller promos are never platform funded", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluatePromotions(toReq(s), s.pool);
        for (const a of r.applied) {
          expect(a.platformFunded + a.sellerFunded).toBe(a.amount);
          for (const x of [...a.lines, ...a.shipping]) expect(x.platformFunded + x.sellerFunded).toBe(x.amount);
          expect(a.lines.reduce((t, x) => t + x.amount, 0n) + a.shipping.reduce((t, x) => t + x.amount, 0n)).toBe(
            a.amount,
          );
          const p = s.pool.find((x) => x.id === a.promotionId);
          if (p?.owner.kind === "store") expect(a.platformFunded).toBe(0n);
        }
      }),
      OPTS,
    );
  });

  it("re-evaluation is idempotent and independent of input order", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const a = evaluatePromotions(toReq(s), s.pool);
        const b = evaluatePromotions(toReq(s), s.pool);
        expect(b).toEqual(a);
        const c = evaluatePromotions(toReq(s), [...s.pool].reverse());
        expect(c.applied.map((x) => x.promotionId).sort()).toEqual(a.applied.map((x) => x.promotionId).sort());
        expect(c.payableTotal).toBe(a.payableTotal);
      }),
      OPTS,
    );
  });

  it("the applied set always satisfies the stacking matrix", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluatePromotions(toReq(s), s.pool);
        const set = r.applied.flatMap((a) => s.pool.filter((p) => p.id === a.promotionId));
        expect(violatesStacking(set, DEFAULT_STACKING_POLICY)).toBe(false);
      }),
      OPTS,
    );
  });

  it("auto-best is exact: no stacking-valid subset of the pool is cheaper for the shopper", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const best = evaluatePromotions(toReq(s), s.pool).payableTotal;
        for (let mask = 0; mask < 1 << s.pool.length; mask += 1) {
          const subset = s.pool.filter((_, i) => (mask & (1 << i)) !== 0);
          if (violatesStacking(subset, DEFAULT_STACKING_POLICY)) continue;
          const alone = evaluatePromotions(toReq(s, subset), subset).payableTotal;
          expect(best).toBeLessThanOrEqual(alone);
        }
      }),
      { numRuns: UNDER_MUTATION ? 25 : 120 },
    );
  });

  it("a promotion never adds a reference price or percent-off claim to the result", () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluatePromotions(toReq(s), s.pool);
        const json = JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
        expect(json).not.toMatch(/percent|pct|reference|compare_at|was_price/i);
        for (const a of r.applied) expect(a.display).toBe("voucher_minus");
      }),
      OPTS,
    );
  });
});
