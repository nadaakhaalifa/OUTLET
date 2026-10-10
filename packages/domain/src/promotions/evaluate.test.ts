import { describe, expect, it } from "vitest";
import { money } from "../money";
import { evaluatePromotions } from "./evaluate";
import { NOW, S1, S2, egp, promo } from "./fixtures";
import type { EvalRequest, Usage } from "./types";

const req = (over: Partial<EvalRequest> = {}): EvalRequest => ({
  userId: "u1",
  lines: [
    { skuId: "sku-a", storeId: S1, qty: 2, unitPrice: egp(500n) },
    { skuId: "sku-b", storeId: S2, qty: 1, unitPrice: egp(1000n) },
  ],
  shippingFees: [
    { storeId: S1, fee: egp(60n) },
    { storeId: S2, fee: egp(60n) },
  ],
  codes: [],
  paymentMethod: "card",
  isPlus: false,
  atMs: NOW,
  usage: new Map(),
  ...over,
});

describe("evaluatePromotions", () => {
  it("applies a platform percent code at order scope", () => {
    const p = promo({ code: "SAVE10", value: { kind: "percent", percentBps: 1000 } });
    const r = evaluatePromotions(req({ codes: ["save10 "] }), [p]);
    expect(r.applied).toHaveLength(1);
    expect(r.totalDiscount).toBe(20_000n);
    expect(r.payableTotal).toBe(200_000n + 12_000n - 20_000n);
    expect(r.applied[0]?.display).toBe("voucher_minus");
  });

  it("reports unknown codes and caps entered codes at five", () => {
    const r = evaluatePromotions(req({ codes: ["NOPE", "A1", "A2", "A3", "A4", "A5"] }), []);
    expect(r.rejected.filter((x) => x.reason === "unknown_code")).toHaveLength(5);
    expect(r.rejected.filter((x) => x.reason === "too_many_codes")).toHaveLength(1);
  });

  it("splits funding and the parts add up to the discount, per line", () => {
    const p = promo({
      scope: "item",
      value: { kind: "percent", percentBps: 3333 },
      funding: { platformPct: 50, sellerPct: 50 },
    });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    const a = r.applied[0];
    expect(a).toBeDefined();
    expect((a?.platformFunded ?? 0n) + (a?.sellerFunded ?? 0n)).toBe(a?.amount);
    for (const l of a?.lines ?? []) expect(l.platformFunded + l.sellerFunded).toBe(l.amount);
  });

  it("rounds a percent discount half to even on each line", () => {
    // 1 piastre of 50% of 5 piastres = 2.5 -> 2 (even)
    const p = promo({ scope: "item", value: { kind: "percent", percentBps: 5000 } });
    const r = evaluatePromotions(
      req({ lines: [{ skuId: "x", storeId: S1, qty: 1, unitPrice: money(5n) }], shippingFees: [], codes: [p.code ?? ""] }),
      [p],
    );
    expect(r.totalDiscount).toBe(2n);
  });

  it("fixed item discount is per unit and never exceeds the line", () => {
    const p = promo({ scope: "item", value: { kind: "fixed", amount: egp(300n) } });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    expect(r.lines[0]?.discount).toBe(60_000n);
    expect(r.lines[1]?.discount).toBe(30_000n);
  });

  it("bogo gives the cheapest group units free", () => {
    const p = promo({ scope: "item", value: { kind: "bogo", buyQty: 1, getQty: 1, getPercentBps: 10_000 } });
    const r = evaluatePromotions(
      req({ lines: [{ skuId: "x", storeId: S1, qty: 5, unitPrice: egp(100n) }], shippingFees: [], codes: [p.code ?? ""] }),
      [p],
    );
    expect(r.totalDiscount).toBe(20_000n);
  });

  it("tiered picks the highest reached tier on list subtotal; below the first tier is min_order_not_met", () => {
    const p = promo({
      scope: "order",
      value: {
        kind: "tiered",
        tiers: [
          { minSubtotal: egp(1000n), percentBps: 500 },
          { minSubtotal: egp(1500n), percentBps: 1000 },
        ],
      },
    });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    expect(r.totalDiscount).toBe(20_000n);
    const low = evaluatePromotions(
      req({ lines: [{ skuId: "x", storeId: S1, qty: 1, unitPrice: egp(900n) }], codes: [p.code ?? ""] }),
      [p],
    );
    expect(low.applied).toHaveLength(0);
    expect(low.rejected[0]?.reason).toBe("min_order_not_met");
  });

  it("free shipping discounts the store fee, not for Plus members, and respects per-store minimum", () => {
    const p = promo({ scope: "shipping", value: { kind: "free_shipping" }, minOrder: egp(1500n) });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    // store 1 list = 1000 (<1500), store 2 list = 1000 (<1500): none
    expect(r.shippingDiscount).toBe(0n);
    const p2 = promo({ scope: "shipping", value: { kind: "free_shipping" }, minOrder: egp(1000n) });
    expect(evaluatePromotions(req({ codes: [p2.code ?? ""] }), [p2]).shippingDiscount).toBe(12_000n);
    const plus = evaluatePromotions(req({ codes: [p2.code ?? ""], isPlus: true }), [p2]);
    expect(plus.shippingFee).toBe(0n);
    expect(plus.applied).toHaveLength(0);
  });

  it("store voucher only touches its own store and cannot be platform funded by validation", () => {
    const p = promo({
      owner: { kind: "store", storeId: S1 },
      scope: "store",
      funding: { platformPct: 0, sellerPct: 100 },
    });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    expect(r.lines[1]?.discount).toBe(0n);
    expect(r.lines[0]?.discount).toBe(10_000n);
    expect(r.applied[0]?.sellerFunded).toBe(10_000n);
  });

  it("enforces max discount and remaining budget", () => {
    const p = promo({ maxDiscount: egp(50n), value: { kind: "percent", percentBps: 5000 } });
    expect(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]).totalDiscount).toBe(5_000n);
    const b = promo({ totalBudget: egp(100n), value: { kind: "percent", percentBps: 5000 } });
    const usage = new Map<string, Usage>([[b.id, { userRedemptions: 0, dayRedemptions: 0, spent: 9_000n }]]);
    expect(evaluatePromotions(req({ codes: [b.code ?? ""], usage }), [b]).totalDiscount).toBe(1_000n);
    const gone = new Map<string, Usage>([[b.id, { userRedemptions: 0, dayRedemptions: 0, spent: 10_000n }]]);
    const r = evaluatePromotions(req({ codes: [b.code ?? ""], usage: gone }), [b]);
    expect(r.rejected[0]?.reason).toBe("budget_exhausted");
  });

  it("per-user and per-day caps and the validity window", () => {
    const p = promo({ perUserCap: 1, perDayCap: 5 });
    const used = new Map<string, Usage>([[p.id, { userRedemptions: 1, dayRedemptions: 0, spent: 0n }]]);
    expect(evaluatePromotions(req({ codes: [p.code ?? ""], usage: used }), [p]).rejected[0]?.reason).toBe(
      "per_user_cap_reached",
    );
    const day = new Map<string, Usage>([[p.id, { userRedemptions: 0, dayRedemptions: 5, spent: 0n }]]);
    expect(evaluatePromotions(req({ codes: [p.code ?? ""], usage: day }), [p]).rejected[0]?.reason).toBe(
      "per_day_cap_reached",
    );
    const early = promo({ startsAtMs: NOW + 1 });
    expect(evaluatePromotions(req({ codes: [early.code ?? ""] }), [early]).rejected[0]?.reason).toBe("not_started");
    const late = promo({ endsAtMs: NOW });
    expect(evaluatePromotions(req({ codes: [late.code ?? ""] }), [late]).rejected[0]?.reason).toBe("expired");
  });

  it("payment method and Plus targeting", () => {
    const p = promo({ targeting: { storeIds: [], skuIds: [], paymentMethods: ["fawry"], plusOnly: false } });
    expect(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]).rejected[0]?.reason).toBe(
      "payment_method_not_eligible",
    );
    const q = promo({ targeting: { storeIds: [], skuIds: [], paymentMethods: [], plusOnly: true } });
    expect(evaluatePromotions(req({ codes: [q.code ?? ""] }), [q]).rejected[0]?.reason).toBe("plus_members_only");
  });

  describe("stacking", () => {
    it("allows only one platform code; the better one wins and the other is a conflict", () => {
      const a = promo({ code: "AAA", value: { kind: "percent", percentBps: 1000 } });
      const b = promo({ code: "BBB", value: { kind: "percent", percentBps: 2000 } });
      const r = evaluatePromotions(req({ codes: ["AAA", "BBB"] }), [a, b]);
      expect(r.applied.map((x) => x.code)).toEqual(["BBB"]);
      expect(r.rejected.find((x) => x.code === "AAA")?.reason).toBe("stacking_conflict");
    });

    it("platform code, one store voucher per store and an auto promo stack, in item-store-order-shipping order", () => {
      const platform = promo({ code: "PLAT", scope: "order", value: { kind: "percent", percentBps: 1000 } });
      const store1 = promo({
        code: "S1V",
        owner: { kind: "store", storeId: S1 },
        scope: "store",
        funding: { platformPct: 0, sellerPct: 100 },
        value: { kind: "percent", percentBps: 1000 },
      });
      const auto = promo({
        code: null,
        autoApply: true,
        scope: "item",
        value: { kind: "percent", percentBps: 1000 },
      });
      const r = evaluatePromotions(req({ codes: ["PLAT", "S1V"] }), [platform, store1, auto]);
      expect(r.applied.map((x) => x.scope)).toEqual(["item", "store", "order"]);
      // 1000 * 0.9 = 900 line a... computed sequentially on the remaining amount
      expect(r.merchandiseDiscount).toBeGreaterThan(0n);
      expect(r.payableTotal).toBe(r.merchandiseSubtotal - r.merchandiseDiscount + r.shippingFee - r.shippingDiscount);
    });

    it("a second voucher from the same store conflicts, but vouchers from two stores stack", () => {
      const mk = (code: string, storeId: string) =>
        promo({
          code,
          owner: { kind: "store", storeId },
          scope: "store",
          funding: { platformPct: 0, sellerPct: 100 },
          value: { kind: "percent", percentBps: 1000 },
        });
      const r = evaluatePromotions(req({ codes: ["A", "B", "C"].map((c) => `V${c}1`) }), [
        mk("VA1", S1),
        mk("VB1", S1),
        mk("VC1", S2),
      ]);
      expect(r.applied).toHaveLength(2);
    });

    it("limits the exact search to five candidates", () => {
      const pool = Array.from({ length: 7 }, (_, i) =>
        promo({ code: null, autoApply: true, scope: i % 2 === 0 ? "item" : "store", value: { kind: "percent", percentBps: 100 + i } }),
      );
      const r = evaluatePromotions(req(), pool);
      expect(r.rejected.filter((x) => x.reason === "candidate_limit")).toHaveLength(2);
    });
  });

  it("never reports a reference price or percent-off field", () => {
    const p = promo({});
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    expect(JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(
      /percent|pct|reference|was_price|compare_at/i,
    );
  });
});
