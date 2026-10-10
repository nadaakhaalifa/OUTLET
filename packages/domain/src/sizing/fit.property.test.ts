import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { recommendSize, computeItemFlag, validateChart, type ChartRow, type FitInput } from "./index";

const arbRows = fc
  .tuple(
    fc.integer({ min: 40, max: 120 }),
    fc.integer({ min: 30, max: 100 }),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 6 })), { minLength: 1, maxLength: 12 }),
  )
  .map(([bust0, waist0, steps]) => {
    let b = bust0;
    let w = waist0;
    const rows: ChartRow[] = [{ sizeLabel: "R0", measurements: { bust_cm: b, waist_cm: w } }];
    steps.forEach(([db, dw], i) => {
      b += db;
      w += dw;
      rows.push({ sizeLabel: `R${i + 1}`, measurements: { bust_cm: b, waist_cm: w } });
    });
    return rows;
  });

const arbMeasurements = fc.record(
  { bust_cm: fc.integer({ min: 20, max: 250 }), waist_cm: fc.integer({ min: 20, max: 250 }), hip_cm: fc.integer({ min: 20, max: 250 }) },
  { requiredKeys: [] },
);

const arbInput: fc.Arbitrary<FitInput> = fc.record({
  rows: arbRows,
  profile: fc.record({
    measurements: arbMeasurements,
    fitPreference: fc.constantFrom("snug", "regular", "loose"),
    modestFit: fc.boolean(),
    usualSizeLabel: fc.constantFrom(null, "R0", "R1", "nope"),
  }),
  stretch: fc.constantFrom("none", "some", "high"),
  itemCounts: fc.option(
    fc.record({ nSmall: fc.nat(60), nOk: fc.nat(60), nLarge: fc.nat(60) }),
    { nil: null },
  ),
  history: fc.option(fc.record({ tooSmall: fc.nat(10), tooLarge: fc.nat(10) }), { nil: null }),
});

describe("fit invariants", () => {
  it("always recommends a size that exists in the chart, with confidence in [0,1]", () => {
    fc.assert(
      fc.property(arbInput, (input) => {
        const r = recommendSize(input);
        if (r.kind === "no_data") return true;
        const labels = input.rows.map((x) => x.sizeLabel);
        expect(labels).toContain(r.size);
        expect(r.index).toBeGreaterThanOrEqual(0);
        expect(r.index).toBeLessThan(input.rows.length);
        expect(input.rows[r.index]?.sizeLabel).toBe(r.size);
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
        expect(Number.isFinite(r.confidence)).toBe(true);
        expect(r.notSure).toBe(r.confidence < 0.6);
        for (const a of r.alternatives) expect(labels).toContain(a.size);
        if (r.communityFit !== null) expect(r.communityFit.sampleSize).toBeGreaterThanOrEqual(20);
        return true;
      }),
      { numRuns: 400 },
    );
  });

  it("is deterministic", () => {
    fc.assert(fc.property(arbInput, (i) => {
        expect(recommendSize(i)).toEqual(recommendSize(i));
      }), { numRuns: 100 });
  });

  it("history can only move the answer by one step in its direction", () => {
    fc.assert(
      fc.property(arbInput, fc.integer({ min: 2, max: 20 }), (input, n) => {
        const a = recommendSize({ ...input, itemCounts: null, history: null });
        const b = recommendSize({ ...input, itemCounts: null, history: { tooSmall: n, tooLarge: 0 } });
        if (a.kind !== "ok" || b.kind !== "ok") return true;
        expect([a.index, Math.min(a.index + 1, input.rows.length - 1)]).toContain(b.index);
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("item flag is insufficient below 20 samples and never throws above", () => {
    fc.assert(
      fc.property(fc.nat(30), fc.nat(30), fc.nat(30), (a, b, c) => {
        const f = computeItemFlag({ nSmall: a, nOk: b, nLarge: c });
        expect(f.n).toBe(a + b + c);
        if (a + b + c < 20) expect(f.tendency).toBe("insufficient");
        else expect(f.tendency).not.toBe("insufficient");
      }),
    );
  });

  it("validateChart accepts every generated monotonic chart with small steps", () => {
    fc.assert(
      fc.property(arbRows, (rows) => {
        const v = validateChart({
          productType: "tops",
          unit: "cm",
          rows: rows.map((r) => ({ sizeLabel: r.sizeLabel, measurements: { bust_cm: r.measurements.bust_cm ?? 0, waist_cm: r.measurements.waist_cm ?? 0 } })),
        });
        expect(v.validated).toBe(true);
      }),
    );
  });
});
