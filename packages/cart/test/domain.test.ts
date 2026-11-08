import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { money } from "@outlet/money";
import {
  CartError, DEFAULT_THRESHOLD_MINOR, MAX_LINES, MAX_QTY_PER_SKU, freeDelivery, freeDeliverySuggestionsInput, groupByStore, itemsSubtotal, lineState, mergeQty, noticesOf,
} from "../src/index.js";
import type { CartLineRow, CatalogSnapshot, SkuSnapshot, StoreSnapshot } from "../src/index.js";

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const line = (n: number, storeN: number, qty: number, price: bigint): CartLineRow => ({
  id: id(1000 + n), skuId: id(2000 + n), productId: id(3000 + n), storeId: id(storeN), qty, priceAtAddMinor: price, currency: "EGP", source: "pdp", addedAt: "2030-01-01T00:00:00.000Z", lastState: "ok",
});
const store = (n: number, thresholdMinor?: bigint): StoreSnapshot => ({ storeId: id(n), slug: `s${String(n)}`, nameAr: "متجر", ...(thresholdMinor === undefined ? {} : { thresholdMinor }) });
const sku = (l: CartLineRow, price: bigint, available = true): SkuSnapshot => ({ skuId: l.skuId, priceMinor: price, currency: "EGP", available });

describe("lineState", () => {
  const l = line(1, 1, 1, 1000n);
  it("covers every state", () => {
    expect(lineState(l, sku(l, 1000n), true)).toBe("ok");
    expect(lineState(l, sku(l, 900n), true)).toBe("price_dropped");
    expect(lineState(l, sku(l, 1100n), true)).toBe("price_rose");
    expect(lineState(l, sku(l, 1000n, false), true)).toBe("unavailable");
    expect(lineState(l, undefined, true)).toBe("unavailable");
    expect(lineState(l, { ...sku(l, 1000n), currency: "USD" }, true)).toBe("unavailable");
    expect(lineState(l, sku(l, 1000n), false)).toBe("store_locked");
  });
});

describe("section 6 acceptance", () => {
  it("store A at 1,950 EGP + a 60 EGP item unlocks free delivery", () => {
    const base = line(1, 1, 1, 195_000n);
    const extra = line(2, 1, 1, 6_000n);
    const snap = (lines: CartLineRow[]): CatalogSnapshot => ({ skus: new Map(lines.map((x) => [x.skuId, sku(x, x.priceAtAddMinor)])), stores: new Map([[id(1), store(1)]]) });
    const before = groupByStore([base], snap([base]), "EGP")[0];
    expect(before?.freeDelivery).toEqual({ thresholdMinor: 200_000n, remainingMinor: 5_000n, unlocked: false });
    const after = groupByStore([base, extra], snap([base, extra]), "EGP")[0];
    expect(after?.subtotal.amountMinor).toBe(201_000n);
    expect(after?.freeDelivery.unlocked).toBe(true);
  });
  it("store B at 2,100 EGP alone is unlocked", () => {
    const b = line(3, 2, 1, 210_000n);
    const g = groupByStore([b], { skus: new Map([[b.skuId, sku(b, b.priceAtAddMinor)]]), stores: new Map([[id(2), store(2)]]) }, "EGP")[0];
    expect(g?.freeDelivery.unlocked).toBe(true);
    expect(g?.freeDelivery.remainingMinor).toBe(0n);
  });
});

describe("groupByStore", () => {
  it("excludes unavailable lines from the subtotal, keeps them listed, and uses a per-store threshold", () => {
    const a = line(1, 1, 2, 5000n);
    const b = line(2, 1, 1, 7000n);
    const snap: CatalogSnapshot = { skus: new Map([[a.skuId, sku(a, 4000n)], [b.skuId, sku(b, 7000n, false)]]), stores: new Map([[id(1), store(1, 8000n)]]) };
    const g = groupByStore([a, b], snap, "EGP")[0];
    expect(g?.lines.map((v) => v.state)).toEqual(["price_dropped", "unavailable"]);
    expect(g?.subtotal.amountMinor).toBe(8000n);
    expect(g?.freeDelivery.unlocked).toBe(true);
    expect(noticesOf(g ? [g] : []).map((n) => n.code)).toEqual(["price_dropped", "unavailable"]);
  });
  it("locks a store missing from the snapshot and notifies per line", () => {
    const a = line(1, 1, 1, 5000n);
    const groups = groupByStore([a], { skus: new Map([[a.skuId, sku(a, 5000n)]]), stores: new Map() }, "EGP", 0n);
    const g = groups[0];
    expect(g?.locked).toBe(true);
    expect(g?.subtotal.amountMinor).toBe(0n);
    expect(g?.freeDelivery.unlocked).toBe(false);
    expect(g ? freeDeliverySuggestionsInput(g) : 1).toBeNull();
    expect(noticesOf(groups)).toEqual([{ code: "store_suspended", lineId: a.id }]);
    expect(itemsSubtotal(groups, "EGP")).toEqual(money(0n, "EGP"));
  });
  it("builds the suggestion input for a locked-out progress bar", () => {
    const a = line(1, 1, 1, 5000n);
    const g = groupByStore([a], { skus: new Map([[a.skuId, sku(a, 5000n)]]), stores: new Map([[id(1), store(1)]]) }, "EGP")[0];
    expect(g ? freeDeliverySuggestionsInput(g) : null).toEqual({ storeId: id(1), remainingMinor: DEFAULT_THRESHOLD_MINOR - 5000n, currency: "EGP", excludeSkuIds: [a.skuId] });
    const done = groupByStore([line(2, 1, 1, 300_000n)], { skus: new Map([[line(2, 1, 1, 1n).skuId, sku(line(2, 1, 1, 1n), 300_000n)]]), stores: new Map([[id(1), store(1)]]) }, "EGP")[0];
    expect(done ? freeDeliverySuggestionsInput(done) : 1).toBeNull();
  });
});

describe("limits", () => {
  it("merges and enforces 10 per sku and 50 lines", () => {
    expect(mergeQty({ lines: [{ skuId: "a", qty: 4 }], skuId: "a", qty: 3 })).toBe(7);
    expect(() => mergeQty({ lines: [{ skuId: "a", qty: 8 }], skuId: "a", qty: 3 })).toThrow(CartError);
    const full = Array.from({ length: MAX_LINES }, (_, i) => ({ skuId: `s${String(i)}`, qty: 1 }));
    expect(() => mergeQty({ lines: full, skuId: "new", qty: 1 })).toThrow(/at most 50/);
    expect(mergeQty({ lines: full, skuId: "s3", qty: 1 })).toBe(2);
    for (const bad of [0, 11, 1.5, -1]) expect(() => mergeQty({ lines: [], skuId: "a", qty: bad })).toThrow(/qty must be/);
  });
});

describe("properties", () => {
  const lineArb = fc.record({ store: fc.integer({ min: 1, max: 3 }), qty: fc.integer({ min: 1, max: MAX_QTY_PER_SKU }), added: fc.integer({ min: 1, max: 500_000 }), live: fc.integer({ min: 1, max: 500_000 }), avail: fc.boolean() });
  it("subtotal = sum of live price x qty of purchasable lines; progress never negative; unlocked iff subtotal >= threshold", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { maxLength: 20 }), fc.integer({ min: 0, max: 1_000_000 }), fc.boolean(), (specs, threshold, lockStore3) => {
        const lines = specs.map((s, i) => line(i, s.store, s.qty, BigInt(s.added)));
        const skus = new Map(lines.map((l, i) => [l.skuId, sku(l, BigInt(specs[i]?.live ?? 1), specs[i]?.avail ?? true)]));
        const stores = new Map([1, 2, 3].filter((n) => !(lockStore3 && n === 3)).map((n) => [id(n), store(n, BigInt(threshold))]));
        const groups = groupByStore(lines, { skus, stores }, "EGP");
        for (const g of groups) {
          const expected = g.lines.filter((v) => v.state === "ok" || v.state === "price_dropped" || v.state === "price_rose").reduce((a, v) => a + (skus.get(v.line.skuId)?.priceMinor ?? 0n) * BigInt(v.line.qty), 0n);
          expect(g.subtotal.amountMinor).toBe(expected);
          expect(g.freeDelivery.remainingMinor >= 0n).toBe(true);
          expect(g.freeDelivery.unlocked).toBe(!g.locked && g.subtotal.amountMinor >= BigInt(threshold));
          if (g.locked) expect(g.subtotal.amountMinor).toBe(0n);
        }
        expect(itemsSubtotal(groups, "EGP").amountMinor).toBe(groups.reduce((a, g) => a + g.subtotal.amountMinor, 0n));
      }),
    );
  });
  it("freeDelivery remaining + subtotal reaches the threshold when locked-out", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.bigInt({ min: 0n, max: 10n ** 12n }), (sub, th) => {
      const f = freeDelivery(sub, th, false);
      expect(f.unlocked).toBe(sub >= th);
      if (!f.unlocked) expect(sub + f.remainingMinor).toBe(th);
    }));
  });
  it("limits: merged qty never exceeds 10, lines never exceed 50", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 10 }), { maxLength: 60 }), fc.integer({ min: 1, max: 10 }), (qtys, add) => {
      const lines = qtys.slice(0, MAX_LINES).map((q, i) => ({ skuId: `s${String(i)}`, qty: q }));
      try {
        const m = mergeQty({ lines, skuId: "s0", qty: add });
        expect(m).toBeLessThanOrEqual(MAX_QTY_PER_SKU);
      } catch (e) {
        expect(e).toBeInstanceOf(CartError);
      }
    }));
  });
});
