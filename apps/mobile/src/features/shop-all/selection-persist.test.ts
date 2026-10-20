import { describe, expect, it } from "vitest";
import { EMPTY_LISTING_FILTERS } from "../filters/model";
import { storesChanged } from "./listing-model";
import { isCategoryLayout, shouldPersistSelection, type SelectionOrigin } from "./model";

describe("saved store selection", () => {
  it("is overwritten only by the shopper's own changes", () => {
    const origins: readonly SelectionOrigin[] = ["route", "storage", "prune", "user"];
    expect(origins.filter(shouldPersistSelection)).toEqual(["user"]);
  });
  it("opening a store collection from the route does not overwrite it (route origin never persists)", () => {
    expect(shouldPersistSelection("route")).toBe(false);
    expect(shouldPersistSelection("prune")).toBe(false);
  });
});

describe("unisex route department", () => {
  it("does not switch the screen into the category layout", () => {
    expect(isCategoryLayout({ department: "unisex" }, false)).toBe(false);
    expect(isCategoryLayout({ department: "women" }, false)).toBe(true);
  });
});

describe("saved selection follows only store changes", () => {
  it("is written when the stores change, not for other filters", () => {
    const one = { ...EMPTY_LISTING_FILTERS, storeIds: ["a"] };
    expect(storesChanged(EMPTY_LISTING_FILTERS, one)).toBe(true);
    expect(storesChanged(one, { ...one, freeDelivery: true })).toBe(false);
    expect(storesChanged(one, { ...one, storeIds: ["b"] })).toBe(true);
    expect(storesChanged(one, EMPTY_LISTING_FILTERS)).toBe(true);
  });
});
