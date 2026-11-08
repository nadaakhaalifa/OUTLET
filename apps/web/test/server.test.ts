import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidateTag } = vi.hoisted(() => ({ revalidateTag: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag }));

import { UnconfiguredApiClient, type ApiClient } from "../src/server/api-client";
import { getApiClient, setApiClient } from "../src/server/client-registry";
import { loadDealShelves, loadProduct, loadStore, loadStoreDirectory, loadStoreProducts } from "../src/server/loaders";
import { product } from "./fixtures";
import { revalidateTags, tags } from "../src/server/cache-tags";

afterEach(() => {
  setApiClient(null);
  revalidateTag.mockClear();
});

describe("loaders with the Unconfigured client never fabricate", () => {
  it("returns null / empty", async () => {
    expect(getApiClient()).toBeInstanceOf(UnconfiguredApiClient);
    expect(await loadProduct("eg", "p1")).toBeNull();
    expect(await loadStore("eg", "s")).toBeNull();
    expect(await loadStoreDirectory("eg")).toEqual({ stores: [], nextCursor: null, reason: "UNCONFIGURED" });
    expect(await loadStoreProducts("eg", "s")).toEqual({ items: [], nextCursor: null });
    expect(await loadDealShelves("eg")).toEqual([]);
  });
  it("delegates to an injected client", async () => {
    const fake: ApiClient = {
      listStores: () => Promise.resolve({ stores: [{ id: "i1", slug: "a", nameAr: "أ", nameEn: "A", kind: "local" as const }], nextCursor: null, reason: "OK" as const }),
      getStore: () => Promise.resolve(null),
      listStoreProducts: () => Promise.resolve({ items: [], nextCursor: null }),
      getProduct: () => Promise.resolve(null),
      listCategories: () => Promise.resolve([]),
      listDeals: (_m, band) => Promise.resolve(band === "70_60" ? [product(1)] : []),
    };
    setApiClient(fake);
    expect((await loadStoreDirectory("eg")).stores).toHaveLength(1);
    const shelves = await loadDealShelves("eg");
    expect(shelves).toHaveLength(1);
    expect(shelves[0]?.band.code).toBe("70_60");
  });
});

describe("cache tags", () => {
  it("builds tags and revalidates each with stale-while-revalidate", () => {
    expect([tags.product("1"), tags.store("s"), tags.market("eg")]).toEqual(["product:1", "store:s", "market:eg"]);
    revalidateTags(["product:1", "store:s"]);
    expect(revalidateTag).toHaveBeenCalledTimes(2);
    expect(revalidateTag).toHaveBeenCalledWith("product:1", "max");
  });
});
