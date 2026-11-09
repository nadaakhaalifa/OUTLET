import { describe, expect, it } from "vitest";
import { areaPath, linePath, monotonePath } from "../../src/lib/charts/path";

describe("monotonePath edge inputs", () => {
  it("a single point is a bare move; two points are a straight line", () => {
    expect(monotonePath([{ x: 3.456, y: 7.891 }])).toBe("M3.46 7.89");
    expect(monotonePath([{ x: 0, y: 1 }, { x: 4, y: 9 }])).toBe(linePath([{ x: 0, y: 1 }, { x: 4, y: 9 }]));
  });

  it("a flat run stays flat (zero slope), so the curve never dips below a real low", () => {
    const d = monotonePath([{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }, { x: 3, y: 9 }]);
    const flat = d.split("C").slice(1, 3);
    for (const seg of flat) for (const y of seg.trim().split(" ").filter((_, i) => i % 2 === 1)) expect(Number(y)).toBe(5);
  });

  it("a turning point gets a zero tangent: the control points at the peak sit on its own y", () => {
    const d = monotonePath([{ x: 0, y: 0 }, { x: 1, y: 10 }, { x: 2, y: 0 }]);
    const segs = d.split("C").slice(1).map((s) => s.trim().split(" ").map(Number));
    expect(segs[0]?.[3]).toBe(10); // second control point of the first segment is level with the peak
    expect(segs[1]?.[1]).toBe(10); // first control point of the second segment too
  });

  it("a very steep step is limited (Fritsch-Carlson) so the curve cannot overshoot the next point", () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0.001 }, { x: 2, y: 100 }, { x: 3, y: 100.001 }];
    const d = monotonePath(pts);
    const ys = [...d.matchAll(/C([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+)/g)].flatMap((m) => [Number(m[2]), Number(m[4]), Number(m[6])]);
    expect(Math.max(...ys)).toBeLessThanOrEqual(100.001 + 1e-9);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it("a right-to-left series (descending x) is accepted", () => {
    const d = monotonePath([{ x: 30, y: 1 }, { x: 20, y: 2 }, { x: 10, y: 3 }]);
    expect(d.startsWith("M30 1C")).toBe(true);
    expect(d.endsWith("10 3")).toBe(true);
  });

  it("repeated x (zero width) yields a flat tangent instead of NaN", () => {
    const d = monotonePath([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 1, y: 9 }]);
    expect(d).not.toContain("NaN");
    expect(d).not.toContain("Infinity");
  });
});

describe("areaPath", () => {
  it("closes down to the baseline, and is empty without points or a curve", () => {
    const pts = [{ x: 0, y: 3 }, { x: 5, y: 1 }];
    expect(areaPath(linePath(pts), pts, 10)).toBe("M0 3L5 1L5 10L0 10Z");
    expect(areaPath("", pts, 10)).toBe("");
    expect(areaPath("M0 0", [], 10)).toBe("");
  });
});
