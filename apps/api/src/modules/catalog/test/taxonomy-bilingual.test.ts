import { describe, expect, it } from "vitest";
import { SEED_BRANDS, SEED_CATEGORIES } from "../adapters/in-memory";
import { bilingualNameIssues, displayName } from "../domain/catalog-domain";

describe("taxonomy names are bilingual", () => {
  it("every seeded category (active or not) has an Arabic and an English name", () => {
    for (const c of SEED_CATEGORIES) {
      expect(bilingualNameIssues({ ar: c.nameAr, en: c.nameEn }, "/name"), c.slug).toEqual([]);
    }
  });
  it("every seeded brand has both names", () => {
    for (const b of SEED_BRANDS) expect(bilingualNameIssues({ ar: b.nameAr, en: b.nameEn }, "/name"), b.slug).toEqual([]);
  });
  it("a category without an English name is rejected for new or updated rows", () => {
    expect(bilingualNameIssues({ ar: "فساتين" }, "/name").map((i) => i.code)).toEqual(["title_en_missing"]);
    expect(displayName({ ar: "فساتين" }, "en")).toBe("فساتين");
  });
});
