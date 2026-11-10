import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listingStatusAvailability, pgInventoryAvailability } from "../src/index.js";
import { buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

describe("availability ports", () => {
  it("listingStatusAvailability trusts the listing: every requested sku is available, and an empty request is empty", async () => {
    const out = await listingStatusAvailability.availableSkus({ skuIdsByStore: new Map([["s1", ["a", "b"]], ["s2", ["c"]]]) });
    expect([...out].sort()).toEqual(["a", "b", "c"]);
    expect((await listingStatusAvailability.availableSkus({ skuIdsByStore: new Map() })).size).toBe(0);
  });

  it("pgInventoryAvailability: in stock and fully committed skus per store; a store with no skus is skipped without a query", async () => {
    const inStock = await w.seedSku(w.storeA, 1000, 3);
    const none = await w.seedSku(w.storeA, 1000, 0);
    const other = await w.seedSku(w.storeB, 1000, 1);
    await w.raw.query("UPDATE inventory_levels SET committed = 1 WHERE sku_id = $1", [other.skuId]);
    const port = pgInventoryAvailability(w.app, "EG");
    const out = await port.availableSkus({ skuIdsByStore: new Map([[w.storeA, [inStock.skuId, none.skuId]], [w.storeB, [other.skuId]]]) });
    expect([...out]).toEqual([inStock.skuId]);
    expect((await port.availableSkus({ skuIdsByStore: new Map([[w.storeA, []]]) })).size).toBe(0);
  });

  it("the store context isolates stock: a sku asked for under the wrong store is not reported available (RLS)", async () => {
    const mine = await w.seedSku(w.storeA, 1000, 2);
    const out = await pgInventoryAvailability(w.app, "EG").availableSkus({ skuIdsByStore: new Map([[w.storeB, [mine.skuId]]]) });
    expect(out.size).toBe(0);
  });
});
