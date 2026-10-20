import { describe, expect, it } from "vitest";
import { S1, S2, egp, promo } from "./fixtures";
import { applicationOrder, chooseBest, compareText, violatesStacking } from "./stacking";
import { DEFAULT_STACKING_POLICY } from "./types";

const store = (storeId: string, code: string | null = "X") =>
  promo({ owner: { kind: "store", storeId }, code, autoApply: code === null, funding: { platformPct: 0, sellerPct: 100 } });

describe("stacking matrix", () => {
  it("compares text by code unit", () => {
    expect(compareText("a", "b")).toBe(-1);
    expect(compareText("b", "a")).toBe(1);
    expect(compareText("a", "a")).toBe(0);
  });

  it("one platform code, one store voucher per store, one auto per scope", () => {
    const p = DEFAULT_STACKING_POLICY;
    expect(violatesStacking([promo({ code: "A" }), promo({ code: "B" })], p)).toBe(true);
    expect(violatesStacking([promo({ code: "A" })], p)).toBe(false);
    expect(violatesStacking([store(S1, "A"), store(S1, "B")], p)).toBe(true);
    expect(violatesStacking([store(S1, "A"), store(S2, "B")], p)).toBe(false);
    const auto = (scope: "item" | "store") => promo({ code: null, autoApply: true, scope });
    expect(violatesStacking([auto("item"), auto("item")], p)).toBe(true);
    expect(violatesStacking([auto("item"), auto("store")], p)).toBe(false);
    expect(violatesStacking([], p)).toBe(false);
    // the three classes do not count against each other
    expect(violatesStacking([promo({ code: "A" }), store(S1, "B"), auto("item")], p)).toBe(false);
  });

  it("honours a changed policy", () => {
    const loose = { ...DEFAULT_STACKING_POLICY, maxPlatformCodes: 2 };
    expect(violatesStacking([promo({ code: "A" }), promo({ code: "B" })], loose)).toBe(false);
  });

  it("orders item, store, order, shipping, then kind, then id", () => {
    const ship = promo({ scope: "shipping", value: { kind: "free_shipping" } });
    const order = promo({ scope: "order" });
    const storeP = promo({ scope: "store" });
    const itemPct = promo({ scope: "item" });
    const itemBogo = promo({ scope: "item", value: { kind: "bogo", buyQty: 1, getQty: 1, getPercentBps: 10_000 } });
    const ordered = applicationOrder([ship, order, itemPct, storeP, itemBogo]);
    expect(ordered.map((p) => p.id)).toEqual([itemBogo, itemPct, storeP, order, ship].map((p) => p.id));
    const lo = promo({ id: "00000000-0000-4000-8000-0000000000a1" });
    const hi = promo({ id: "00000000-0000-4000-8000-0000000000b2" });
    expect(applicationOrder([hi, lo]).map((p) => p.id)).toEqual([lo.id, hi.id]);
    expect(applicationOrder([lo, hi]).map((p) => p.id)).toEqual([lo.id, hi.id]);
    // same scope, different kinds: kind rank wins over id
    const fixed = promo({ id: "00000000-0000-4000-8000-0000000000ff", scope: "order", value: { kind: "fixed", amount: egp(1n) } });
    const pct = promo({ id: "00000000-0000-4000-8000-000000000001", scope: "order" });
    expect(applicationOrder([pct, fixed]).map((p) => p.id)).toEqual([fixed.id, pct.id]);
  });
});

describe("chooseBest", () => {
  it("picks the cheapest valid subset, preferring fewer promotions on a tie", () => {
    const a = promo({ code: "A" });
    const b = promo({ code: "B" });
    const c = store(S1, "C");
    const price = (s: readonly { id: string }[]): bigint => {
      const ids = new Set(s.map((x) => x.id));
      return 1000n - (ids.has(a.id) ? 100n : 0n) - (ids.has(b.id) ? 150n : 0n) - (ids.has(c.id) ? 0n : 0n);
    };
    const best = chooseBest([a, b, c], DEFAULT_STACKING_POLICY, price);
    expect(best.subset.map((p) => p.id)).toEqual([b.id]);
    expect(best.payable).toBe(850n);
  });
  it("breaks equal-size ties by id order", () => {
    const a = promo({ code: "A" });
    const b = promo({ code: "B" });
    const best = chooseBest([b, a], DEFAULT_STACKING_POLICY, () => 5n);
    expect(best.subset).toEqual([]);
    const best2 = chooseBest([b, a], DEFAULT_STACKING_POLICY, (s) => (s.length === 1 ? 4n : 5n));
    expect(best2.subset.map((p) => p.id)).toEqual([a.id]);
  });
  it("breaks full ties (same payable, same size) by the smaller id list", () => {
    const loose = { ...DEFAULT_STACKING_POLICY, maxPlatformCodes: 5 };
    const ids = ["00000000-0000-4000-8000-0000000000c3", "00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2"];
    const ps = ids.map((id, i) => promo({ id, code: `T${i}ZZ` }));
    // every non-empty subset of size 2 costs the same; size 1 costs more, size 3 costs more
    const price = (s: readonly unknown[]): bigint => (s.length === 2 ? 10n : 20n);
    const best = chooseBest(ps, loose, price);
    expect(best.subset.map((p) => p.id).sort()).toEqual([ids[1], ids[2]].sort());
  });

  it("returns the empty set when no promotions are given", () => {
    expect(chooseBest([], DEFAULT_STACKING_POLICY, () => 9n)).toEqual({ subset: [], payable: 9n });
  });
});
