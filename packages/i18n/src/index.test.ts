import { describe, expect, it } from "vitest";
import { isRtl, resolveLocale, resources } from "./index";

function keys(obj: unknown, prefix = ""): string[] {
  if (typeof obj === "string") return [prefix];
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

function leaves(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (obj && typeof obj === "object") return Object.values(obj).flatMap(leaves);
  return [];
}

describe("i18n resources", () => {
  it("has identical key sets in ar and en", () => {
    expect(keys(resources.ar).sort()).toEqual(keys(resources.en).sort());
  });
  it("has no empty Arabic strings", () => {
    for (const s of leaves(resources.ar)) expect(s.trim().length).toBeGreaterThan(0);
  });
  it("treats Arabic as RTL and English as LTR", () => {
    expect(isRtl("ar")).toBe(true);
    expect(isRtl("en")).toBe(false);
  });
  it("resolves device language, defaulting to Arabic", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("ar")).toBe("ar");
    expect(resolveLocale("fr")).toBe("ar");
    expect(resolveLocale(null)).toBe("ar");
    expect(resolveLocale(undefined)).toBe("ar");
  });
});

describe("product name", () => {
  it("is Z-OUTLET and no catalog hard-codes a legacy name", async () => {
    const { PRODUCT_NAME } = await import("./index");
    expect(PRODUCT_NAME).toBe("Z-OUTLET");
    const all = [...leaves(resources.ar), ...leaves(resources.en)].join("\n");
    expect(all).not.toMatch(/Z-OUTLET|HAUL|أوتلت/);
  });
  it("uses the same placeholders in both languages for the new age keys", () => {
    expect(resources.en.age.blocked.until).toContain("{{date}}");
    expect(resources.ar.age.blocked.until).toContain("{{date}}");
  });
});
