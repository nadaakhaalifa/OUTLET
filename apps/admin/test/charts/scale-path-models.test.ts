import { describe, expect, it } from "vitest";
import { bandScale, linearScale, niceTicks, tickStep } from "../../src/lib/charts/scale";
import { linePath, monotonePath, ringDash } from "../../src/lib/charts/path";
import { barHeights, barWidths, directLabelIndexes } from "../../src/lib/charts/models";

describe("scale", () => {
  it("picks 1, 2, 5 steps", () => {
    expect(tickStep(0, 100, 4)).toBe(20);
    expect(tickStep(0, 0, 4)).toBe(0);
  });
  it("gives a zero based nice domain and never a flat axis", () => {
    expect(niceTicks(0, 87, 4).domain).toEqual([0, 100]);
    expect(niceTicks(0, 0).domain).toEqual([0, 1]);
    expect(niceTicks(5, 5).domain[0]).toBe(0);
    expect(niceTicks(Number.NaN, 3).domain).toEqual([0, 1]);
  });
  it("maps linearly and handles a zero-width domain", () => {
    expect(linearScale([0, 10], [0, 100])(5)).toBe(50);
    expect(linearScale([3, 3], [7, 9])(3)).toBe(7);
  });
  it("lays out bands", () => {
    const b = bandScale(4, [0, 100], 0);
    expect(b.size).toBe(25);
    expect(b.centre(0)).toBe(12.5);
  });
});

describe("path", () => {
  it("builds lines and never overshoots a monotone curve", () => {
    expect(linePath([{ x: 0, y: 1 }, { x: 2, y: 3 }])).toBe("M0 1L2 3");
    expect(monotonePath([])).toBe("");
    const d = monotonePath([{ x: 0, y: 10 }, { x: 1, y: 0 }, { x: 2, y: 10 }]);
    expect(d.startsWith("M0 10C")).toBe(true);
  });
  it("clamps ring dashes", () => {
    expect(ringDash(150)).toBe("100 0");
    expect(ringDash(-5)).toBe("0 100");
  });
});

describe("models", () => {
  it("bar widths keep real values visible", () => {
    expect(barWidths([100, 1, 0])).toEqual([100, 2, 0]);
    expect(barWidths([0, 0])).toEqual([0, 0]);
  });
  it("bar heights floor non-zero values", () => {
    expect(barHeights([10, 0, 0.1])).toEqual([1, 0, 0.08]);
    expect(barHeights([0])).toEqual([0]);
  });
  it("direct labels: highest and newest, deduplicated", () => {
    expect(directLabelIndexes([1, 9, 3, 4])).toEqual([1, 3]);
    expect(directLabelIndexes([1, 2, 9])).toEqual([2]);
    expect(directLabelIndexes([0, 0])).toEqual([1]);
    expect(directLabelIndexes([])).toEqual([]);
  });
});
