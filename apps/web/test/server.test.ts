import { afterEach, describe, expect, it, vi } from "vitest";

const { revalidateTag } = vi.hoisted(() => ({ revalidateTag: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag }));

import { UnconfiguredApiClient, getApiClient, setApiClient, type ApiClient } from "../src/server/api-client";
import { loadDealBands, loadProduct, loadStore, loadStores } from "../src/server/loaders";
import { revalidateTags, tags } from "../src/server/cache-tags";

afterEach(() => {
  setApiClient(new UnconfiguredApiClient());
  revalidateTag.mockClear();
});

describe("loaders with the Unconfigured client never fabricate", () => {
  it("returns null / empty", async () => {
    expect(getApiClient()).toBeInstanceOf(UnconfiguredApiClient);
    expect(await loadProduct("eg", "p1")).toBeNull();
    expect(await loadStore("eg", "s")).toBeNull();
    expect(await loadStores("eg")).toEqual([]);
    expect(await loadDealBands("eg")).toEqual([]);
  });
  it("delegates to an injected client", async () => {
    const fake: ApiClient = {
      listStores: () => Promise.resolve([{ slug: "a", name: "A", category: "fashion" }]),
      getStore: () => Promise.resolve(null),
      getProduct: () => Promise.resolve(null),
      listDealBands: () => Promise.resolve([{ highPercent: 70, lowPercent: 60 }]),
    };
    setApiClient(fake);
    expect(await loadStores("eg")).toHaveLength(1);
    expect(await loadDealBands("eg")).toEqual([{ highPercent: 70, lowPercent: 60 }]);
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
