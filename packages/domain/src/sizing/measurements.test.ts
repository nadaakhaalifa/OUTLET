import { describe, expect, it } from "vitest";
import { MEASURE_RANGES, normalizeMeasurements, toCm, round1, MEASURE_KEYS } from "./index";

describe("normalizeMeasurements", () => {
  it("accepts a plausible body and rounds to 0.1", () => {
    const r = normalizeMeasurements({ height_cm: 170.04, weight_kg: 62.26, waist_cm: 68 });
    expect(r).toEqual({ ok: true, value: { height_cm: 170, weight_kg: 62.3, waist_cm: 68 } });
  });
  it("rejects a waist above 250 cm", () => {
    const r = normalizeMeasurements({ waist_cm: 250.1 });
    expect(r).toEqual({ ok: false, errors: [{ key: "waist_cm", code: "out_of_range" }] });
    expect(normalizeMeasurements({ waist_cm: 250 }).ok).toBe(true);
    expect(normalizeMeasurements({ waist_cm: 20 }).ok).toBe(true);
    expect(normalizeMeasurements({ waist_cm: 19.9 }).ok).toBe(false);
  });
  it("converts inches to cm for lengths but not weight", () => {
    const r = normalizeMeasurements({ waist_cm: 30, weight_kg: 60 }, "in");
    expect(r).toEqual({ ok: true, value: { waist_cm: 76.2, weight_kg: 60 } });
    expect(toCm(10, "in")).toBe(25.4);
    expect(toCm(10, "cm")).toBe(10);
  });
  it("the inch conversion applies the range after conversion", () => {
    expect(normalizeMeasurements({ waist_cm: 100 }, "in").ok).toBe(false); // 254 cm
  });
  it("rejects unknown keys, non numbers and NaN", () => {
    const r = normalizeMeasurements({ date_of_birth: 1, waist_cm: "68" as unknown as number, hip_cm: Number.NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        { key: "date_of_birth", code: "unknown_key" },
        { key: "waist_cm", code: "not_a_number" },
        { key: "hip_cm", code: "not_a_number" },
      ]);
    }
  });
  it("cross checks under bust, high hip and BMI", () => {
    expect(normalizeMeasurements({ bust_cm: 90, under_bust_cm: 91 })).toEqual({
      ok: false,
      errors: [{ key: "under_bust_cm", code: "exceeds_bust" }],
    });
    expect(normalizeMeasurements({ bust_cm: 90, under_bust_cm: 90 }).ok).toBe(true);
    expect(normalizeMeasurements({ hip_cm: 90, high_hip_cm: 90.5 }).ok).toBe(false);
    expect(normalizeMeasurements({ hip_cm: 90, high_hip_cm: 90 }).ok).toBe(true);
    expect(normalizeMeasurements({ height_cm: 170, weight_kg: 400 })).toEqual({
      ok: false,
      errors: [{ key: "weight_kg", code: "implausible_bmi" }],
    });
    expect(normalizeMeasurements({ height_cm: 250, weight_kg: 2 }).ok).toBe(false);
  });
  it("skips undefined values", () => {
    expect(normalizeMeasurements({ waist_cm: undefined })).toEqual({ ok: true, value: {} });
  });
  it("rejects non finite lengths in toCm and keeps ranges for every key", () => {
    expect(() => toCm(Number.POSITIVE_INFINITY, "cm")).toThrow();
    for (const k of MEASURE_KEYS) {
      const r = MEASURE_RANGES[k];
      expect(r.min).toBeLessThan(r.max);
    }
    expect(round1(1.25)).toBe(1.3);
  });
});
