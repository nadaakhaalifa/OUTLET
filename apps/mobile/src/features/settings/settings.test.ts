import { describe, expect, it } from "vitest";
import { languageAt, languageIndex, notificationState, themeAt, themeIndex } from "./model";

describe("settings model", () => {
  it("maps language and theme indexes both ways", () => {
    expect(languageAt(languageIndex("en-GB"))).toBe("en");
    expect(languageAt(languageIndex("ar"))).toBe("ar");
    expect(themeAt(themeIndex("dark"))).toBe("dark");
    expect(themeAt(9)).toBe("system");
  });
  it("reads notification toggles as off unless granted", () => {
    expect(notificationState([])).toEqual({ marketing_push: false, marketing_whatsapp: false, marketing_email: false });
    expect(notificationState([{ purpose: "marketing_push", granted: true }])["marketing_push"]).toBe(true);
  });
});

import { directionReloadNeeded, parseStoredLanguage, startupLanguage } from "./model";

describe("language persistence", () => {
  it("ignores unknown stored values", () => {
    expect(parseStoredLanguage("fr")).toBeNull();
    expect(parseStoredLanguage(null)).toBeNull();
    expect(parseStoredLanguage("en")).toBe("en");
  });
  it("prefers the stored choice over the device language", () => {
    expect(startupLanguage("en", "ar")).toBe("en");
    expect(startupLanguage("zz", "ar")).toBe("ar");
    expect(startupLanguage(null, "en")).toBe("en");
  });
  it("asks for a reload only on a direction mismatch", () => {
    expect(directionReloadNeeded("ar", true)).toBe(false);
    expect(directionReloadNeeded("ar", false)).toBe(true);
    expect(directionReloadNeeded("en", false)).toBe(false);
    expect(directionReloadNeeded("en", true)).toBe(true);
  });
});
