import { describe, expect, it } from "vitest";
import { catalogs, createTranslator, interpolate, pickLocale } from "../i18n";
import { en } from "../i18n/en";

const ph = (s: string): string[] => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1] ?? "").sort();

describe("shopper-web i18n", () => {
  it("AR and EN have identical keys, non-empty values and identical placeholders", () => {
    expect(Object.keys(catalogs.ar).sort()).toEqual(Object.keys(catalogs.en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(catalogs.ar[k].trim(), k).not.toBe("");
      expect(ph(catalogs.ar[k]), k).toEqual(ph(catalogs.en[k]));
    }
  });
  it("Arabic copy is Arabic (except the language switch label)", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      if (k === "common.language") continue;
      expect(/[؀-ۿ]/.test(catalogs.ar[k]), k).toBe(true);
    }
  });
  it("interpolates and defaults to Arabic", () => {
    expect(interpolate("a {{x}} {{y}}", { x: 1 })).toBe("a 1 {{y}}");
    expect(createTranslator("en")("search.resultsFor", { q: "x" })).toBe('Results for "x"');
    expect(pickLocale(null)).toBe("ar");
    expect(pickLocale("en-US,ar")).toBe("en");
  });
});
