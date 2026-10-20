import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InvalidTransitionError, TRANSITIONS, assertTransition, canDecide } from "../domain/machine";
import type { JobStatus, MaskStats } from "../domain/ports";
import { READY_THRESHOLD, assessQuality, isReady } from "../domain/quality";

const good: MaskStats = { width: 1000, height: 1000, coverage: 0.4, borderTouch: 0, components: 1, holeRatio: 0, softEdgeRatio: 0.01, subjectBrightRatio: 0.1, borderBrightRatio: 0.9 };

describe("assessQuality", () => {
  it("scores a clean cutout 100 with no reasons", () => {
    expect(assessQuality(good)).toEqual({ score: 100, reasons: [], whiteOnWhiteRisk: 0.09000000000000001 });
  });
  it("is deterministic and always within 0..100", () => {
    const worst: MaskStats = { ...good, coverage: 0.01, borderTouch: 1, components: 99, holeRatio: 1, softEdgeRatio: 1, subjectBrightRatio: 1, borderBrightRatio: 1 };
    const a = assessQuality(worst);
    expect(a).toEqual(assessQuality(worst));
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThan(READY_THRESHOLD);
  });
  it("flags an empty mask as no subject and never READY", () => {
    const a = assessQuality({ ...good, coverage: 0 });
    expect(a).toMatchObject({ score: 0, reasons: ["no_subject_detected"] });
    expect(isReady(a)).toBe(false);
  });
  it("treats white garment on white backdrop as a risk, scaled by both", () => {
    expect(assessQuality({ ...good, subjectBrightRatio: 0.95, borderBrightRatio: 0.97 }).reasons).toContain("white_on_white_risk");
    expect(assessQuality({ ...good, subjectBrightRatio: 0.95, borderBrightRatio: 0.1 }).reasons).not.toContain("white_on_white_risk");
  });
  it("penalises each defect separately", () => {
    expect(assessQuality({ ...good, borderTouch: 0.05 })).toMatchObject({ score: 80, reasons: ["subject_touches_border"] });
    expect(assessQuality({ ...good, components: 3 })).toMatchObject({ score: 80, reasons: ["multiple_components"] });
    expect(assessQuality({ ...good, holeRatio: 0.05 })).toMatchObject({ score: 85, reasons: ["mask_small_holes"] });
    expect(assessQuality({ ...good, coverage: 0.99 })).toMatchObject({ score: 70, reasons: ["subject_fills_frame"] });
  });
  it("survives non-finite input", () => {
    expect(assessQuality({ ...good, coverage: Number.NaN }).score).toBe(0);
  });
});

describe("state machine", () => {
  const all: JobStatus[] = ["PENDING", "PROCESSING", "READY", "NEEDS_REVIEW", "FAILED"];
  it("allows exactly the documented transitions", () => {
    for (const from of all) {
      for (const to of all) {
        const ok = TRANSITIONS[from].includes(to);
        if (ok) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
      }
    }
  });
  it("reaches only the terminal outcomes from PROCESSING", () => {
    expect([...TRANSITIONS.PROCESSING].sort()).toEqual(["FAILED", "NEEDS_REVIEW", "READY"]);
  });
  it("gates seller decisions", () => {
    expect(canDecide("READY", "accepted")).toBe(true);
    expect(canDecide("FAILED", "accepted")).toBe(false);
    expect(canDecide("PENDING", "accepted")).toBe(false);
    expect(canDecide("FAILED", "use_original")).toBe(true);
    expect(canDecide("PROCESSING", "use_original")).toBe(false);
  });
});

describe("parity with tooling/media/bg-benchmark/quality.py", () => {
  it("gives the same score and reasons as the benchmark port for every shared case", () => {
    const file = fileURLToPath(new URL("../../../../../../tooling/media/bg-benchmark/fixtures/quality-cases.json", import.meta.url));
    const { cases } = JSON.parse(readFileSync(file, "utf8")) as {
      cases: { name: string; stats: Record<string, number>; score: number; reasons: string[] }[];
    };
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) {
      const s = c.stats as Record<string, number>;
      const a = assessQuality({
        width: 100,
        height: 100,
        coverage: s.coverage ?? 0,
        borderTouch: s.border_touch ?? 0,
        components: s.components ?? 0,
        holeRatio: s.hole_ratio ?? 0,
        softEdgeRatio: s.soft_edge_ratio ?? 0,
        subjectBrightRatio: s.subject_bright_ratio ?? 0,
        borderBrightRatio: s.border_bright_ratio ?? 0,
      });
      expect({ name: c.name, score: a.score, reasons: a.reasons }).toEqual({ name: c.name, score: c.score, reasons: c.reasons });
    }
  });
});
