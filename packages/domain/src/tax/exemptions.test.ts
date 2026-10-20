import { describe, expect, it } from "vitest";
import { DEFAULT_TAX_CATEGORIES, applyExemptionChange, effectiveRateBps, exemptionActiveAt } from "./exemptions";

const std = DEFAULT_TAX_CATEGORIES[0];
if (std === undefined) throw new Error("seed");
const ex = { reasonAr: "إعفاء بموجب قرار", reasonEn: "Exempt by decision", legalBasis: "Decision X", effectiveFromMs: 1000, effectiveToMs: 2000 };

describe("exemptions", () => {
  it("seeds are 14%", () => {
    expect(DEFAULT_TAX_CATEGORIES.every((c) => c.rateBps === 1_400n && c.exemption === null)).toBe(true);
  });
  it("set, audit and clear round trip with version bumps", () => {
    const set = applyExemptionChange(std, { kind: "set", exemption: ex, reason: "ruling" }, "a1", 5);
    expect(set.category.version).toBe(1);
    expect(set.audit).toMatchObject({ action: "exemption_set", actorId: "a1", before: null, versionBefore: 0, versionAfter: 1 });
    const cleared = applyExemptionChange(set.category, { kind: "clear", reason: "revoked" }, "a2", 6);
    expect(cleared.category.exemption).toBeNull();
    expect(cleared.audit.before).toEqual(ex);
    expect(cleared.audit.versionAfter).toBe(2);
  });
  it("window is half open", () => {
    const c = applyExemptionChange(std, { kind: "set", exemption: ex, reason: "ruling" }, "a1", 5).category;
    expect(exemptionActiveAt(c, 999)).toBe(false);
    expect(exemptionActiveAt(c, 1000)).toBe(true);
    expect(exemptionActiveAt(c, 1999)).toBe(true);
    expect(effectiveRateBps(c, 2000)).toBe(1_400n);
  });
  it("validates inputs", () => {
    const bad = (o: Partial<typeof ex>, reason = "ok reason") =>
      applyExemptionChange(std, { kind: "set", exemption: { ...ex, ...o }, reason }, "a", 1);
    expect(() => bad({ reasonAr: "English only" })).toThrow(/Arabic/);
    expect(() => bad({ reasonEn: " " })).toThrow();
    expect(() => bad({ legalBasis: "" })).toThrow();
    expect(() => bad({ effectiveToMs: 1000 })).toThrow();
    expect(() => bad({}, " ")).toThrow(/reason/);
    expect(() => applyExemptionChange(std, { kind: "clear", reason: "nothing there" }, "a", 1)).toThrow();
  });
});
