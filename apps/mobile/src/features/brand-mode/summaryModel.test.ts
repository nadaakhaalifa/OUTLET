import { describe, expect, it } from "vitest";
import {
  bpsText, dailyBars, deltaOf, deltaTone, funnelView, kpiCards, repeatView, returnRatePointsDelta, tenthsText, unavailableRows, updatedMinutes,
  type DashboardSummary, type PeriodTotals,
} from "./summaryModel";

const totals = (over: Partial<PeriodTotals> = {}): PeriodTotals => ({
  grossSales: 100_000n, netAfterCommission: 87_000n, orders: 4, units: 5, averageOrderValue: 25_000n, returnRateBp: 600, repeatRateBp: null,
  funnel: { views: 200, bagAdds: 40, checkouts: 10, purchases: 4 }, topProducts: [], ...over,
});
const summary = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  period: "7d", current: totals(), previous: totals({ grossSales: 80_000n, returnRateBp: 800 }),
  growth: { grossSales: 2500, netAfterCommission: 2500, orders: 0, units: -1234, averageOrderValue: null },
  dailySales: [], unavailable: ["in_transit_payouts", "net_sales_after_returns"], definitions: {}, asOfMs: 1_000_000, withinSlo: true, kMin: 50, ...over,
});

describe("deltaOf", () => {
  it("up, down, flat, new and none", () => {
    expect(deltaOf(2500, false)).toEqual({ kind: "up", tenths: 250 });
    expect(deltaOf(-1234, false)).toEqual({ kind: "down", tenths: 123 });
    expect(deltaOf(0, false)).toEqual({ kind: "flat" });
    expect(deltaOf(4, false)).toEqual({ kind: "flat" }); // rounds to 0.0 %
    expect(deltaOf(null, false)).toEqual({ kind: "new" });
    expect(deltaOf(null, true)).toEqual({ kind: "none" }); // both periods empty: nothing honest to say
  });
  it("formats tenths and bps with one decimal", () => {
    expect(tenthsText(250)).toBe("25.0");
    expect(tenthsText(123)).toBe("12.3");
    expect(bpsText(600)).toBe("6.0");
    expect(bpsText(1840)).toBe("18.4");
  });
  it("tones flip when lower is better", () => {
    expect(deltaTone({ kind: "up", tenths: 5 })).toBe("good");
    expect(deltaTone({ kind: "down", tenths: 5 })).toBe("bad");
    expect(deltaTone({ kind: "up", tenths: 5 }, true)).toBe("bad");
    expect(deltaTone({ kind: "down", tenths: 5 }, true)).toBe("good");
    expect(deltaTone({ kind: "new" })).toBe("neutral");
    expect(deltaTone({ kind: "flat" })).toBe("neutral");
  });
  it("return-rate delta is in points and none without both rates", () => {
    expect(returnRatePointsDelta(600, 800)).toEqual({ kind: "down", tenths: 20 });
    expect(returnRatePointsDelta(null, 800)).toEqual({ kind: "none" });
    expect(returnRatePointsDelta(800, 800)).toEqual({ kind: "flat" });
  });
});

describe("kpiCards", () => {
  it("six cards with values, previous values and deltas", () => {
    const c = kpiCards(summary());
    expect(c.map((x) => x.id)).toEqual(["grossSales", "netAfterCommission", "orders", "units", "averageOrderValue", "returnRate"]);
    expect(c[0]).toMatchObject({ value: { kind: "money", value: 100_000n }, previous: { kind: "money", value: 80_000n }, delta: { kind: "up", tenths: 250 } });
    expect(c[2]?.delta).toEqual({ kind: "flat" });
    expect(c[3]?.delta).toEqual({ kind: "down", tenths: 123 });
    expect(c[5]).toMatchObject({ value: { kind: "bps", value: 600 }, delta: { kind: "down", tenths: 20 }, lowerIsBetter: true });
  });
  it("null AOV and null return rate stay 'none', never 0", () => {
    const c = kpiCards(summary({ current: totals({ orders: 0, units: 0, averageOrderValue: null, returnRateBp: null, grossSales: 0n }), growth: { grossSales: null, netAfterCommission: null, orders: null, units: null, averageOrderValue: null } }));
    expect(c[4]?.value).toEqual({ kind: "none" });
    expect(c[4]?.delta).toEqual({ kind: "none" });
    expect(c[5]?.value).toEqual({ kind: "none" });
    expect(c[0]?.delta).toEqual({ kind: "none" });
    expect(c[2]?.value).toEqual({ kind: "count", value: 0 }); // a real zero count is a value
  });
  it("previous empty with sales now shows New", () => {
    expect(kpiCards(summary({ growth: { grossSales: null, netAfterCommission: null, orders: null, units: null, averageOrderValue: null } }))[0]?.delta).toEqual({ kind: "new" });
  });
});

describe("funnel, chart, repeat, freshness, unavailable", () => {
  it("step rates are against the previous step; first three are sampled", () => {
    const f = funnelView({ views: 200, bagAdds: 40, checkouts: 10, purchases: 4 });
    expect(f.steps.map((s) => s.stepRateBp)).toEqual([null, 2000, 2500, 4000]);
    expect(f.steps.map((s) => s.sampled)).toEqual([true, true, true, false]);
    expect(f.overallBp).toBe(200);
    expect(f.empty).toBe(false);
    expect(f.steps[1]?.ratio).toBeCloseTo(0.2);
  });
  it("empty funnel and zero denominators never divide", () => {
    const e = funnelView({ views: 0, bagAdds: 0, checkouts: 0, purchases: 0 });
    expect(e.empty).toBe(true);
    expect(e.overallBp).toBeNull();
    const z = funnelView({ views: 0, bagAdds: 0, checkouts: 0, purchases: 3 });
    expect(z.steps.every((s) => s.stepRateBp === null || s.stepRateBp >= 0)).toBe(true);
    expect(z.steps[3]?.stepRateBp).toBeNull();
    expect(z.steps[3]?.ratio).toBe(0);
  });
  it("chart bars need two days and some sales", () => {
    const d = (v: bigint) => ({ day: "2026-10-01", grossSales: v });
    expect(dailyBars([d(5n)])).toBeNull();
    expect(dailyBars([d(0n), d(0n)])).toBeNull();
    expect(dailyBars([d(50n), d(100n)])).toEqual([0.5, 1]);
  });
  it("repeat rate is null-aware", () => {
    expect(repeatView(summary())).toEqual({ kind: "needsBuyers", min: 50 });
    expect(repeatView(summary({ current: totals({ repeatRateBp: 1840 }) }))).toEqual({ kind: "value", bps: 1840 });
    expect(repeatView(summary({ current: totals({ repeatRateBp: 0 }) }))).toEqual({ kind: "value", bps: 0 }); // a real 0 % is a value
  });
  it("freshness minutes", () => {
    expect(updatedMinutes(null, 5)).toBeNull();
    expect(updatedMinutes(0, 3 * 60_000 + 1)).toBe(3);
    expect(updatedMinutes(10, 5)).toBe(0);
  });
  it("unavailable metrics come out in a stable order and only those listed", () => {
    expect(unavailableRows(summary())).toEqual(["net_sales_after_returns", "in_transit_payouts"]);
    expect(unavailableRows(summary({ unavailable: [] }))).toEqual([]);
  });
});
