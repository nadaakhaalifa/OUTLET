import { describe, expect, it, vi } from "vitest";
import { ALPHA3_TO_ALPHA2, defaultRegion, mayWriteRegion, readStorefront, storefrontToRegion, suggestLanguage, unconfiguredStorefront } from "./default-region";
import { COUNTRIES, InMemoryRegionPrefPort, makePref } from "./model";

describe("storefront alpha-3 to alpha-2", () => {
  it("maps every country in the picker, one to one", () => {
    const back = new Map(Object.entries(ALPHA3_TO_ALPHA2).map(([a3, a2]) => [a2, a3]));
    expect(Object.keys(ALPHA3_TO_ALPHA2).every((k) => /^[A-Z]{3}$/.test(k))).toBe(true);
    expect(back.size).toBe(Object.keys(ALPHA3_TO_ALPHA2).length);
    expect(COUNTRIES.filter((c) => !back.has(c.code)).map((c) => c.code)).toEqual([]);
    expect([...back.keys()].filter((a2) => !COUNTRIES.some((c) => c.code === a2))).toEqual([]);
  });
  it("maps well-known storefronts", () => {
    expect(storefrontToRegion("EGY")).toBe("EG");
    expect(storefrontToRegion("usa")).toBe("US");
    expect(storefrontToRegion(" GBR ")).toBe("GB");
    expect(storefrontToRegion("ARE")).toBe("AE");
    expect(storefrontToRegion("SAU")).toBe("SA");
    expect(storefrontToRegion("DEU")).toBe("DE");
  });
  it("unknown, empty or already alpha-2 values are ignored", () => {
    for (const v of ["", "EG", "XXX", null, undefined]) expect(storefrontToRegion(v)).toBeNull();
  });
});

describe("default region order: storefront, locale region, Egypt", () => {
  it("storefront wins", () => expect(defaultRegion("USA", "EG")).toEqual({ code: "US", source: "storefront" }));
  it("then the locale region", () => expect(defaultRegion(null, "gb")).toEqual({ code: "GB", source: "locale" }));
  it("a wrong or unusable storefront falls through to the locale", () => expect(defaultRegion("???", "AE")).toEqual({ code: "AE", source: "locale" }));
  it("then Egypt, including a null locale region", () => {
    expect(defaultRegion(null, null)).toEqual({ code: "EG", source: "fallback" });
    expect(defaultRegion(undefined, "ZZ")).toEqual({ code: "EG", source: "fallback" });
  });
  it("no storefront reader is configured yet and a failing reader counts as none", async () => {
    expect(await readStorefront(unconfiguredStorefront)).toBeNull();
    expect(await readStorefront({ countryCode: async () => { throw new Error("storekit"); } })).toBeNull();
  });
});

describe("first-launch-only persistence", () => {
  it("writes when nothing is saved, or in edit mode; never overwrites on a second first-launch pass", () => {
    expect(mayWriteRegion({ edit: false, existing: false })).toBe(true);
    expect(mayWriteRegion({ edit: false, existing: true })).toBe(false);
    expect(mayWriteRegion({ edit: true, existing: true })).toBe(true);
  });
  it("the port keeps what was saved and edit replaces it", async () => {
    const port = new InMemoryRegionPrefPort();
    await port.save(makePref("EG", null));
    await port.save(makePref("EG", "women"));
    expect((await port.load())?.shopFor).toBe("women");
  });
});

describe("language is a separate setting", () => {
  it("suggests only in edit mode, only when no language was ever chosen, only when it differs", () => {
    expect(suggestLanguage({ edit: true, languageChosen: false, region: "EG", current: "en" })).toBe("ar");
    expect(suggestLanguage({ edit: false, languageChosen: false, region: "EG", current: "en" })).toBeNull();
    expect(suggestLanguage({ edit: true, languageChosen: true, region: "EG", current: "en" })).toBeNull();
    expect(suggestLanguage({ edit: true, languageChosen: false, region: "EG", current: "ar" })).toBeNull();
    expect(suggestLanguage({ edit: true, languageChosen: false, region: "US", current: "en" })).toBeNull();
  });
});

describe("'Somewhere else' makes no server or analytics call", () => {
  it("the not-available view source has no input, analytics or network reference", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${__dirname}/WelcomeRegionScreen.tsx`, "utf8");
    const view = src.slice(src.indexOf("function NotAvailable"));
    expect(view).not.toMatch(/TextField|SearchField|TextInput|fetch\(|analytics|services\.api|track|region\.save/);
    expect(vi.isMockFunction(fetch)).toBe(false);
  });
});
