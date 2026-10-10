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
