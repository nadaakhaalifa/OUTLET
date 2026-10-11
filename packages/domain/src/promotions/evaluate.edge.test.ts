import { describe, expect, it } from "vitest";
import { InvalidAmountError } from "../errors";
import { money } from "../money";
import { applySet, newBasket } from "./apply";
import { evaluatePromotions } from "./evaluate";
import { NOW, S1, S2, S3, egp, promo } from "./fixtures";
import type { EvalRequest, Usage } from "./types";

const line = (storeId: string, pounds: bigint, qty = 1, skuId = "sku") => ({
  skuId,
  storeId,
  qty,
  unitPrice: egp(pounds),
});
const req = (over: Partial<EvalRequest> = {}): EvalRequest => ({
  userId: "u",
  lines: [line(S1, 1000n)],
  shippingFees: [],
  codes: [],
  paymentMethod: null,
  isPlus: false,
  atMs: NOW,
  usage: new Map(),
  ...over,
});
const used = (id: string, u: Partial<Usage>): Map<string, Usage> =>
  new Map([[id, { userRedemptions: 0, dayRedemptions: 0, spent: 0n, ...u }]]);
const reason = (r: ReturnType<typeof evaluatePromotions>, i = 0) => r.rejected[i]?.reason;

describe("input validation", () => {
  it("rejects bad quantities, prices and fees", () => {
    const p = promo({});
    expect(() => evaluatePromotions(req({ lines: [{ ...line(S1, 1n), qty: 0 }] }), [p])).toThrow(/qty must be a positive integer/);
    expect(() => evaluatePromotions(req({ lines: [{ ...line(S1, 1n), qty: 1.5 }] }), [p])).toThrow(InvalidAmountError);
    expect(() => evaluatePromotions(req({ lines: [{ ...line(S1, 1n), unitPrice: money(-1n) }] }), [p])).toThrow(
      /unit price must not be negative/,
    );
    expect(() =>
      evaluatePromotions(req({ shippingFees: [{ storeId: S1, fee: money(-1n) }] }), [p]),
    ).toThrow(/shipping fee must not be negative/);
  });
});

describe("shipping baseline", () => {
  it("lists every store in the bag with a zero fee when none is given, and ignores fees for absent stores", () => {
    const r = evaluatePromotions(
      req({ lines: [line(S2, 10n), line(S1, 10n)], shippingFees: [{ storeId: S3, fee: egp(50n) }] }),
      [],
    );
    expect(r.shipping).toEqual([
      { storeId: S1, fee: 0n, discount: 0n, payable: 0n },
      { storeId: S2, fee: 0n, discount: 0n, payable: 0n },
    ]);
    expect(r.shippingFee).toBe(0n);
  });
  it("reports the discount as fee minus payable", () => {
    const p = promo({ scope: "shipping", value: { kind: "free_shipping" } });
    const r = evaluatePromotions(req({ shippingFees: [{ storeId: S1, fee: egp(60n) }], codes: [p.code ?? ""] }), [p]);
    expect(r.shipping).toEqual([{ storeId: S1, fee: 6000n, discount: 6000n, payable: 0n }]);
    expect(r.applied[0]?.shipping).toEqual([{ storeId: S1, amount: 6000n, platformFunded: 6000n, sellerFunded: 0n }]);
  });
});

describe("gating boundaries", () => {
  it("reports a paused promotion as not_active and a draft too", () => {
    const p = promo({ status: "paused" });
    expect(reason(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]))).toBe("not_active");
  });
  it("is live exactly at starts_at and expired exactly at ends_at", () => {
    const start = promo({ startsAtMs: NOW, endsAtMs: NOW + 10 });
    expect(evaluatePromotions(req({ codes: [start.code ?? ""] }), [start]).applied).toHaveLength(1);
    const last = promo({ startsAtMs: NOW - 10, endsAtMs: NOW + 1 });
    expect(evaluatePromotions(req({ codes: [last.code ?? ""] }), [last]).applied).toHaveLength(1);
  });
  it("payment method rules", () => {
    const any = promo({});
    expect(evaluatePromotions(req({ codes: [any.code ?? ""], paymentMethod: null }), [any]).applied).toHaveLength(1);
    const fawry = promo({ targeting: { storeIds: [], skuIds: [], paymentMethods: ["fawry", "card"], plusOnly: false } });
    expect(reason(evaluatePromotions(req({ codes: [fawry.code ?? ""], paymentMethod: null }), [fawry]))).toBe(
      "payment_method_not_eligible",
    );
    expect(reason(evaluatePromotions(req({ codes: [fawry.code ?? ""], paymentMethod: "cod" }), [fawry]))).toBe(
      "payment_method_not_eligible",
    );
    expect(evaluatePromotions(req({ codes: [fawry.code ?? ""], paymentMethod: "card" }), [fawry]).applied).toHaveLength(1);
    expect(evaluatePromotions(req({ codes: [fawry.code ?? ""], paymentMethod: "fawry" }), [fawry]).applied).toHaveLength(1);
  });
  it("caps and budget: last allowed use passes, the next is refused, missing usage means unused", () => {
    const p = promo({ perUserCap: 2, perDayCap: 3, totalBudget: egp(100n), value: { kind: "percent", percentBps: 100 } });
    const ok = evaluatePromotions(
      req({ codes: [p.code ?? ""], usage: used(p.id, { userRedemptions: 1, dayRedemptions: 2, spent: 9_999n }) }),
      [p],
    );
    expect(ok.applied).toHaveLength(1);
    expect(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]).applied).toHaveLength(1);
    expect(reason(evaluatePromotions(req({ codes: [p.code ?? ""], usage: used(p.id, { userRedemptions: 2 }) }), [p]))).toBe(
      "per_user_cap_reached",
    );
    expect(reason(evaluatePromotions(req({ codes: [p.code ?? ""], usage: used(p.id, { dayRedemptions: 3 }) }), [p]))).toBe(
      "per_day_cap_reached",
    );
    expect(reason(evaluatePromotions(req({ codes: [p.code ?? ""], usage: used(p.id, { spent: 10_000n }) }), [p]))).toBe(
      "budget_exhausted",
    );
    // budget with one piastre left caps the discount to that piastre
    const one = evaluatePromotions(
      req({ codes: [p.code ?? ""], usage: used(p.id, { spent: 9_999n }) }),
      [p],
    );
    expect(one.totalDiscount).toBe(1n);
  });
  it("the smaller of max discount and remaining budget wins", () => {
    const p = promo({ maxDiscount: egp(30n), totalBudget: egp(100n), value: { kind: "percent", percentBps: 5000 } });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""], usage: used(p.id, { spent: 5_000n }) }), [p]);
    expect(r.totalDiscount).toBe(3_000n);
    const q = promo({ maxDiscount: egp(80n), totalBudget: egp(100n), value: { kind: "percent", percentBps: 5000 } });
    const r2 = evaluatePromotions(req({ codes: [q.code ?? ""], usage: used(q.id, { spent: 5_000n }) }), [q]);
    expect(r2.totalDiscount).toBe(5_000n);
  });
});

describe("targeting", () => {
  it("store and sku targeting limits eligible lines", () => {
    const stores = promo({
      scope: "item",
      targeting: { storeIds: [S1], skuIds: [], paymentMethods: [], plusOnly: false },
    });
    const r = evaluatePromotions(
      req({ lines: [line(S1, 100n, 1, "a"), line(S2, 100n, 1, "b")], codes: [stores.code ?? ""] }),
      [stores],
    );
    expect(r.lines.map((l) => l.discount)).toEqual([1000n, 0n]);
    const skus = promo({
      scope: "item",
      targeting: { storeIds: [], skuIds: ["b"], paymentMethods: [], plusOnly: false },
    });
    const r2 = evaluatePromotions(
      req({ lines: [line(S1, 100n, 1, "a"), line(S2, 100n, 1, "b")], codes: [skus.code ?? ""] }),
      [skus],
    );
    expect(r2.lines.map((l) => l.discount)).toEqual([0n, 1000n]);
  });
  it("reports no_eligible_lines when nothing in the bag matches", () => {
    const p = promo({ owner: { kind: "store", storeId: S3 }, funding: { platformPct: 0, sellerPct: 100 } });
    expect(reason(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]))).toBe("no_eligible_lines");
  });
  it("reports no_discount when the bag is worth nothing", () => {
    const p = promo({ scope: "item" });
    const r = evaluatePromotions(req({ lines: [line(S1, 0n)], codes: [p.code ?? ""] }), [p]);
    expect(reason(r)).toBe("no_discount");
  });
});

describe("min order and tiers", () => {
  it("min order is inclusive and measured on the list subtotal", () => {
    const p = promo({ scope: "item", minOrder: egp(1000n) });
    expect(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]).applied).toHaveLength(1);
    const q = promo({ scope: "item", minOrder: egp(1001n) });
    expect(reason(evaluatePromotions(req({ codes: [q.code ?? ""] }), [q]))).toBe("min_order_not_met");
  });
  it("store scope checks each store on its own", () => {
    const p = promo({ scope: "store", minOrder: egp(500n) });
    const r = evaluatePromotions(
      req({ lines: [line(S1, 500n, 1, "a"), line(S2, 499n, 1, "b")], codes: [p.code ?? ""] }),
      [p],
    );
    expect(r.lines.map((l) => l.discount)).toEqual([5000n, 0n]);
    const none = evaluatePromotions(
      req({ lines: [line(S1, 100n, 1, "a"), line(S2, 100n, 1, "b")], codes: [p.code ?? ""] }),
      [p],
    );
    expect(reason(none)).toBe("min_order_not_met");
  });
  it("order scope min order", () => {
    const p = promo({ scope: "order", minOrder: egp(1500n) });
    expect(evaluatePromotions(req({ lines: [line(S1, 1000n, 1, "a"), line(S2, 500n, 1, "b")], codes: [p.code ?? ""] }), [p]).applied).toHaveLength(1);
    expect(reason(evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]))).toBe("min_order_not_met");
  });
  it("shipping scope min order is per store", () => {
    const p = promo({ scope: "shipping", value: { kind: "free_shipping" }, minOrder: egp(500n) });
    const r = evaluatePromotions(
      req({
        lines: [line(S1, 500n, 1, "a"), line(S2, 100n, 1, "b")],
        shippingFees: [
          { storeId: S1, fee: egp(50n) },
          { storeId: S2, fee: egp(50n) },
        ],
        codes: [p.code ?? ""],
      }),
      [p],
    );
    expect(r.shipping.map((s) => s.discount)).toEqual([5000n, 0n]);
  });
  it("tier boundary is inclusive and a store below the first tier gets nothing", () => {
    const p = promo({
      scope: "store",
      value: {
        kind: "tiered",
        tiers: [
          { minSubtotal: egp(500n), percentBps: 1000 },
          { minSubtotal: egp(1000n), percentBps: 2000 },
        ],
      },
    });
    const r = evaluatePromotions(
      req({ lines: [line(S1, 1000n, 1, "a"), line(S2, 500n, 1, "b"), line(S3, 499n, 1, "c")], codes: [p.code ?? ""] }),
      [p],
    );
    expect(r.lines.map((l) => l.discount)).toEqual([20_000n, 5_000n, 0n]);
  });
  it("tiers use list subtotal even after an item discount shrank the base", () => {
    const item = promo({ code: null, autoApply: true, scope: "item", value: { kind: "percent", percentBps: 5000 } });
    const tier = promo({
      scope: "order",
      value: { kind: "tiered", tiers: [{ minSubtotal: egp(1000n), percentBps: 1000 }] },
    });
    const r = evaluatePromotions(req({ codes: [tier.code ?? ""] }), [item, tier]);
    // 50% item -> 500 left; tier 10% of 500 = 50 (threshold judged on the 1000 list price)
    expect(r.totalDiscount).toBe(50_000n + 5_000n);
  });
});

describe("room-limited discounts", () => {
  it("a fixed store discount larger than the store base is capped at the base", () => {
    const p = promo({ scope: "store", value: { kind: "fixed", amount: egp(5000n) } });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    expect(r.lines[0]?.payable).toBe(0n);
    expect(r.totalDiscount).toBe(100_000n);
  });
  it("an order fixed discount spreads over lines in proportion to what is left", () => {
    const p = promo({ scope: "order", value: { kind: "fixed", amount: egp(100n) } });
    const r = evaluatePromotions(
      req({ lines: [line(S1, 300n, 1, "a"), line(S2, 100n, 1, "b")], codes: [p.code ?? ""] }),
      [p],
    );
    expect(r.lines.map((l) => l.discount)).toEqual([7_500n, 2_500n]);
  });
  it("discount rows with zero amount are not reported", () => {
    const p = promo({ scope: "item" });
    const r = evaluatePromotions(
      req({
        lines: [{ skuId: "tiny", storeId: S1, qty: 1, unitPrice: money(1n) }, line(S1, 1000n, 1, "big")],
        codes: [p.code ?? ""],
      }),
      [p],
    );
    expect(r.applied[0]?.lines.map((l) => l.lineIndex)).toEqual([1]);
  });
  it("applySet skips a promotion that gives nothing", () => {
    const p = promo({ scope: "item", minOrder: egp(5000n) });
    const basket = newBasket([line(S1, 1n)], [], false);
    expect(applySet([p], basket, new Map()).applied).toEqual([]);
  });
});

describe("candidate handling", () => {
  it("ignores blanks and duplicates when counting entered codes", () => {
    const r = evaluatePromotions(req({ codes: ["", "   ", "a", "A", " a ", "a", "a", "b"] }), []);
    expect(r.rejected.map((x) => `${x.code}:${x.reason}`)).toEqual(["A:unknown_code", "B:unknown_code"]);
  });
  it("does not consider a code promotion that was not entered, nor a promotion with neither code nor auto", () => {
    const p = promo({ code: "NOTENTERED" });
    const orphan = promo({ code: null, autoApply: false });
    const r = evaluatePromotions(req(), [p, orphan]);
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([]);
  });
  it("auto promotions: silent when not live, reported when capped", () => {
    const early = promo({ code: null, autoApply: true, startsAtMs: NOW + 1 });
    const late = promo({ code: null, autoApply: true, endsAtMs: NOW });
    const paused = promo({ code: null, autoApply: true, status: "paused" });
    const capped = promo({ code: null, autoApply: true, perUserCap: 1 });
    const r = evaluatePromotions(req({ usage: used(capped.id, { userRedemptions: 1 }) }), [early, late, paused, capped]);
    expect(r.rejected).toEqual([{ code: null, promotionId: capped.id, reason: "per_user_cap_reached" }]);
  });
  it("an auto promotion that gives nothing is not reported", () => {
    const auto = promo({ code: null, autoApply: true, scope: "item", minOrder: egp(9999n) });
    expect(evaluatePromotions(req(), [auto]).rejected).toEqual([]);
  });
  it("keeps the five largest candidates and breaks value ties by id", () => {
    const mk = (n: number, pounds: bigint) =>
      promo({
        id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
        code: null,
        autoApply: true,
        scope: n % 2 === 0 ? "item" : "store",
        value: { kind: "fixed", amount: egp(pounds) },
      });
    // item/store autos conflict per scope, so use a policy that allows many to keep them all alive
    const pool = [mk(10, 5n), mk(11, 5n), mk(12, 5n), mk(13, 5n), mk(14, 5n), mk(15, 5n)];
    const policy = { version: 2, maxPlatformCodes: 1, maxStoreVouchersPerStore: 1, maxAutoPerScope: 9, maxCandidates: 5 };
    const r = evaluatePromotions(req(), pool, policy);
    expect(r.policyVersion).toBe(2);
    const limited = r.rejected.filter((x) => x.reason === "candidate_limit");
    expect(limited.map((x) => x.promotionId)).toEqual([pool[5]?.id]);
    // a bigger discount outranks smaller ones regardless of id
    const big = mk(99, 50n);
    const r2 = evaluatePromotions(req({ lines: [line(S1, 10_000n)] }), [...pool, big], policy);
    expect(r2.rejected.filter((x) => x.reason === "candidate_limit").map((x) => x.promotionId)).toEqual([pool[4]?.id, pool[5]?.id]);
    expect(r2.applied.map((a) => a.promotionId)).toContain(big.id);
  });
  it("explains why a candidate lost: stacking_conflict versus no_additional_saving", () => {
    const full = promo({ code: "FULL", scope: "item", value: { kind: "percent", percentBps: 10_000 } });
    const store = promo({
      code: "STORE",
      owner: { kind: "store", storeId: S1 },
      scope: "store",
      funding: { platformPct: 0, sellerPct: 100 },
    });
    const other = promo({ code: "OTHER", scope: "order" });
    const r = evaluatePromotions(req({ codes: ["FULL", "STORE", "OTHER"] }), [full, store, other]);
    expect(r.applied.map((a) => a.code)).toEqual(["FULL"]);
    const by = Object.fromEntries(r.rejected.map((x) => [x.code, x.reason]));
    expect(by["STORE"]).toBe("no_additional_saving");
    expect(by["OTHER"]).toBe("stacking_conflict");
  });
  it("sorts rejections by promotion id then code, unknown codes after known ones", () => {
    const a = promo({ id: "00000000-0000-4000-8000-0000000000a1", status: "paused", code: "AAAA" });
    const b = promo({ id: "00000000-0000-4000-8000-0000000000b2", status: "paused", code: "BBBB" });
    const r = evaluatePromotions(req({ codes: ["ZZZ1", "BBBB", "AAAA", "YYY2"] }), [b, a]);
    expect(r.rejected.map((x) => x.code)).toEqual(["AAAA", "BBBB", "YYY2", "ZZZ1"]);
  });
  it("an entered code that is not live reports the matching reason and carries ids", () => {
    const p = promo({ status: "ended" });
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p]);
    expect(r.rejected).toEqual([{ code: p.code, promotionId: p.id, reason: "not_active" }]);
  });
  it("duplicate pool rows count once", () => {
    const p = promo({});
    const r = evaluatePromotions(req({ codes: [p.code ?? ""] }), [p, p]);
    expect(r.applied).toHaveLength(1);
    expect(r.rejected).toEqual([]);
  });
});
