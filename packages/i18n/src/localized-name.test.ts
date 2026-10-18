import { describe, expect, it } from "vitest";
import { isEnglishNameMissing, localizedName } from "./localized-name";

describe("localizedName", () => {
  it("returns the requested language when present", () => {
    expect(localizedName({ ar: "فستان", en: "Dress" }, "en")).toBe("Dress");
    expect(localizedName({ ar: "فستان", en: "Dress" }, "ar")).toBe("فستان");
  });
  it("falls back to the other language when the requested one is blank or missing", () => {
    expect(localizedName({ ar: "فستان", en: "  " }, "en")).toBe("فستان");
    expect(localizedName({ ar: "فستان" }, "en")).toBe("فستان");
    expect(localizedName({ ar: " ", en: "Dress" }, "ar")).toBe("Dress");
  });
  it("is blank only when both are blank", () => {
    expect(localizedName({ ar: "", en: null }, "en")).toBe("");
    expect(localizedName({ ar: "", en: "" }, "ar")).toBe("");
  });
  it("flags a missing English name", () => {
    expect(isEnglishNameMissing({ ar: "أ" })).toBe(true);
    expect(isEnglishNameMissing({ ar: "أ", en: " " })).toBe(true);
    expect(isEnglishNameMissing({ ar: "أ", en: "A" })).toBe(false);
  });
});
