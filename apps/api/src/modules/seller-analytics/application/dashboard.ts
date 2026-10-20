import { divideRoundHalfEven } from "@outlet/domain";
import { freshnessOf, returnRateBps, summarizeSales, type Freshness } from "../domain/bridge";
import type { AnalyticsStore, Range } from "../domain/ports";

export const PERIODS = ["today", "7d", "30d"] as const;
export type DashboardPeriod = (typeof PERIODS)[number];
export const TOP_PRODUCTS = 5;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const CAIRO = "Africa/Cairo";
const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAIRO,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function localParts(ms: number): { y: number; mo: number; d: number; offsetMs: number } {
  const floored = Math.floor(ms / 1000) * 1000;
  const p = Object.fromEntries(PARTS.formatToParts(new Date(floored)).map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p["year"] ?? 0, (p["month"] ?? 1) - 1, p["day"] ?? 1, p["hour"] ?? 0, p["minute"] ?? 0, p["second"] ?? 0);
  return { y: p["year"] ?? 0, mo: p["month"] ?? 1, d: p["day"] ?? 1, offsetMs: asUtc - floored };
}

/** Start (UTC ms) of the Africa/Cairo calendar day containing `ms`. Handles DST by re-evaluating the offset at the candidate. */
export function cairoDayStart(ms: number): number {
  const a = localParts(ms);
  const guess = Date.UTC(a.y, a.mo - 1, a.d) - a.offsetMs;
  const b = localParts(guess);
  return Date.UTC(a.y, a.mo - 1, a.d) - b.offsetMs;
}

export const cairoDateKey = (ms: number): string => {
  const p = localParts(ms);
  return `${String(p.y).padStart(4, "0")}-${String(p.mo).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

export interface PeriodWindows {
  readonly current: Range;
  readonly previous: Range;
}

/**
 * today: Cairo midnight to now, compared with the same elapsed span of yesterday. 7d / 30d: the last N Cairo days
 * including today (partial), compared with the immediately preceding window of the same length.
 */
export function periodWindows(period: DashboardPeriod, nowMs: number): PeriodWindows {
  const todayStart = cairoDayStart(nowMs);
  const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
  const fromMs = cairoDayStart(todayStart - (days - 1) * DAY + 12 * HOUR);
  const length = nowMs - fromMs;
  if (period === "today") {
    const prevFrom = cairoDayStart(fromMs - 12 * HOUR);
    return { current: { fromMs, toMs: nowMs }, previous: { fromMs: prevFrom, toMs: prevFrom + length } };
  }
  return { current: { fromMs, toMs: nowMs }, previous: { fromMs: fromMs - length, toMs: fromMs } };
}

export interface PeriodMetrics {
  readonly grossSalesMinor: bigint;
  readonly netAfterCommissionMinor: bigint;
  readonly orders: number;
  readonly units: number;
  readonly aovMinor: bigint | null;
  readonly returnedUnits: number;
  /** Returned units / units sold in the period (items sold before returns); null when nothing sold. */
  readonly returnRateBps: number | null;
  /** Null below K_ANONYMITY_MIN distinct shoppers. */
  readonly repeatRateBps: number | null;
  readonly funnel: { readonly views: number; readonly bagAdds: number; readonly checkouts: number; readonly purchases: number };
  readonly topProducts: readonly { readonly productId: string; readonly units: number; readonly grossMinor: bigint }[];
}

export interface Growth {
  readonly delta: bigint;
  /** Half-even basis points; null when the previous value is 0. */
  readonly growthBps: number | null;
}

export function growth(cur: bigint, prev: bigint): Growth {
  return { delta: cur - prev, growthBps: prev === 0n ? null : Number(divideRoundHalfEven((cur - prev) * 10_000n, prev)) };
}

export interface DashboardSummary {
  readonly storeId: string;
  readonly period: DashboardPeriod;
  readonly current: Range;
  readonly previous: Range;
  readonly currentMetrics: PeriodMetrics;
  readonly previousMetrics: PeriodMetrics;
  readonly growth: {
    readonly grossSales: Growth;
    readonly netAfterCommission: Growth;
    readonly orders: Growth;
    readonly units: Growth;
    readonly aov: Growth | null;
  };
  readonly dailySales: readonly { readonly day: string; readonly grossMinor: bigint; readonly orders: number; readonly units: number }[];
  readonly freshness: Freshness;
}

export class SellerDashboardSummary {
  constructor(private readonly d: { readonly store: AnalyticsStore; readonly clock: { nowMs(): number } }) {}

  private async metrics(storeId: string, r: Range): Promise<PeriodMetrics> {
    const [totals, skus, funnel, products] = await Promise.all([
      this.d.store.salesTotals(storeId, r),
      this.d.store.skuSales(storeId, r),
      this.d.store.funnelByProduct(storeId, r),
      this.d.store.productSales(storeId, r),
    ]);
    const s = summarizeSales(totals);
    const returned = skus.reduce((n, x) => n + x.returnedUnits, 0);
    const sold = skus.reduce((n, x) => n + x.soldUnits, 0);
    const f = (k: "view" | "bag" | "checkout" | "purchase") => funnel.reduce((n, x) => n + x.counts[k], 0);
    return {
      grossSalesMinor: s.gmvMinor,
      netAfterCommissionMinor: s.netMinor,
      orders: s.orders,
      units: s.units,
      aovMinor: s.aovMinor,
      returnedUnits: returned,
      returnRateBps: returnRateBps(returned, sold),
      repeatRateBps: s.repeatRateBps.suppressed ? null : s.repeatRateBps.value,
      funnel: { views: f("view"), bagAdds: f("bag"), checkouts: f("checkout"), purchases: f("purchase") },
      topProducts: [...products]
        .sort((a, b) => b.units - a.units || (a.grossMinor === b.grossMinor ? 0 : a.grossMinor > b.grossMinor ? -1 : 1) || (a.productId < b.productId ? -1 : 1))
        .slice(0, TOP_PRODUCTS),
    };
  }

  async summary(storeId: string, period: DashboardPeriod): Promise<DashboardSummary> {
    const now = this.d.clock.nowMs();
    const w = periodWindows(period, now);
    const [cur, prev, daily, fresh] = await Promise.all([
      this.metrics(storeId, w.current),
      this.metrics(storeId, w.previous),
      this.d.store.dailySales(storeId, w.current),
      this.d.store.freshness(storeId),
    ]);
    const byDay = new Map(daily.map((x) => [x.day, x]));
    const series: DashboardSummary["dailySales"][number][] = [];
    for (let t = cairoDayStart(w.current.fromMs); t < w.current.toMs; t = cairoDayStart(t + 30 * HOUR)) {
      const day = cairoDateKey(t);
      series.push(byDay.get(day) ?? { day, grossMinor: 0n, orders: 0, units: 0 });
    }
    return {
      storeId,
      period,
      current: w.current,
      previous: w.previous,
      currentMetrics: cur,
      previousMetrics: prev,
      growth: {
        grossSales: growth(cur.grossSalesMinor, prev.grossSalesMinor),
        netAfterCommission: growth(cur.netAfterCommissionMinor, prev.netAfterCommissionMinor),
        orders: growth(BigInt(cur.orders), BigInt(prev.orders)),
        units: growth(BigInt(cur.units), BigInt(prev.units)),
        aov: cur.aovMinor !== null && prev.aovMinor !== null ? growth(cur.aovMinor, prev.aovMinor) : null,
      },
      dailySales: series,
      freshness: freshnessOf(fresh?.lastIngestMs ?? null, fresh?.lastEventMs ?? null, now),
    };
  }
}
