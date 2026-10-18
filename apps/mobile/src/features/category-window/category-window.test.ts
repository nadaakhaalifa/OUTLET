import { describe, expect, it } from "vitest";
import { InMemorySearchPort } from "../search/model";
import { FIXTURE_CATEGORIES } from "../shop-all/model";
import { loadCategoryCounts } from "./api";
import { childrenOf, opensDirectly, shopAllParams, validCount, windowRows } from "./model";

const tops = FIXTURE_CATEGORIES.find((c) => c.slug === "tops")!;
const dresses = FIXTURE_CATEGORIES.find((c) => c.slug === "dresses")!;
const tshirts = FIXTURE_CATEGORIES.find((c) => c.slug === "tshirts")!;
const shirts = FIXTURE_CATEGORIES.find((c) => c.slug === "shirts")!;

describe("category window rows", () => {
  it("first row is See all, then the children in tree order", () => {
    const rows = windowRows(FIXTURE_CATEGORIES, tops);
    expect(rows.map((r) => r.id)).toEqual([tops.id, tshirts.id, shirts.id]);
    expect(rows[0]?.kind).toBe("all");
  });
  it("no counts from the API means no number on any row", () => {
    for (const counts of [undefined, {}]) {
      for (const r of windowRows(FIXTURE_CATEGORIES, tops, counts)) {
        expect(r.count).toBeUndefined();
        if (r.kind === "child") expect(r.disabled).toBe(false);
      }
    }
  });
  it("counts come only from the API values; zero disables the child", () => {
    const rows = windowRows(FIXTURE_CATEGORIES, tops, { [tops.id]: 12, [tshirts.id]: 12, [shirts.id]: 0 });
    expect(rows.map((r) => r.count)).toEqual([12, 12, 0]);
    const last = rows[2];
    expect(last?.kind === "child" && last.disabled).toBe(true);
    const mid = rows[1];
    expect(mid?.kind === "child" && mid.disabled).toBe(false);
  });
  it("malformed counts are ignored", () => {
    expect(validCount({ a: -1 }, "a")).toBeUndefined();
    expect(validCount({ a: 1.5 }, "a")).toBeUndefined();
    expect(validCount({ a: Number.NaN }, "a")).toBeUndefined();
    expect(validCount({ a: 4 }, "a")).toBe(4);
    expect(validCount(undefined, "a")).toBeUndefined();
  });
  it("a node without children opens Shop all directly", () => {
    expect(opensDirectly(FIXTURE_CATEGORIES, dresses)).toBe(true);
    expect(opensDirectly(FIXTURE_CATEGORIES, tops)).toBe(false);
    expect(childrenOf(FIXTURE_CATEGORIES, dresses.id)).toEqual([]);
  });
  it("route params", () => {
    expect(shopAllParams(tops)).toEqual({ category: tops.id });
    expect(shopAllParams(tops, "women")).toEqual({ category: tops.id, department: "women" });
  });
});

describe("loadCategoryCounts", () => {
  it("is undefined while the search port sends no facet counts, and on failure", async () => {
    expect(await loadCategoryCounts(new InMemorySearchPort(), {})).toBeUndefined();
    const failing = new InMemorySearchPort(undefined, "offline");
    expect(await loadCategoryCounts(failing, {})).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("CategoryWindow renders a number only from counts", () => {
  it("the only numeric output is a count-derived value prop; with no counts no row has one", () => {
    const src = readFileSync(join(__dirname, "CategoryWindow.tsx"), "utf8");
    expect(src.match(/f\.num\(/g)?.length).toBe(3);
    expect(src).toMatch(/r\.count !== undefined \? \{ value: f\.num\(r\.count\) \}/);
    expect(src).not.toMatch(/\d+\+|many/);
    for (const r of windowRows(FIXTURE_CATEGORIES, tops, undefined)) expect(r.count).toBeUndefined();
  });
});
