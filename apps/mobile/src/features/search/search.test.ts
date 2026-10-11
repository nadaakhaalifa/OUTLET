import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER, InMemorySearchPort, arrangeResults, activeFilterCount, normalizeQuery, parseBudgetEgp, relaxLeastImportant,
  runSearch, toggleCondition, displayDiscountPct, type SearchFilter, type SearchItem,
} from "./model";

const item = (id: string, sponsored = false): SearchItem => ({ id, title: id, storeName: "s", price: 100n, verifiedDiscountPct: null, sponsored });

describe("query and budget parsing", () => {
  it("folds Eastern Arabic digits and trims", () => {
    expect(normalizeQuery("  فستان   ١٥٠٠ ")).toBe("فستان 1500");
    expect(normalizeQuery("x".repeat(500)).length).toBe(100);
  });
  it("parses budget to piastres", () => {
    expect(parseBudgetEgp("١٥٠٠")).toBe(150_000n);
    expect(parseBudgetEgp("1,500")).toBe(150_000n);
    expect(parseBudgetEgp("0")).toBeNull();
    expect(parseBudgetEgp("12.5")).toBeNull();
    expect(parseBudgetEgp("abc")).toBeNull();
  });
});

describe("filters", () => {
  it("counts active filters and toggles conditions", () => {
    const f = toggleCondition(toggleCondition({ ...EMPTY_FILTER, mySizeOnly: true }, "sample"), "minorDefect");
    expect(activeFilterCount(f)).toBe(3);
    expect(toggleCondition(f, "sample").conditions).toEqual(["minorDefect"]);
  });
  it("relaxes least important first and ends with null", () => {
    let f: SearchFilter = { ...EMPTY_FILTER, budgetMax: 1n, mySizeOnly: true, installmentsAvailable: true };
    const order: string[] = [];
    for (let r = relaxLeastImportant(f); r !== null; r = relaxLeastImportant(f)) { order.push(r.dropped); f = r.filter; }
    expect(order).toEqual(["installmentsAvailable", "mySizeOnly", "budgetMax"]);
  });
});

describe("sponsored cap", () => {
  it("keeps at most two sponsored in the top ten and preserves order", () => {
    const items = [item("s1", true), item("s2", true), item("s3", true), ...Array.from({ length: 12 }, (_, i) => item(`n${i}`))];
    const out = arrangeResults(items);
    expect(out.slice(0, 10).filter((i) => i.sponsored)).toHaveLength(2);
    expect(out).toHaveLength(items.length);
    expect(out.slice(0, 10).map((i) => i.id)).toEqual(["s1", "s2", "n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
  });
});

describe("discount display", () => {
  it("needs a verified integer percent of at least 5", () => {
    expect(displayDiscountPct({ verifiedDiscountPct: null })).toBeNull();
    expect(displayDiscountPct({ verifiedDiscountPct: 4 })).toBeNull();
    expect(displayDiscountPct({ verifiedDiscountPct: 30 })).toBe(30);
  });
});

describe("runSearch", () => {
  it("is idle with no query and no filters", async () => {
    expect((await runSearch(new InMemorySearchPort(), "  ", EMPTY_FILTER)).kind).toBe("idle");
  });
  it("returns results", async () => {
    const o = await runSearch(new InMemorySearchPort(), "jeans", EMPTY_FILTER);
    expect(o.kind).toBe("results");
  });
  it("relaxes on zero results and reports what was dropped", async () => {
    const o = await runSearch(new InMemorySearchPort(), "jeans", { ...EMPTY_FILTER, installmentsAvailable: true, conditions: ["sample"] });
    expect(o.kind).toBe("relaxed");
    if (o.kind === "relaxed") expect(o.dropped).toEqual(["installmentsAvailable", "conditions"]);
  });
  it("is empty when nothing matches even unfiltered", async () => {
    expect((await runSearch(new InMemorySearchPort(), "zzz", { ...EMPTY_FILTER, mySizeOnly: true })).kind).toBe("empty");
  });
  it("propagates port failure", async () => {
    const p = new InMemorySearchPort();
    p.setFailure("offline");
    await expect(runSearch(p, "jeans", EMPTY_FILTER)).rejects.toMatchObject({ kind: "offline" });
  });
  it("live count equals result count", async () => {
    const p = new InMemorySearchPort();
    const f = { ...EMPTY_FILTER, mySizeOnly: true };
    expect(await p.count("", f)).toBe((await p.search("", f)).total);
  });
});
