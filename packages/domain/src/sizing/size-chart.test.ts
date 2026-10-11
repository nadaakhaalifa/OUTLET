import { describe, expect, it } from "vitest";
import { requiredMeasures, validateChart, type ChartInput } from "./index";

const row = (sizeLabel: string, bust: number, waist: number) => ({ sizeLabel, measurements: { bust_cm: bust, waist_cm: waist } });
const tops = (rows: ChartInput["rows"], unit: "cm" | "in" = "cm"): ChartInput => ({ productType: "tops", unit, rows });

describe("validateChart", () => {
  it("accepts a monotonic chart", () => {
    const v = validateChart(tops([row("S", 86, 68), row("M", 90, 72), row("L", 96, 78)]));
    expect(v.validated).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.rows[1]?.measurements).toEqual({ bust_cm: 90, waist_cm: 72 });
  });
  it("normalises inches to cm", () => {
    const v = validateChart(tops([row("S", 34, 26), row("M", 36, 28)], "in"));
    expect(v.validated).toBe(true);
    expect(v.rows[0]?.measurements).toEqual({ bust_cm: 86.4, waist_cm: 66 });
  });
  it("rejects a decreasing measure", () => {
    const v = validateChart(tops([row("S", 90, 68), row("M", 86, 72)]));
    expect(v.validated).toBe(false);
    expect(v.errors).toContainEqual({ sizeLabel: "M", code: "not_monotonic" });
  });
  it("rejects identical neighbours (no progress)", () => {
    const v = validateChart(tops([row("S", 86, 68), row("M", 86, 68)]));
    expect(v.errors).toEqual([{ sizeLabel: "M", code: "no_progress" }]);
  });
  it("allows equal on one measure when another grows", () => {
    expect(validateChart(tops([row("S", 86, 68), row("M", 90, 68)])).validated).toBe(true);
  });
  it("rejects implausible deltas, exactly above the maximum", () => {
    expect(validateChart(tops([row("S", 86, 68), row("M", 98, 72)])).validated).toBe(true); // 12
    const v = validateChart(tops([row("S", 86, 68), row("M", 98.1, 72)]));
    expect(v.errors).toContainEqual({ sizeLabel: "M", code: "delta_too_large" });
  });
  it("rejects missing required measures, unknown measures and ranges", () => {
    const v = validateChart({
      productType: "tops",
      unit: "cm",
      rows: [
        { sizeLabel: "S", measurements: { bust_cm: 86 } },
        { sizeLabel: "M", measurements: { bust_cm: 90, waist_cm: 300, weight_kg: 5 } },
      ],
    });
    expect(v.errors).toContainEqual({ sizeLabel: "S", code: "missing_measure" });
    expect(v.errors).toContainEqual({ sizeLabel: "M", code: "out_of_range" });
    expect(v.errors).toContainEqual({ sizeLabel: "M", code: "unknown_measure" });
  });
  it("rejects duplicate and invalid labels (no HTML)", () => {
    const v = validateChart(tops([row("S", 86, 68), row("s", 90, 72), row("<b>L</b>", 96, 78)]));
    expect(v.errors).toContainEqual({ sizeLabel: "s", code: "duplicate_size_label" });
    expect(v.errors).toContainEqual({ sizeLabel: "<b>L</b>", code: "invalid_size_label" });
  });
  it("unknown product type is a draft", () => {
    const v = validateChart({ productType: "hats", unit: "cm", rows: [row("S", 86, 68)] });
    expect(v.validated).toBe(false);
    expect(v.errors).toContainEqual({ sizeLabel: "", code: "unknown_product_type" });
  });
  it("empty and oversized charts", () => {
    expect(validateChart(tops([])).errors).toEqual([{ sizeLabel: "", code: "empty_chart" }]);
    const many = Array.from({ length: 31 }, (_, i) => row(`S${i}`, 60 + i, 50 + i));
    expect(validateChart(tops(many)).errors).toContainEqual({ sizeLabel: "", code: "too_many_rows" });
    expect(validateChart(tops(many.slice(0, 30))).validated).toBe(true);
  });
  it("non finite value is out of range", () => {
    const v = validateChart(tops([{ sizeLabel: "S", measurements: { bust_cm: Number.NaN, waist_cm: 68 } }]));
    expect(v.errors).toContainEqual({ sizeLabel: "S", code: "out_of_range" });
  });
  it("exposes templates", () => {
    expect(requiredMeasures("shoes")).toEqual(["foot_length_cm"]);
    expect(requiredMeasures("hats")).toBeNull();
  });
});
