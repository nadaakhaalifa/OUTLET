import { describe, expect, it } from "vitest";
import {
  FIXTURE_STORES, InMemoryWorldPreference, InMemoryWorldsPort, buildDirectory, decodePreference, encodePreference,
  failureState, worldAfterWiden, type StoreSummary,
} from "./model";

const ids = (rows: readonly StoreSummary[]) => rows.map((r) => r.id);

describe("buildDirectory", () => {
  it("hides suspended stores everywhere and filters by world", () => {
    expect(ids(buildDirectory(FIXTURE_STORES, "local", "az").rows)).toEqual(["s1", "s2"]);
    expect(ids(buildDirectory(FIXTURE_STORES, "global", "az").rows)).toEqual(["s3"]);
    expect(ids(buildDirectory(FIXTURE_STORES, "everything", "az").rows)).toEqual(["s3", "s1", "s2"].sort((a, b) => FIXTURE_STORES.find((s) => s.id === a)!.name.localeCompare(FIXTURE_STORES.find((s) => s.id === b)!.name)));
  });
  it("sorts trending by rank and puts unknown discounts last", () => {
    expect(ids(buildDirectory(FIXTURE_STORES, "everything", "trending").rows)).toEqual(["s3", "s1", "s2"]);
    expect(ids(buildDirectory(FIXTURE_STORES, "everything", "biggestDiscount").rows)).toEqual(["s3", "s1", "s2"]);
    expect(ids(buildDirectory(FIXTURE_STORES, "everything", "fastestDelivery").rows)).toEqual(["s2", "s1", "s3"]);
    expect(ids(buildDirectory(FIXTURE_STORES, "everything", "newDrops").rows)).toEqual(["s1", "s3", "s2"]);
  });
  it("explains hidden suspended favourites in My Stores only", () => {
    const v = buildDirectory(FIXTURE_STORES, "myStores", "trending");
    expect(ids(v.rows)).toEqual(["s3", "s1"]);
    expect(v.hiddenFavouriteCount).toBe(1);
    expect(buildDirectory(FIXTURE_STORES, "local", "trending").hiddenFavouriteCount).toBe(0);
  });
  it("offers widening when My Stores is empty", () => {
    const none = FIXTURE_STORES.map((s) => ({ ...s, isFavourite: false }));
    const v = buildDirectory(none, "myStores", "trending");
    expect(v.empty).toBe("noFavourites");
    expect(v.canWiden).toBe(true);
    expect(worldAfterWiden()).toBe("everything");
    const onlySuspended = FIXTURE_STORES.map((s) => ({ ...s, isFavourite: s.status === "suspended" }));
    expect(buildDirectory(onlySuspended, "myStores", "trending").empty).toBe("favouritesHidden");
    expect(buildDirectory([], "local", "az").empty).toBe("noStores");
    expect(buildDirectory([], "local", "az").canWiden).toBe(false);
  });
});

describe("preference and ports", () => {
  it("round-trips and rejects malformed values", () => {
    expect(decodePreference(encodePreference({ world: "global", sort: "az" }))).toEqual({ world: "global", sort: "az" });
    expect(decodePreference("nope")).toBeNull();
    expect(decodePreference("global|az|x")).toBeNull();
    expect(decodePreference(null)).toBeNull();
  });
  it("persists in the fake and reports offline versus failed", async () => {
    const p = new InMemoryWorldPreference();
    await p.save({ world: "local", sort: "newDrops" });
    expect(await p.load()).toEqual({ world: "local", sort: "newDrops" });
    const port = new InMemoryWorldsPort();
    port.setFailure("offline");
    const e = await port.listStores().catch((x: unknown) => x);
    expect(failureState(e)).toEqual({ status: "error", offline: true });
    expect(failureState(new Error("x"))).toEqual({ status: "error", offline: false });
  });
});

import { CATEGORY_TILES, nodeForSlug, rowsOf, storeCount } from "./model";

describe("explore tiles", () => {
  it("lays out three tiles per row: 12 tiles make 4 full rows", () => {
    const rows = rowsOf(CATEGORY_TILES, 3);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.length === 3)).toBe(true);
    expect(CATEGORY_TILES).toHaveLength(12);
  });
  it("covers every item exactly once, in order, with only the last row short", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    for (let run = 0; run < 200; run++) {
      const items = Array.from({ length: rnd(41) }, (_, i) => i);
      const n = 1 + rnd(4);
      const rows = rowsOf(items, n);
      expect(rows.flat()).toEqual(items);
      rows.slice(0, -1).forEach((r) => expect(r).toHaveLength(n));
      if (rows.length > 0) expect(rows[rows.length - 1]!.length).toBeLessThanOrEqual(n);
    }
  });
  it("maps a tile slug to a tree node, top level first", () => {
    const tree = [{ slug: "x", parentId: "p" }, { slug: "x", parentId: null }];
    expect(nodeForSlug(tree, "x")).toBe(tree[1]);
    expect(nodeForSlug(tree, "nope")).toBeNull();
  });
  it("counts only active stores of the scope", () => {
    expect(storeCount(FIXTURE_STORES, "everything")).toBe(3);
    expect(storeCount(FIXTURE_STORES, "myStores")).toBe(2);
    expect(storeCount([], "local")).toBe(0);
  });
});

import { DISCOVER_DEPARTMENTS, departmentParams } from "./model";
describe("discover departments", () => {
  it("uses the department attribute for women/men/kids and a text query for lifestyle", () => {
    expect(DISCOVER_DEPARTMENTS.map((d) => d.id)).toEqual(["women", "men", "kids", "lifestyle"]);
    expect(departmentParams("women", "Women")).toEqual({ department: "women" });
    expect(departmentParams("lifestyle", "Lifestyle")).toEqual({ q: "Lifestyle" });
  });
});
