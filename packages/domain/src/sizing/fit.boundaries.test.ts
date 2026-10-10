import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIGHT,
  MEASURE_WEIGHTS,
  USUAL_SIZE_BASE_CONFIDENCE,
  USUAL_SIZE_CONFIDENCE_CAP,
  computeItemFlag,
  recommendSize,
  type ChartRow,
  type FitInput,
  type FitPreference,
  type FitResult,
  type MeasureKey,
  type Measurements,
} from "./index";
import { TOPS, profile } from "./fixtures";

const ok = (o: ReturnType<typeof recommendSize>): FitResult => {
  if (o.kind !== "ok") throw new Error("expected a recommendation");
  return o;
};

const rows = (key: MeasureKey, labelValues: readonly [string, number][]): ChartRow[] =>
  labelValues.map(([sizeLabel, v]) => ({ sizeLabel, measurements: { [key]: v } }));

const run = (
  r: readonly ChartRow[],
  m: Measurements,
  over: Partial<Pick<FitInput, "itemCounts" | "history" | "stretch">> & { pref?: FitPreference; modest?: boolean; usual?: string } = {},
): FitResult =>
  ok(
    recommendSize({
      rows: r,
      profile: {
        measurements: m,
        fitPreference: over.pref ?? "regular",
        modestFit: over.modest ?? false,
        usualSizeLabel: over.usual ?? null,
      },
      stretch: over.stretch ?? "none",
      itemCounts: over.itemCounts ?? null,
      history: over.history ?? null,
    }),
  );

describe("item flag boundaries", () => {
  it("0.30 level is inclusive and uses n + 2", () => {
    // n = 28: mSmall = 9/30 = 0.30 exactly
    expect(computeItemFlag({ nSmall: 8, nOk: 20, nLarge: 0 }).tendency).toBe("runs_small");
    expect(computeItemFlag({ nSmall: 0, nOk: 20, nLarge: 8 }).tendency).toBe("runs_large");
    expect(computeItemFlag({ nSmall: 7, nOk: 21, nLarge: 0 }).tendency).toBe("true_to_size");
    expect(computeItemFlag({ nSmall: 0, nOk: 21, nLarge: 7 }).tendency).toBe("true_to_size");
  });
  it("0.15 lead is inclusive", () => {
    // n = 38: (11+1)/40 = 0.30, (5+1)/40 = 0.15, lead 0.15
    expect(computeItemFlag({ nSmall: 11, nOk: 22, nLarge: 5 }).tendency).toBe("runs_small");
    expect(computeItemFlag({ nSmall: 5, nOk: 22, nLarge: 11 }).tendency).toBe("runs_large");
    // one more large removes the lead
    expect(computeItemFlag({ nSmall: 11, nOk: 21, nLarge: 6 }).tendency).toBe("true_to_size");
    expect(computeItemFlag({ nSmall: 6, nOk: 21, nLarge: 11 }).tendency).toBe("true_to_size");
  });
});

describe("weights and ease per measure", () => {
  it("publishes the weights", () => {
    expect(MEASURE_WEIGHTS).toEqual({
      bust_cm: 1,
      waist_cm: 1,
      hip_cm: 1,
      shoulders_cm: 0.6,
      sleeve_cm: 0.5,
      inseam_cm: 0.8,
      foot_length_cm: 1.5,
      height_cm: 0.8,
    });
    expect(DEFAULT_WEIGHT).toBe(0.5);
  });
  it("a heavier measure wins a disagreement", () => {
    // row A fits hip, row B fits shoulders; hip (1.0) outweighs shoulders (0.6)
    const r: ChartRow[] = [
      { sizeLabel: "A", measurements: { hip_cm: 100, shoulders_cm: 40 } },
      { sizeLabel: "B", measurements: { hip_cm: 112, shoulders_cm: 44 } },
    ];
    expect(run(r, { hip_cm: 96, shoulders_cm: 43 }).size).toBe("A");
    // inverse: shoulders now 5 cm off, hip 2 cm off
    expect(run(r, { hip_cm: 108, shoulders_cm: 38.5 }).size).toBe("B");
  });
  it("shoulders ease is 0 / 1 / 2 by preference", () => {
    const r = rows("shoulders_cm", [["A", 40], ["B", 42], ["C", 44]]);
    expect(run(r, { shoulders_cm: 40 }, { pref: "regular" }).size).toBe("B");
    expect(run(r, { shoulders_cm: 40 }, { pref: "snug" }).size).toBe("A");
    expect(run(r, { shoulders_cm: 41 }, { pref: "loose" }).size).toBe("C");
  });
  it("foot length ease is 0.5 / 1.0 / 1.5 by preference", () => {
    const r = rows("foot_length_cm", [["A", 24], ["B", 26], ["C", 28]]);
    expect(run(r, { foot_length_cm: 24 }, { pref: "regular" }).size).toBe("B");
    expect(run(r, { foot_length_cm: 24 }, { pref: "snug" }).size).toBe("A");
    expect(run(r, { foot_length_cm: 25.2 }, { pref: "regular" }).size).toBe("B");
    expect(run(r, { foot_length_cm: 25.2 }, { pref: "loose" }).size).toBe("C");
  });
  it("neck ease is 1 and other measures have no ease", () => {
    const neck = rows("neck_cm", [["A", 36], ["B", 38], ["C", 40]]);
    expect(run(neck, { neck_cm: 36 }).size).toBe("B");
    const inseam = rows("inseam_cm", [["A", 70], ["B", 72], ["C", 74]]);
    expect(run(inseam, { inseam_cm: 70 }).size).toBe("A");
    const height = rows("height_cm", [["A", 110], ["B", 116], ["C", 122]]);
    expect(run(height, { height_cm: 110 }).size).toBe("A");
  });
});

describe("exact confidence arithmetic", () => {
  it("a small positive gap is a plain penalty, not a tight one", () => {
    // target 89.5: row 90 gap +0.5 (pen 0.5), row 91 gap +1.5 (pen 1.5). margin 1.0 -> between (larger)
    const r = run(rows("bust_cm", [["A", 90], ["B", 91]]), { bust_cm: 85.5 });
    expect(r.size).toBe("B");
    // best penalty 0.5: quality 0.8, separation 1/3: 0.2 + 0.6 * 0.8 * (0.5 + 1/6) = 0.52
    expect(r.confidence).toBe(0.52);
  });
  it("separation grows with the margin and is capped at 1", () => {
    // target 90: A pen 0, B (92) pen 2 -> margin 2 -> separation 2/3 -> 0.2 + 0.6 * (0.5 + 1/3) = 0.7
    expect(run(rows("bust_cm", [["A", 90], ["B", 92]]), { bust_cm: 86 }).confidence).toBe(0.7);
    // margin 4 -> separation 1 -> 0.8
    expect(run(rows("bust_cm", [["A", 90], ["B", 94]]), { bust_cm: 86 }).confidence).toBe(0.8);
  });
  it("a margin of exactly 1 cm counts as between sizes", () => {
    // body 87.25 -> target 91.25: A 3.75, B 4.75
    const r = run(rows("bust_cm", [["A", 90], ["B", 96]]), { bust_cm: 87.25 });
    expect(r.size).toBe("B");
    expect(r.explanation.map((e) => e.code)).toContain("between_sizes_larger");
    // quality 1 / (1 + 3.75 / 2), separation 1/3
    expect(r.confidence).toBe(0.34);
  });
  it("just above 1 cm is not between sizes", () => {
    // body 87.2 -> target 91.2: A 3.6, B 4.8, margin 1.2
    const r = run(rows("bust_cm", [["A", 90], ["B", 96]]), { bust_cm: 87.2 });
    expect(r.size).toBe("A");
    expect(r.explanation.map((e) => e.code)).not.toContain("between_sizes_larger");
  });
  it("coverage scales confidence by the weighted share of measures supplied", () => {
    const full = recommendSize({
      rows: TOPS,
      profile: profile(),
      stretch: "none",
      itemCounts: null,
      history: null,
    });
    const half = run(TOPS, { bust_cm: 86 });
    expect(ok(full).confidence).toBe(0.8);
    expect(half.confidence).toBe(0.5);
  });
});

describe("neck ease and the not sure threshold", () => {
  it("neck ease is exactly 1 cm", () => {
    const r = run(rows("neck_cm", [["A", 37], ["B", 45]]), { neck_cm: 36 });
    expect(r.size).toBe("A");
    expect(r.confidence).toBe(0.8);
  });
  it("0.60 is sure, below it is not", () => {
    // pen 0, margin 1.0 -> separation 1/3 -> 0.2 + 0.6 * (0.5 + 1/6) = 0.6
    const r = run(rows("bust_cm", [["A", 90], ["B", 91]]), { bust_cm: 86 });
    expect(r.confidence).toBe(0.6);
    expect(r.notSure).toBe(false);
    expect(r.explanation.map((e) => e.code)).not.toContain("not_sure");
    const below = run(TOPS, { bust_cm: 86 });
    expect(below.confidence).toBe(0.5);
    expect(below.notSure).toBe(true);
  });
});

describe("modest fit and short sleeves or inseams", () => {
  it("doubles the penalty of a garment shorter than the body", () => {
    const sleeve = rows("sleeve_cm", [["S", 59], ["M", 70]]);
    expect(run(sleeve, { sleeve_cm: 60 }).confidence).toBe(0.44);
    expect(run(sleeve, { sleeve_cm: 60 }, { modest: true }).confidence).toBe(0.35);
    const inseam = rows("inseam_cm", [["S", 79], ["M", 90]]);
    expect(run(inseam, { inseam_cm: 80 }).confidence).toBe(0.44);
    expect(run(inseam, { inseam_cm: 80 }, { modest: true }).confidence).toBe(0.35);
  });
  it("does not double a garment that is longer than the body", () => {
    const sleeve = rows("sleeve_cm", [["S", 60.5], ["M", 75]]);
    expect(run(sleeve, { sleeve_cm: 60 }, { modest: true }).confidence).toBe(0.68);
  });
  it("does not double other measures", () => {
    const shoulders = rows("shoulders_cm", [["S", 39], ["M", 50]]);
    // shoulders regular ease 1: target 41; row 39 gap -2 pen 6, no modest doubling
    const plain = run(shoulders, { shoulders_cm: 40 });
    const modest = run(shoulders, { shoulders_cm: 40 }, { modest: true });
    expect(modest.confidence).toBe(plain.confidence);
  });
});

describe("signals combine", () => {
  const flagSmall = { nSmall: 14, nOk: 8, nLarge: 0 };
  const flagLarge = { nSmall: 0, nOk: 8, nLarge: 14 };
  it("runs large and own too_small cancel", () => {
    const r = ok(recommendSize({ rows: TOPS, profile: profile(), stretch: "none", itemCounts: flagLarge, history: { tooSmall: 3, tooLarge: 0 } }));
    expect(r.size).toBe("M");
  });
  it("runs large and own too_large stack to one size down, not two", () => {
    const r = ok(recommendSize({ rows: TOPS, profile: profile(), stretch: "none", itemCounts: flagLarge, history: { tooSmall: 0, tooLarge: 3 } }));
    expect(r.size).toBe("S");
  });
  it("runs small and own too_small stack to one size up, not two", () => {
    const r = ok(recommendSize({ rows: TOPS, profile: profile(), stretch: "none", itemCounts: flagSmall, history: { tooSmall: 3, tooLarge: 0 } }));
    expect(r.size).toBe("L");
  });
  it("own history alone adds 0.1 confidence", () => {
    const r = ok(recommendSize({ rows: TOPS, profile: profile(), stretch: "none", itemCounts: null, history: { tooSmall: 1, tooLarge: 1 } }));
    expect(r.confidence).toBe(0.9);
    expect(r.size).toBe("M");
  });
  it("a single event of own history adds nothing", () => {
    const r = ok(recommendSize({ rows: TOPS, profile: profile(), stretch: "none", itemCounts: null, history: { tooSmall: 1, tooLarge: 0 } }));
    expect(r.confidence).toBe(0.8);
  });
});

describe("alternatives and usual size", () => {
  it("offers both neighbours when the size is in the middle of the chart", () => {
    const r = run(TOPS, { bust_cm: 78, waist_cm: 60 });
    expect(r.size).toBe("XS");
    expect(r.alternatives).toEqual([{ size: "S", direction: "larger" }]);
    const s = run(TOPS, { bust_cm: 82, waist_cm: 64 });
    expect(s.size).toBe("S");
    expect(s.alternatives).toEqual([
      { size: "XS", direction: "smaller" },
      { size: "M", direction: "larger" },
    ]);
  });
  it("accepts the first size as the usual size", () => {
    const r = run(TOPS, {}, { usual: "XS" });
    expect(r.size).toBe("XS");
    expect(r.index).toBe(0);
  });
  it("usual size confidence is the base, bonuses are clipped at the cap", () => {
    expect(USUAL_SIZE_BASE_CONFIDENCE).toBe(0.4);
    expect(USUAL_SIZE_CONFIDENCE_CAP).toBe(0.55);
    expect(run(TOPS, {}, { usual: "S" }).confidence).toBe(0.4);
    expect(run(TOPS, {}, { usual: "S", itemCounts: { nSmall: 2, nOk: 18, nLarge: 2 } }).confidence).toBe(0.5);
    expect(
      run(TOPS, {}, { usual: "S", itemCounts: { nSmall: 2, nOk: 18, nLarge: 2 }, history: { tooSmall: 1, tooLarge: 1 } }).confidence,
    ).toBe(0.55);
  });
  it("a usual size is ignored when body measurements are usable", () => {
    const r = run(TOPS, { bust_cm: 86, waist_cm: 68 }, { usual: "XL" });
    expect(r.size).toBe("M");
  });
});
