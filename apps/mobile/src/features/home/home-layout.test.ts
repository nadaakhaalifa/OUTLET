import { describe, expect, it } from "vitest";
import {
  DEPARTMENTS, FIXTURE_HOME, HOME_SECTION_ORDER, departmentTarget, dropIndicator, dropPageIndex, homeFilterCount, homeFilterParams, upcomingDrops,
  DROP_CARD_GAP, dropCardWidth,
} from "./model";
import { EMPTY_SHOP_FILTERS, FIXTURE_CATEGORIES, shopFiltersReducer, parseShopRouteParams, MAX_CATEGORY_FILTER } from "../shop-all/model";

const NOW = FIXTURE_HOME.serverNowMs;

describe("home layout order", () => {
  it("pins the owner's vertical order", () => {
    expect(HOME_SECTION_ORDER).toEqual(["offers", "quickActions", "departments", "drops", "rails", "stores"]);
  });
});

describe("upcomingDrops", () => {
  it("lists live first then soonest, one per real drop", () => {
    const out = upcomingDrops(FIXTURE_HOME, NOW);
    expect(out.map((d) => d.id)).toEqual(["d2", "d1", "d3"]);
    expect(out[0]?.countdown).toBeNull();
    expect(out[1]?.countdown).not.toBeNull();
  });
  it("drops passed, non-live drops and renders nothing without drops", () => {
    const passed = { ...FIXTURE_HOME, drops: [{ id: "x", title: "t", storeName: "", variant: "drop" as const, startsAtMs: NOW - 1000, live: false }] };
    expect(upcomingDrops(passed, NOW)).toEqual([]);
    expect(upcomingDrops({ hero: null }, NOW)).toEqual([]);
  });
  it("falls back to the single hero on older adapters", () => {
    expect(upcomingDrops({ hero: FIXTURE_HOME.hero }, NOW)).toHaveLength(1);
  });
});

describe("drops paging", () => {
  const w = dropCardWidth(390);
  it("leaves a peek of the next card", () => {
    expect(w + DROP_CARD_GAP + 20 + 8).toBeLessThan(390 + 40);
    expect(w).toBeLessThan(390 - 20);
  });
  it("clamps the page index", () => {
    expect(dropPageIndex(0, w, 3)).toBe(0);
    expect(dropPageIndex(w + DROP_CARD_GAP, w, 3)).toBe(1);
    expect(dropPageIndex(99999, w, 3)).toBe(2);
    expect(dropPageIndex(-50, w, 3)).toBe(0);
    expect(dropPageIndex(Number.NaN, w, 3)).toBe(0);
  });
  it("indicator only with two or more cards", () => {
    expect(dropIndicator(0, 1)).toBeNull();
    expect(dropIndicator(1, 3)).toEqual({ current: 2, total: 3 });
    expect(dropIndicator(9, 3)).toEqual({ current: 3, total: 3 });
  });
});

describe("department mapping", () => {
  it("Women, Men and Kids use the department attribute; Accessories is a category (slug when present, else text)", () => {
    expect(departmentTarget(FIXTURE_CATEGORIES, "kids")).toEqual({ department: "kids" });
    expect(departmentTarget(FIXTURE_CATEGORIES, "women")).toEqual({ department: "women" });
    expect(departmentTarget([], "men")).toEqual({ department: "men" });
    expect(departmentTarget(FIXTURE_CATEGORIES, "accessories")).toEqual({ category: "accessories" });
    expect(departmentTarget([], "accessories")).toEqual({ q: "accessories" });
    expect(DEPARTMENTS).toHaveLength(4);
  });
});

describe("home filter state to params", () => {
  const dresses = FIXTURE_CATEGORIES.find((c) => c.slug === "dresses")!;
  const denim = FIXTURE_CATEGORIES.find((c) => c.slug === "denim")!;
  it("counts categories, budget and non-default world", () => {
    let f = shopFiltersReducer(EMPTY_SHOP_FILTERS, { type: "toggleCategory", id: dresses.id });
    f = shopFiltersReducer(f, { type: "toggleCategory", id: denim.id });
    f = shopFiltersReducer(f, { type: "setBudget", budget: { min: 10_000n, max: 50_000n } });
    expect(homeFilterCount(f, true)).toBe(3);
    expect(homeFilterCount(f, false)).toBe(4);
    expect(homeFilterCount(EMPTY_SHOP_FILTERS, true)).toBe(0);
  });
  it("round-trips through /shop-all params", () => {
    let f = shopFiltersReducer(EMPTY_SHOP_FILTERS, { type: "toggleCategory", id: dresses.id });
    f = shopFiltersReducer(f, { type: "toggleCategory", id: denim.id });
    f = shopFiltersReducer(f, { type: "setBudget", budget: { min: null, max: 150_000n } });
    const params = homeFilterParams(f, FIXTURE_CATEGORIES);
    expect(params).toEqual({ category: "dresses,denim", max: "1500" });
    const back = parseShopRouteParams(params, FIXTURE_CATEGORIES);
    expect(back.categoryIds).toEqual([dresses.id, denim.id]);
    expect(back.budget).toEqual({ min: null, max: 150_000n });
  });
  it("caps category selection at the 30 limit", () => {
    let f = EMPTY_SHOP_FILTERS;
    for (let i = 0; i < 40; i++) f = shopFiltersReducer(f, { type: "toggleCategory", id: `c${i}` });
    expect(f.categoryIds).toHaveLength(MAX_CATEGORY_FILTER);
  });
});

import { DEPARTMENT_SCRIM_OPACITY, DEPARTMENT_TONE } from "./model";
import { brand } from "@outlet/ui-tokens";

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
function blend(fg: string, bg: string, a: number): string {
  const ch = [1, 3, 5].map((i) => Math.round(parseInt(fg.slice(i, i + 2), 16) * a + parseInt(bg.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0"));
  return `#${ch.join("")}`;
}
describe("department tiles", () => {
  it("have distinct tones and ivory labels clear AA over the ink scrim", () => {
    expect(new Set(DEPARTMENTS.map((d) => DEPARTMENT_TONE[d])).size).toBe(DEPARTMENTS.length);
    for (const d of DEPARTMENTS) {
      const bg = blend(brand.ink, DEPARTMENT_TONE[d], DEPARTMENT_SCRIM_OPACITY);
      expect((lum(brand.ivory) + 0.05) / (lum(bg) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
