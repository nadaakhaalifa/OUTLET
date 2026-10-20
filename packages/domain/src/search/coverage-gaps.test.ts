import { describe, expect, it } from "vitest";
import { SponsoredRanker, departmentMatches, isArrayKey, normalizeSearchText, parseSearchQuery } from "./index";

describe("normalizeSearchText multi-pass", () => {
  it("re-runs when removing a mark lets NFKC compose a new character", () => {
    expect(normalizeSearchText("éً")).toBe("é");
  });
});

describe("filter helpers", () => {
  it("departmentMatches: unisex is visible to women and men, never to kids", () => {
    expect(departmentMatches(["women"], "women")).toBe(true);
    expect(departmentMatches(["women"], "unisex")).toBe(true);
    expect(departmentMatches(["men"], "unisex")).toBe(true);
    expect(departmentMatches(["kids"], "unisex")).toBe(false);
    expect(departmentMatches(["men"], "women")).toBe(false);
  });
  it("isArrayKey separates list facets from scalars", () => {
    expect(isArrayKey("colors")).toBe(true);
    expect(isArrayKey("priceMax")).toBe(false);
  });
});

describe("parseSearchQuery edges", () => {
  it("skips noise words", () => {
    const p = parseSearchQuery("show me the dress");
    expect(p.keywords).toBe("dress");
    expect(p.unparsed).toEqual([]);
  });
  it("binds a postfix minimum", () => {
    expect(parseSearchQuery("shoes 500 over").filter).toEqual({ priceMin: 50000n });
  });
  it("reports a between marker with no numbers", () => {
    expect(parseSearchQuery("dress between red").unparsed).toEqual(["between"]);
  });
  it("drops a currency word that follows a number", () => {
    expect(parseSearchQuery("nike 270 egp").keywords).toBe("nike 270");
  });
});

describe("SponsoredRanker.nextDeferred", () => {
  it("releases deferred sponsored items only once the window is full, in order", () => {
    const a = { sponsored: true, id: "a" };
    const b = { sponsored: true, id: "b" };
    const early = new SponsoredRanker<typeof a>({ emitted: 3, sponsoredTop: 2 }, [a]);
    expect(early.nextDeferred()).toBeNull();
    const full = new SponsoredRanker<typeof a>({ emitted: 10, sponsoredTop: 2 }, [a, b]);
    expect(full.nextDeferred()).toBe(a);
    expect(full.state.emitted).toBe(11);
    expect(full.nextDeferred()).toBe(b);
    expect(full.nextDeferred()).toBeNull();
  });
});
