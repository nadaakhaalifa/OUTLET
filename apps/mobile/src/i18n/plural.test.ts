import { describe, expect, it } from "vitest";
import { resources } from "@outlet/i18n";
import { arabicPluralCategory, pluralForm, pluralKey } from "./plural";

const SAMPLE = [0, 1, 2, 3, 10, 11, 99, 100, 101, 102, 103, 110, 111] as const;

describe("CLDR Arabic plural category", () => {
  it("follows the rules for 0,1,2,3,10,11,99,100,101,102,103,110,111", () => {
    expect(SAMPLE.map(arabicPluralCategory)).toEqual(["zero", "one", "two", "few", "few", "many", "many", "other", "other", "other", "few", "few", "many"]);
  });
  it("uses n % 100 for larger numbers and never crashes on odd input", () => {
    expect([200, 203, 211, 1000, 1003, 1011, 1100].map(arabicPluralCategory)).toEqual(["other", "few", "many", "other", "few", "many", "other"]);
    expect(arabicPluralCategory(Number.NaN)).toBe("other");
    expect(arabicPluralCategory(-3)).toBe("few");
    expect(arabicPluralCategory(2.7)).toBe("two");
    expect(pluralForm(0)).toBe("Other");
  });
  it("builds keys", () => { expect(pluralKey("shopAll.productCount", 3)).toBe("shopAll.productCountFew"); });
});

const lookup = (cat: unknown, key: string): unknown => key.split(".").reduce<unknown>((n, k) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[k] : undefined), cat);

/** Every plural family used by the app: [base key, placeholder used in the Few/Many/Other forms]. */
const FAMILIES: readonly (readonly [string, string])[] = [
  ["tabsBagCount", "n"], ["home.bagLabelCount", "count"], ["orders.sellersCount", "count"], ["bag.itemsCaption", "count"],
  ["shopAll.productCount", "n"], ["shopFilter.count", "n"], ["shopFilter.categoryLimit", "max"], ["storesDir.count", "n"], ["storesDir.shopSelected", "n"],
  ["shopFilter.applied", "n"], ["storesDir.filter.applied", "n"], ["storesDir.filter.show", "n"], ["storesDir.filter.govA11y", "n"],
];

describe("plural keys exist in both languages for every form", () => {
  for (const [base, ph] of FAMILIES) {
    it(base, () => {
      for (const n of SAMPLE) {
        const key = pluralKey(base, n);
        for (const lang of ["ar", "en"] as const) {
          const v = lookup(resources[lang], key);
          expect(typeof v, `${lang}.${key}`).toBe("string");
        }
      }
      for (const form of ["Few", "Many", "Other"]) {
        expect(lookup(resources.ar, base + form) as string, `ar ${base}${form}`).toContain(`{{${ph}}}`);
        expect(lookup(resources.en, base + form) as string, `en ${base}${form}`).toContain(`{{${ph}}}`);
      }
    });
  }
  it("English singular reads '1 product'", () => {
    expect(resources.en.shopAll.productCountOne).toBe("1 product");
    expect(resources.ar.shopAll.productCountTwo).toBe("منتجان");
  });
  it("has no leftover fixed-count keys or removed dead keys", () => {
    for (const lang of ["ar", "en"] as const) {
      const r = resources[lang] as unknown as Record<string, Record<string, unknown>>;
      expect(r.shopAll).not.toHaveProperty("productCount");
      for (const dead of ["pillBrand", "pillSize", "pillCategory", "pillPrice"]) expect(r.shopAll).not.toHaveProperty(dead);
      expect(r.storesDir).not.toHaveProperty("filtersLabel");
    }
  });
});
