import { describe, expect, it } from "vitest";
import { computeItemFlag, historyShift, recommendSize, type FitInput, type FitResult } from "./index";
import { TOPS, profile } from "./fixtures";

const base = (over: Partial<FitInput> = {}): FitInput => ({
  rows: TOPS,
  profile: profile(),
  stretch: "none",
  itemCounts: null,
  history: null,
  ...over,
});
const ok = (o: ReturnType<typeof recommendSize>): FitResult => {
  if (o.kind !== "ok") throw new Error("expected a recommendation");
  return o;
};
const codes = (r: FitResult): string[] => r.explanation.map((e) => e.code);

describe("computeItemFlag (Beta-Binomial, n >= 20)", () => {
  it("is insufficient at 19 and decided at 20", () => {
    expect(computeItemFlag({ nSmall: 19, nOk: 0, nLarge: 0 })).toEqual({ n: 19, tendency: "insufficient" });
    expect(computeItemFlag({ nSmall: 20, nOk: 0, nLarge: 0 })).toEqual({ n: 20, tendency: "runs_small" });
  });
  it("classifies runs small, runs large and true to size", () => {
    expect(computeItemFlag({ nSmall: 12, nOk: 8, nLarge: 0 }).tendency).toBe("runs_small");
    expect(computeItemFlag({ nSmall: 0, nOk: 8, nLarge: 12 }).tendency).toBe("runs_large");
    expect(computeItemFlag({ nSmall: 3, nOk: 14, nLarge: 3 }).tendency).toBe("true_to_size");
  });
  it("needs both the 0.30 level and the 0.15 lead", () => {
    // n=20: mSmall = (5+1)/22 = .27 < .30 -> true to size
    expect(computeItemFlag({ nSmall: 5, nOk: 15, nLarge: 0 }).tendency).toBe("true_to_size");
    // mSmall = 7/22 = .318 >= .30 and lead .318 - .045 = .27
    expect(computeItemFlag({ nSmall: 6, nOk: 14, nLarge: 0 }).tendency).toBe("runs_small");
    // n=20: mSmall = 10/22 = .45, mLarge = 8/22 = .36: lead .09 < .15
    expect(computeItemFlag({ nSmall: 9, nOk: 4, nLarge: 7 }).tendency).toBe("true_to_size");
  });
  it("rejects negative or fractional counts", () => {
    expect(() => computeItemFlag({ nSmall: -1, nOk: 0, nLarge: 0 })).toThrow();
    expect(() => computeItemFlag({ nSmall: 1.5, nOk: 0, nLarge: 0 })).toThrow();
    expect(() => computeItemFlag({ nSmall: 0, nOk: -1, nLarge: 0 })).toThrow();
    expect(() => computeItemFlag({ nSmall: 0, nOk: 0, nLarge: -1 })).toThrow();
  });
});

describe("historyShift", () => {
  it("moves only with a net of two", () => {
    expect(historyShift({ tooSmall: 1, tooLarge: 0 })).toBe(0);
    expect(historyShift({ tooSmall: 2, tooLarge: 0 })).toBe(1);
    expect(historyShift({ tooSmall: 3, tooLarge: 1 })).toBe(1);
    expect(historyShift({ tooSmall: 2, tooLarge: 1 })).toBe(0);
    expect(historyShift({ tooSmall: 0, tooLarge: 2 })).toBe(-1);
    expect(historyShift({ tooSmall: 0, tooLarge: 1 })).toBe(0);
  });
});

describe("recommendSize chart matching", () => {
  it("picks the exact row with an ease-aware target (regular: +4 cm)", () => {
    const r = ok(recommendSize(base()));
    expect(r.size).toBe("M");
    expect(r.confidence).toBe(0.8);
    expect(r.notSure).toBe(false);
    expect(codes(r)).toEqual(["chart_match"]);
    expect(r.alternatives).toEqual([
      { size: "S", direction: "smaller" },
      { size: "L", direction: "larger" },
    ]);
  });
  it("snug preference chooses a smaller size than loose", () => {
    const snug = ok(recommendSize(base({ profile: profile({ fitPreference: "snug" }) })));
    const loose = ok(recommendSize(base({ profile: profile({ fitPreference: "loose" }) })));
    expect(snug.size).toBe("S");
    expect(loose.size).toBe("L");
  });
  it("stretch fabric lowers the size", () => {
    const none = ok(recommendSize(base({ profile: profile({ measurements: { bust_cm: 88, waist_cm: 70 } }) })));
    const high = ok(
      recommendSize(base({ stretch: "high", profile: profile({ measurements: { bust_cm: 88, waist_cm: 70 } }) })),
    );
    expect(none.index).toBeGreaterThan(high.index);
  });
  it("modest fit asks for more room", () => {
    const m = ok(recommendSize(base({ profile: profile({ modestFit: true }) })));
    expect(m.size).toBe("L");
  });
  it("modest fit penalises sleeves that are too short double", () => {
    const rows = [
      { sizeLabel: "S", measurements: { bust_cm: 90, sleeve_cm: 59 } },
      { sizeLabel: "M", measurements: { bust_cm: 94, sleeve_cm: 60 } },
    ];
    const p = { measurements: { bust_cm: 86, sleeve_cm: 60 }, fitPreference: "regular", modestFit: false, usualSizeLabel: null } as const;
    const plain = ok(recommendSize({ rows, profile: p, stretch: "none", itemCounts: null, history: null }));
    const modest = ok(recommendSize({ rows, profile: { ...p, modestFit: true }, stretch: "none", itemCounts: null, history: null }));
    expect(plain.size).toBe("S");
    expect(modest.size).toBe("M");
  });
  it("never recommends a smaller size for a tight garment than for a loose one (asymmetry)", () => {
    // body 86/68 regular: M exact; one size smaller is 12 penalty, one larger is 6
    const r = ok(recommendSize(base()));
    expect(r.size).toBe("M");
  });
});

describe("between sizes rule", () => {
  // target bust 91.4 (body 87.4 + 4): M penalty 4.2 (gap -1.4*3), L 4.6 (gap +4.6... computed in test)
  const p = (over: Partial<ReturnType<typeof profile>> = {}) =>
    profile({ measurements: { bust_cm: 87.4, waist_cm: 69.4 }, ...over });
  it("regular with no stretch takes the larger", () => {
    const r = ok(recommendSize(base({ profile: p() })));
    expect(r.size).toBe("L");
    expect(codes(r)).toContain("between_sizes_larger");
  });
  it("regular with some stretch takes the smaller", () => {
    const r = ok(recommendSize(base({ profile: p({ measurements: { bust_cm: 89.4, waist_cm: 71.4 } }), stretch: "some" })));
    expect(r.size).toBe("M");
    expect(codes(r)).toContain("between_sizes_smaller");
  });
  it("snug takes the smaller, loose the larger", () => {
    // snug target = body, so body 91.4 / 73.4 puts M and L within the band
    const snug = ok(recommendSize(base({ profile: p({ fitPreference: "snug", measurements: { bust_cm: 91.4, waist_cm: 73.4 } }) })));
    expect(snug.size).toBe("M");
    expect(codes(snug)).toContain("between_sizes_smaller");
    const loose = ok(recommendSize(base({ profile: p({ fitPreference: "loose", measurements: { bust_cm: 81.4, waist_cm: 63.4 } }) })));
    expect(loose.size).toBe("L");
    expect(codes(loose)).toContain("between_sizes_larger");
  });
  it("modest takes the larger even with stretch", () => {
    const r = ok(
      recommendSize(base({ stretch: "high", profile: p({ modestFit: true, measurements: { bust_cm: 88.5, waist_cm: 70.5 } }) })),
    );
    expect(r.size).toBe("L");
    expect(codes(r)).toContain("between_sizes_larger");
  });
  it("does not apply when the margin is above 1 cm", () => {
    const r = ok(recommendSize(base({ profile: p({ measurements: { bust_cm: 87.0, waist_cm: 69.0 } }) })));
    expect(codes(r)).not.toContain("between_sizes_larger");
    expect(codes(r)).not.toContain("between_sizes_smaller");
  });
});

describe("item flag and brand history (acceptance: shifts up with an explanation citing it)", () => {
  it("two too_small in the same brand shifts one size up and cites the count", () => {
    const without = ok(recommendSize(base()));
    const withHistory = ok(recommendSize(base({ history: { tooSmall: 2, tooLarge: 0 } })));
    expect(without.size).toBe("M");
    expect(withHistory.size).toBe("L");
    const e = withHistory.explanation.find((x) => x.code === "history_too_small");
    expect(e?.params).toEqual({ count: 2 });
  });
  it("one too_small is not enough", () => {
    expect(ok(recommendSize(base({ history: { tooSmall: 1, tooLarge: 0 } }))).size).toBe("M");
  });
  it("two too_large shifts down", () => {
    const r = ok(recommendSize(base({ history: { tooSmall: 0, tooLarge: 2 } })));
    expect(r.size).toBe("S");
    expect(codes(r)).toContain("history_too_large");
  });
  it("item flag runs small shifts up and exposes community fit with the count", () => {
    const r = ok(recommendSize(base({ itemCounts: { nSmall: 14, nOk: 8, nLarge: 0 } })));
    expect(r.size).toBe("L");
    expect(r.communityFit).toEqual({ tendency: "runs_small", sampleSize: 22 });
    expect(codes(r)).toContain("item_runs_small");
  });
  it("item flag runs large shifts down", () => {
    const r = ok(recommendSize(base({ itemCounts: { nSmall: 0, nOk: 8, nLarge: 14 } })));
    expect(r.size).toBe("S");
    expect(r.communityFit?.tendency).toBe("runs_large");
  });
  it("19 events give no community fit and no shift", () => {
    const r = ok(recommendSize(base({ itemCounts: { nSmall: 19, nOk: 0, nLarge: 0 } })));
    expect(r.communityFit).toBeNull();
    expect(r.size).toBe("M");
  });
  it("true to size shows the flag without shifting", () => {
    const r = ok(recommendSize(base({ itemCounts: { nSmall: 2, nOk: 18, nLarge: 2 } })));
    expect(r.communityFit).toEqual({ tendency: "true_to_size", sampleSize: 22 });
    expect(r.size).toBe("M");
  });
  it("signals stack to at most one size and stay inside the chart", () => {
    const r = ok(
      recommendSize(base({ itemCounts: { nSmall: 14, nOk: 8, nLarge: 0 }, history: { tooSmall: 5, tooLarge: 0 } })),
    );
    expect(r.size).toBe("L");
    const edge = ok(
      recommendSize(
        base({
          profile: profile({ measurements: { bust_cm: 120, waist_cm: 100 } }),
          history: { tooSmall: 5, tooLarge: 0 },
        }),
      ),
    );
    expect(edge.size).toBe("XL");
    expect(edge.alternatives).toEqual([{ size: "L", direction: "smaller" }]);
  });
  it("opposite signals cancel", () => {
    const r = ok(
      recommendSize(base({ itemCounts: { nSmall: 14, nOk: 8, nLarge: 0 }, history: { tooSmall: 0, tooLarge: 3 } })),
    );
    expect(r.size).toBe("M");
  });
});

describe("confidence and not sure", () => {
  it("is below 0.6 when the profile covers little of the chart", () => {
    const r = ok(recommendSize(base({ profile: profile({ measurements: { bust_cm: 86 } }) })));
    // coverage .5, quality 1, separation 1: .2 + .3 = .5
    expect(r.confidence).toBe(0.5);
    expect(r.notSure).toBe(true);
    expect(r.explanation[0]?.code).toBe("not_sure");
  });
  it("adds 0.1 for a known item flag and 0.1 for own history", () => {
    const flag = ok(recommendSize(base({ itemCounts: { nSmall: 2, nOk: 18, nLarge: 2 } })));
    expect(flag.confidence).toBe(0.9);
    const both = ok(
      recommendSize(base({ itemCounts: { nSmall: 2, nOk: 18, nLarge: 2 }, history: { tooSmall: 1, tooLarge: 1 } })),
    );
    expect(both.confidence).toBe(1);
  });
  it("a poor fit lowers quality", () => {
    const r = ok(recommendSize(base({ profile: profile({ measurements: { bust_cm: 120, waist_cm: 100 } }) })));
    expect(r.confidence).toBeLessThan(0.6);
    expect(r.notSure).toBe(true);
  });
  it("a single row chart has separation 0.5", () => {
    const r = ok(recommendSize(base({ rows: [TOPS[2]!] })));
    // penalty 0: .2 + .6 * 1 * 1 * .75 = .65
    expect(r.confidence).toBe(0.65);
    expect(r.alternatives).toEqual([]);
  });
});

describe("usual size only", () => {
  it("is capped at 0.55 and flagged not sure", () => {
    const r = ok(
      recommendSize(base({ profile: profile({ measurements: {}, usualSizeLabel: "S" }) })),
    );
    expect(r.size).toBe("S");
    expect(r.confidence).toBe(0.4);
    expect(r.notSure).toBe(true);
    expect(codes(r)).toEqual(["not_sure", "usual_size_only"]);
  });
  it("bonuses never lift it above the cap", () => {
    const r = ok(
      recommendSize(
        base({
          profile: profile({ measurements: {}, usualSizeLabel: "S" }),
          itemCounts: { nSmall: 2, nOk: 18, nLarge: 2 },
          history: { tooSmall: 1, tooLarge: 1 },
        }),
      ),
    );
    expect(r.confidence).toBe(0.55);
  });
  it("reports no data without measurements or a usual size in the chart", () => {
    expect(recommendSize(base({ profile: profile({ measurements: {}, usualSizeLabel: null }) })).kind).toBe("no_data");
    expect(recommendSize(base({ profile: profile({ measurements: {}, usualSizeLabel: "ZZ" }) })).kind).toBe("no_data");
    expect(recommendSize(base({ profile: profile({ measurements: { foot_length_cm: 25 } }) })).kind).toBe("no_data");
  });
  it("rejects an empty chart", () => {
    expect(() => recommendSize(base({ rows: [] }))).toThrow();
  });
});
