import { describe, expect, it } from "vitest";
import { isRtl, resources } from "./index";

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
});
