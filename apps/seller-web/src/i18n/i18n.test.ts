import { describe, expect, it } from "vitest";
import { createTranslator, catalogs, interpolate, pickLocale } from "./index";
import { en } from "./en";

const placeholders = (s: string): string[] => [...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1] ?? "").sort();

describe("seller-web i18n parity", () => {
  it("has the same keys in AR and EN", () => {
    expect(Object.keys(catalogs.ar).sort()).toEqual(Object.keys(catalogs.en).sort());
  });
  it("has no empty values and identical placeholders", () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(catalogs.ar[k].trim(), k).not.toBe("");
      expect(catalogs.en[k].trim(), k).not.toBe("");
      expect(placeholders(catalogs.ar[k]), k).toEqual(placeholders(catalogs.en[k]));
    }
  });
  it("Arabic copy contains Arabic letters (not an English copy)", () => {
    const allowedSame = new Set(["common.language"]);
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      if (allowedSame.has(k)) continue;
      expect(/[؀-ۿ]/.test(catalogs.ar[k]), k).toBe(true);
    }
  });
  it("interpolates and leaves unknown placeholders visible", () => {
    expect(interpolate("a {{x}} {{y}}", { x: 1 })).toBe("a 1 {{y}}");
    expect(createTranslator("en")("common.asOf", { time: "10:00" })).toBe("As of 10:00");
  });
  it("defaults to Arabic", () => {
    expect(pickLocale(null)).toBe("ar");
    expect(pickLocale("en-US")).toBe("en");
  });
});
