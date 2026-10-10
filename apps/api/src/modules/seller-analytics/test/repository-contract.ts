import { beforeEach, describe, expect, it } from "vitest";
import type { AnalyticsStore, SourceEvent } from "../domain/ports";

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";
export const T0 = 1_800_000_000_000;
export const DAY = 86_400_000;
export const RANGE = { fromMs: T0 - 30 * DAY, toMs: T0 + DAY };
export const NOW = T0 + 60_000;

let seq = 100_000;
const mid = (): string => U(++seq);
export const shopper = (n: number): string => `shopper-key-${String(n).padStart(6, "0")}`;

type Distribute<T> = T extends unknown ? Omit<T, "messageId" | "occurredAtMs" | "storeId" | "shopperKey"> : never;
type Body = Distribute<SourceEvent>;

export const ev = (body: Body, o: { store?: string; shopper?: number | null; at?: number; id?: string } = {}): SourceEvent =>
  ({
    ...body,
    messageId: o.id ?? mid(),
    occurredAtMs: o.at ?? T0 - DAY,
    storeId: o.store ?? STORE_A,
    shopperKey: o.shopper === null ? null : shopper(o.shopper ?? 1),
  }) as SourceEvent;

export const P1 = U(10);
export const P2 = U(11);
export const SKU_M = U(20);
export const SKU_L = U(21);
export const ORDER = (n: number): string => U(5000 + n);

export const purchase = (order: number, sku: string, product: string, qty: number, gross: bigint, o: Parameters<typeof ev>[1] & { gov?: string; size?: string } = {}) =>
  ev(
    {
      kind: "purchase",
      productId: product,
      skuId: sku,
      sellerOrderId: ORDER(order),
      qty,
      grossMinor: gross,
      commissionMinor: gross / 10n,
      sizeLabel: o.size ?? "M",
      ...(o.gov === undefined ? {} : { governorate: o.gov }),
    },
    o,
  );

export interface StoreContext {
  readonly store: AnalyticsStore;
}

/** Behaviour every AnalyticsStore must have. Run against in-memory and Kysely/PGlite. */
export function describeAnalyticsStoreContract(name: string, make: () => Promise<StoreContext>): void {
  describe(`AnalyticsStore contract: ${name}`, () => {
    let s: AnalyticsStore;
    beforeEach(async () => {
      s = (await make()).store;
    });

    it("ingest is idempotent by message id", async () => {
      const e = ev({ kind: "view", productId: P1, source: "feed" }, { id: U(1) });
      expect(await s.ingest("c", [e], NOW)).toEqual({ applied: 1, duplicates: 0 });
      expect(await s.ingest("c", [e, e], NOW)).toEqual({ applied: 0, duplicates: 2 });
      expect((await s.trafficTotals(STORE_A, RANGE)).productViews).toBe(1);
    });

    it("traffic counts views and distinct visitors, and buckets by source", async () => {
      await s.ingest("c", [
        ev({ kind: "store_view", source: "feed" }, { shopper: 1 }),
        ev({ kind: "view", productId: P1, source: "feed" }, { shopper: 1 }),
        ev({ kind: "view", productId: P1, source: "search" }, { shopper: 2 }),
        ev({ kind: "view", productId: P1, source: "search" }, { shopper: 2, at: T0 - 40 * DAY }),
      ], NOW);
      expect(await s.trafficTotals(STORE_A, RANGE)).toEqual({ storeViews: 1, productViews: 2, uniqueVisitors: 2 });
      const by = Object.fromEntries((await s.trafficBySource(STORE_A, RANGE)).map((c) => [c.key, [c.distinctShoppers, c.value]]));
      expect(by).toEqual({ feed: [1, 2], search: [1, 1] });
    });

    it("funnel counts every stage per product", async () => {
      await s.ingest("c", [
        ev({ kind: "impression", productId: P1 }),
        ev({ kind: "impression", productId: P1 }, { shopper: 2 }),
        ev({ kind: "view", productId: P1 }),
        ev({ kind: "save", productId: P1 }),
        ev({ kind: "bag", productId: P1 }),
        ev({ kind: "checkout", productId: P1 }),
        purchase(1, SKU_M, P1, 1, 10_000n),
        ev({ kind: "impression", productId: P2 }),
      ], NOW);
      const f = await s.funnelByProduct(STORE_A, RANGE);
      expect(f).toEqual([
        { productId: P1, counts: { impression: 2, view: 1, save: 1, bag: 1, checkout: 1, purchase: 1 } },
        { productId: P2, counts: { impression: 1, view: 0, save: 0, bag: 0, checkout: 0, purchase: 0 } },
      ]);
    });

    it("sales totals sum integer piastres and count orders, shoppers and repeaters", async () => {
      await s.ingest("c", [
        purchase(1, SKU_M, P1, 2, 20_000n, { shopper: 1 }),
        purchase(1, SKU_L, P1, 1, 10_001n, { shopper: 1 }),
        purchase(2, SKU_M, P1, 1, 10_000n, { shopper: 1 }),
        purchase(3, SKU_M, P1, 1, 10_000n, { shopper: 2 }),
      ], NOW);
      expect(await s.salesTotals(STORE_A, RANGE)).toEqual({
        gmvMinor: 50_001n,
        commissionMinor: 2000n + 1000n + 1000n + 1000n,
        units: 5,
        orders: 3,
        distinctShoppers: 2,
        repeatShoppers: 1,
      });
    });

    it("sku sales, return rate inputs and reasons", async () => {
      await s.ingest("c", [
        purchase(1, SKU_M, P1, 3, 30_000n),
        ev({ kind: "return", productId: P1, skuId: SKU_M, qty: 1, reason: "too_small" }),
        ev({ kind: "return", productId: P1, skuId: SKU_M, qty: 1, reason: "too_small" }, { shopper: 3 }),
        ev({ kind: "return", productId: P1, skuId: SKU_M, qty: 1, reason: "defective" }),
      ], NOW);
      expect(await s.skuSales(STORE_A, RANGE)).toEqual([{ skuId: SKU_M, productId: P1, soldUnits: 3, returnedUnits: 3 }]);
      expect(await s.returnReasons(STORE_A, RANGE)).toEqual([
        { skuId: SKU_M, productId: P1, reason: "defective", units: 1 },
        { skuId: SKU_M, productId: P1, reason: "too_small", units: 2 },
      ]);
    });

    it("stock snapshots keep the newest observation and the earliest listing time", async () => {
      const snap = (onHand: number, at: number, listed: number, price = 50_000n) =>
        ev({ kind: "stock_snapshot", productId: P1, skuId: SKU_M, sizeLabel: "M", onHand, priceMinor: price, listedAtMs: listed }, { shopper: null, at });
      await s.ingest("c", [snap(10, T0 - 2 * DAY, T0 - 50 * DAY)], NOW);
      await s.ingest("c", [snap(99, T0 - 5 * DAY, T0 - 90 * DAY, 1_000n)], NOW); // stale observation
      const [row] = await s.stockLevels(STORE_A);
      expect(row).toEqual({ skuId: SKU_M, productId: P1, sizeLabel: "M", onHand: 10, priceMinor: 50_000n, listedAtMs: T0 - 90 * DAY });
      await s.ingest("c", [snap(4, T0 - DAY, T0 - 10 * DAY)], NOW);
      expect((await s.stockLevels(STORE_A))[0]?.onHand).toBe(4);
    });

    it("search terms and geography carry distinct shopper counts per cell", async () => {
      const evs: SourceEvent[] = [];
      for (let i = 1; i <= 3; i += 1) {
        evs.push(ev({ kind: "search_click", term: "linen dress" }, { shopper: i }));
        evs.push(purchase(100 + i, SKU_M, P1, 1, 10_000n, { shopper: i, gov: "Cairo" }));
      }
      evs.push(ev({ kind: "search_click", term: "linen dress" }, { shopper: 1 }));
      evs.push(purchase(200, SKU_M, P1, 1, 5_000n, { shopper: 9, gov: "Giza" }));
      await s.ingest("c", evs, NOW);
      expect(await s.searchTerms(STORE_A, RANGE)).toEqual([{ key: "linen dress", distinctShoppers: 3, value: 4 }]);
      const geo = await s.geography(STORE_A, RANGE);
      expect(geo.map((g) => [g.key, g.distinctShoppers, g.value.orders, g.value.gmvMinor])).toEqual([
        ["Cairo", 3, 3, 30_000n],
        ["Giza", 1, 1, 5_000n],
      ]);
    });

    it("never mixes stores", async () => {
      await s.ingest("c", [
        purchase(1, SKU_M, P1, 1, 10_000n, { store: STORE_B, gov: "Cairo" }),
        ev({ kind: "view", productId: P1 }, { store: STORE_B }),
        ev({ kind: "search_click", term: "secret" }, { store: STORE_B }),
        ev({ kind: "stock_snapshot", productId: P1, skuId: SKU_M, sizeLabel: "M", onHand: 1, priceMinor: 1000n, listedAtMs: T0 - DAY }, { store: STORE_B, shopper: null }),
      ], NOW);
      expect((await s.salesTotals(STORE_A, RANGE)).gmvMinor).toBe(0n);
      expect((await s.trafficTotals(STORE_A, RANGE)).productViews).toBe(0);
      expect(await s.searchTerms(STORE_A, RANGE)).toEqual([]);
      expect(await s.geography(STORE_A, RANGE)).toEqual([]);
      expect(await s.stockLevels(STORE_A)).toEqual([]);
      expect(await s.freshness(STORE_A)).toBeNull();
      expect((await s.salesTotals(STORE_B, RANGE)).gmvMinor).toBe(10_000n);
    });

    it("tracks freshness per store", async () => {
      await s.ingest("c", [ev({ kind: "view", productId: P1 }, { at: T0 - 5000 })], NOW);
      expect(await s.freshness(STORE_A)).toEqual({ lastEventMs: T0 - 5000, lastIngestMs: NOW });
    });

    it("no read method returns a shopper key", async () => {
      await s.ingest("c", [
        ev({ kind: "view", productId: P1, source: "feed" }, { shopper: 7 }),
        ev({ kind: "search_click", term: "linen" }, { shopper: 7 }),
        purchase(1, SKU_M, P1, 1, 1000n, { shopper: 7, gov: "Cairo" }),
      ], NOW);
      const all = await Promise.all([
        s.trafficTotals(STORE_A, RANGE),
        s.trafficBySource(STORE_A, RANGE),
        s.funnelByProduct(STORE_A, RANGE),
        s.salesTotals(STORE_A, RANGE),
        s.skuSales(STORE_A, RANGE),
        s.returnReasons(STORE_A, RANGE),
        s.stockLevels(STORE_A),
        s.searchTerms(STORE_A, RANGE),
        s.geography(STORE_A, RANGE),
        s.freshness(STORE_A),
      ]);
      const json = JSON.stringify(all, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
      expect(json).not.toContain(shopper(7));
      expect(json).not.toContain("shopper");
    });
  });
}
