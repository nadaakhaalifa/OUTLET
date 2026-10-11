import { describe, expect, it } from "vitest";
import { ar } from "./ar";
import { en } from "./en";
import { createTranslator, isRtl, pickLocale } from "./index";

describe("i18n", () => {
  it("has the same keys in both catalogs and no empty strings", () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const [k, v] of Object.entries(ar)) expect(v.trim(), k).not.toBe("");
  });
  it("keeps interpolation placeholders identical across locales", () => {
    const ph = (s: string): string[] => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] as string).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(ph(ar[k]), k).toEqual(ph(en[k]));
  });
  it("defaults to Arabic RTL and interpolates", () => {
    expect(pickLocale(undefined)).toBe("ar");
    expect(pickLocale("en-GB")).toBe("en");
    expect(isRtl("ar")).toBe(true);
    expect(createTranslator("en")("clock.left.days", { n: 3 })).toBe("3 days left");
  });
});
