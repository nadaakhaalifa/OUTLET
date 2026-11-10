import { describe, expect, it } from "vitest";
import { bucketSum, columnsModel } from "../../src/lib/charts/columnsModel";

describe("columnsModel", () => {
  it("stacks series and scales to a nice zero based domain", () => {
    const m = columnsModel([{ label: "a", values: [3, 1] }, { label: "b", values: [0, 8] }]);
    expect(m.empty).toBe(false);
    expect(m.yTicks[0]?.value).toBe(0);
    expect(m.columns[1]?.total).toBe(8);
    expect(m.columns[1]?.totalPct).toBeCloseTo(100, 6);
    expect(m.columns[0]?.segments[0]?.heightPct).toBeCloseTo(37.5, 6);
  });
  it("is empty for all zero and never divides by zero", () => {
    const m = columnsModel([{ label: "a", values: [0] }]);
    expect(m.empty).toBe(true);
    expect(m.columns[0]?.totalPct).toBe(0);
  });
  it("mirrors the physical order for rtl but keeps indexes", () => {
    const m = columnsModel([{ label: "a", values: [1] }, { label: "b", values: [2] }], { mirror: true });
    expect(m.columns.map((c) => c.index)).toEqual([1, 0]);
  });
  it("thins the axis labels", () => {
    const m = columnsModel(Array.from({ length: 30 }, (_, i) => ({ label: String(i), values: [1] })), { mirror: false, maxLabels: 6 });
    expect(m.xLabels.length).toBeLessThanOrEqual(6);
  });
  it("buckets a series into slots", () => {
    expect(bucketSum([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
    expect(bucketSum([], 3)).toEqual([]);
  });
});
