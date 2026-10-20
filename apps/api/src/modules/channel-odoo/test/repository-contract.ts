import { describe, expect, it } from "vitest";
import type { OdooConfig, OdooStore, ProductLink } from "../domain/ports";

const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";
const T = (n: number) => `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`;
const CH = (n: number) => `00000000-0000-4000-d000-${String(n).padStart(12, "0")}`;
const SKU = (n: number) => `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`;
const NOW = Date.UTC(2026, 9, 12, 8, 0, 0);

export interface ContractFixture {
  readonly store: OdooStore;
  /** Creates the rows the config references (channel_connections + crawl target) where the backend needs them. */
  seed(channelId: string, storeId: string, targetId: string): Promise<void>;
}

const cfg = (n: number, storeId = STORE_A, o: Partial<OdooConfig> = {}): OdooConfig => ({
  channelId: CH(n),
  storeId,
  targetId: T(n),
  database: "haul_prod",
  uid: 7,
  pricelistId: null,
  stockLocationId: null,
  pollIntervalSeconds: 900,
  breakerFailures: 0,
  breakerOpenedAtMs: null,
  lastPolledAtMs: null,
  lastErrorCode: null,
  createdAtMs: NOW,
  ...o,
});
const link = (channel: number, product: number, sku: number, o: Partial<ProductLink> = {}): ProductLink => ({
  channelId: CH(channel),
  odooProductId: product,
  storeId: STORE_A,
  skuId: SKU(sku),
  lastPriceAmount: null,
  lastStockSourceVersion: null,
  lastStockQty: null,
  lastSyncedAtMs: null,
  ...o,
});

export function describeOdooStoreContract(name: string, fresh: () => Promise<ContractFixture>): void {
  describe(`OdooStore contract: ${name}`, () => {
    it("inserts once and reports an existing config on replay", async () => {
      const { store, seed } = await fresh();
      await seed(CH(1), STORE_A, T(1));
      const c = cfg(1);
      expect((await store.insertConfig(c)).kind).toBe("created");
      const again = await store.insertConfig({ ...c, database: "other" });
      expect(again.kind).toBe("exists");
      expect(again.config.database).toBe("haul_prod");
      expect(await store.getConfig(CH(1))).toEqual(c);
      expect(await store.getConfig(CH(2))).toBeNull();
      expect(await store.getConfig("not-a-uuid")).toBeNull();
    });

    it("lists per store only and round-trips poll state and the breaker", async () => {
      const { store, seed } = await fresh();
      await seed(CH(1), STORE_A, T(1));
      await seed(CH(2), STORE_B, T(2));
      await store.insertConfig(cfg(1));
      await store.insertConfig(cfg(2, STORE_B));
      expect((await store.listConfigs(STORE_A)).map((c) => c.channelId)).toEqual([CH(1)]);
      const next = cfg(1, STORE_A, { breakerFailures: 5, breakerOpenedAtMs: NOW + 1_000, lastPolledAtMs: NOW + 2_000, lastErrorCode: "http_error" });
      await store.updateConfig(next);
      expect(await store.getConfig(CH(1))).toEqual(next);
    });

    it("lists due channels by their own poll interval", async () => {
      const { store, seed } = await fresh();
      await seed(CH(1), STORE_A, T(1));
      await seed(CH(2), STORE_A, T(2));
      await seed(CH(3), STORE_A, T(3));
      await store.insertConfig(cfg(1));
      await store.insertConfig(cfg(2, STORE_A, { lastPolledAtMs: NOW - 400_000, pollIntervalSeconds: 600 }));
      await store.insertConfig(cfg(3, STORE_A, { lastPolledAtMs: NOW - 700_000, pollIntervalSeconds: 600 }));
      const due = (await store.listDue(NOW, 10)).map((c) => c.channelId);
      expect(due).toEqual([CH(1), CH(3)]);
      expect(await store.listDue(NOW, 1)).toHaveLength(1);
    });

    it("upserts product links and keeps bigint prices exact", async () => {
      const { store, seed } = await fresh();
      await seed(CH(1), STORE_A, T(1));
      await store.insertConfig(cfg(1));
      await store.upsertLink(link(1, 101, 1));
      await store.upsertLink(link(1, 102, 2, { lastPriceAmount: 9_007_199_254_740_993n, lastStockSourceVersion: 1_791_000_000, lastStockQty: 11, lastSyncedAtMs: NOW }));
      await store.upsertLink(link(1, 101, 1, { lastPriceAmount: 150_000n, lastStockQty: 0, lastStockSourceVersion: 5, lastSyncedAtMs: NOW }));
      const ls = await store.links(CH(1));
      expect(ls.map((l) => l.odooProductId)).toEqual([101, 102]);
      expect(ls[0]).toMatchObject({ lastPriceAmount: 150_000n, lastStockQty: 0, lastStockSourceVersion: 5 });
      expect(ls[1]?.lastPriceAmount).toBe(9_007_199_254_740_993n);
      expect(await store.links(CH(9))).toEqual([]);
    });
  });
}
