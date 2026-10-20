import { describe, expect, it } from "vitest";
import {
  COUNTRIES, InMemoryRegionPrefPort, countryName, flagEmoji, flagFor, foldSearch, isServed, makePref, preselectedCountry, searchCountries, sortedCountries,
} from "./model";

const iso = COUNTRIES.filter((c) => !c.userAssigned);

describe("country dataset", () => {
  it("has all 249 ISO 3166-1 alpha-2 codes, unique, plus only XK as user-assigned", () => {
    expect(iso).toHaveLength(249);
    expect(new Set(COUNTRIES.map((c) => c.code)).size).toBe(COUNTRIES.length);
    expect(COUNTRIES.filter((c) => c.userAssigned).map((c) => c.code)).toEqual(["XK"]);
    for (const code of ["EG", "US", "GB", "DE", "SA", "AE", "PS", "TW", "HK", "EH", "AQ", "BV", "AX", "SS"]) expect(iso.some((c) => c.code === code)).toBe(true);
  });
  it("has non-empty EN and AR names, Arabic in Arabic script", () => {
    for (const c of COUNTRIES) {
      expect(c.en.trim().length).toBeGreaterThan(1);
      expect(c.ar).toMatch(/[؀-ۿ]/);
    }
    expect(countryName(COUNTRIES.find((c) => c.code === "EG")!, "en")).toBe("Egypt");
    expect(countryName(COUNTRIES.find((c) => c.code === "EG")!, "ar")).toBe("مصر");
  });
});

describe("flags", () => {
  it("builds regional indicators from the code", () => {
    expect(flagEmoji("EG")).toBe("\u{1F1EA}\u{1F1EC}");
    expect(flagEmoji("de")).toBeNull();
    expect(flagEmoji("E")).toBeNull();
  });
  it("uses a code badge for XK and malformed codes, emoji otherwise", () => {
    expect(flagFor({ code: "XK", userAssigned: true })).toEqual({ kind: "badge", text: "XK" });
    expect(flagFor({ code: "1X", userAssigned: false }).kind).toBe("badge");
    expect(flagFor({ code: "FR", userAssigned: false })).toEqual({ kind: "emoji", glyph: "\u{1F1EB}\u{1F1F7}" });
  });
});

describe("sort and search", () => {
  it("pins Egypt first in both languages and sorts the rest", () => {
    for (const l of ["en", "ar"]) {
      const s = sortedCountries(l);
      expect(s[0]?.code).toBe("EG");
      expect(s).toHaveLength(COUNTRIES.length);
    }
    const en = sortedCountries("en").slice(1, 4).map((c) => c.en);
    expect(en).toEqual([...en].sort((a, b) => a.localeCompare(b, "en")));
  });
  it("falls back to a safe comparator", () => {
    const s = sortedCountries("ar", (a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(s[0]?.code).toBe("EG");
  });
  it("folds alef, ya, ta marbuta, diacritics, digits and Latin accents", () => {
    expect(foldSearch("أمريكا")).toBe(foldSearch("امريكا"));
    expect(foldSearch("إيطاليا")).toBe(foldSearch("ايطاليا"));
    expect(foldSearch("مستشفى")).toBe(foldSearch("مستشفي"));
    expect(foldSearch("تونسة")).toBe(foldSearch("تونسه"));
    expect(foldSearch("مِصْر")).toBe("مصر");
    expect(foldSearch("Côte d’Ivoire")).toContain("cote");
    expect(foldSearch("١٢٣")).toBe("123");
  });
  it("searches names in both scripts and by code, Egypt stays first", () => {
    const list = sortedCountries("en");
    expect(searchCountries(list, "germ", "en").map((c) => c.code)).toContain("DE");
    expect(searchCountries(list, "المانيا", "ar").map((c) => c.code)).toContain("DE");
    expect(searchCountries(list, "ايطاليا", "ar").map((c) => c.code)).toContain("IT");
    expect(searchCountries(list, "turk", "en").map((c) => c.code)).toContain("TR");
    expect(searchCountries(list, "xk", "en").map((c) => c.code)).toEqual(["XK"]);
    expect(searchCountries(list, "  ", "en")).toBe(list);
    expect(searchCountries(list, "zzzzzz", "en")).toHaveLength(0);
    expect(searchCountries(list, "e", "en")[0]?.code).toBe("EG");
  });
});

describe("availability and preselect", () => {
  it("serves Egypt only", () => {
    expect(COUNTRIES.filter((c) => isServed(c.code)).map((c) => c.code)).toEqual(["EG"]);
  });
  it("preselects only when the device region is EG", () => {
    expect(preselectedCountry("EG")).toBe("EG");
    expect(preselectedCountry("eg")).toBe("EG");
    expect(preselectedCountry("DE")).toBeNull();
    expect(preselectedCountry(null)).toBeNull();
  });
});

describe("preference port", () => {
  it("stores and clears; market is always EG", async () => {
    const p = new InMemoryRegionPrefPort();
    expect(await p.load()).toBeNull();
    await p.save(makePref("DE", null));
    expect(await p.load()).toEqual({ v: 1, country: "DE", market: "EG", shopFor: null });
    await p.clear();
    expect(await p.load()).toBeNull();
  });
});
