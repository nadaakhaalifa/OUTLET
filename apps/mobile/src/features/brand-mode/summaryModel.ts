/**
 * Pure view-model for the Shopify-style brand overview (GET /v1/seller/stores/{id}/dashboard/summary).
 * No React. Honesty rules: null stays null (never 0), unavailable metrics are listed (never zero-filled).
 */
export type SummaryPeriod = "today" | "7d" | "30d";
export const SUMMARY_PERIODS: readonly SummaryPeriod[] = ["today", "7d", "30d"];

export type UnavailableMetric = "net_sales_after_returns" | "cancellation_rate" | "cod_refusal_by_governorate" | "in_transit_payouts";

export interface Funnel { readonly views: number; readonly bagAdds: number; readonly checkouts: number; readonly purchases: number }
export interface TopProduct { readonly productId: string; readonly title: { readonly ar: string; readonly en: string } | null; readonly units: number; readonly grossSales: bigint }
export interface PeriodTotals {
  readonly grossSales: bigint;
  readonly netAfterCommission: bigint;
  readonly orders: number;
  readonly units: number;
  readonly averageOrderValue: bigint | null;
  readonly returnRateBp: number | null;
  readonly repeatRateBp: number | null;
  readonly funnel: Funnel;
  readonly topProducts: readonly TopProduct[];
}
/** growth_bps per KPI: null = previous value was 0 (or no growth object for AOV). */
export interface SummaryGrowth {
  readonly grossSales: number | null;
  readonly netAfterCommission: number | null;
  readonly orders: number | null;
  readonly units: number | null;
  readonly averageOrderValue: number | null;
}
export interface DailySale { readonly day: string; readonly grossSales: bigint }
export interface DashboardSummary {
  readonly period: SummaryPeriod;
  readonly current: PeriodTotals;
  readonly previous: PeriodTotals;
  readonly growth: SummaryGrowth;
  readonly dailySales: readonly DailySale[];
  readonly unavailable: readonly UnavailableMetric[];
  readonly definitions: Readonly<Record<string, string>>;
  readonly asOfMs: number | null;
  readonly withinSlo: boolean;
  readonly kMin: number;
}

export type KpiId = "grossSales" | "netAfterCommission" | "orders" | "units" | "averageOrderValue" | "returnRate";
export const KPI_ORDER: readonly KpiId[] = ["grossSales", "netAfterCommission", "orders", "units", "averageOrderValue", "returnRate"];
/** Which server definition explains each KPI (orders/units/AOV are explained by the growth rule). */
export const DEFINITION_KEY: Readonly<Record<KpiId, string>> = {
  grossSales: "gross_sales", netAfterCommission: "net_after_commission", orders: "growth", units: "growth", averageOrderValue: "growth", returnRate: "return_rate",
};

/** none = nothing honest to say (both periods empty); new = no previous value to compare with. */
export type Delta =
  | { readonly kind: "none" }
  | { readonly kind: "new" }
  | { readonly kind: "flat" }
  | { readonly kind: "up"; readonly tenths: number }
  | { readonly kind: "down"; readonly tenths: number };

/** growth_bps (half-even, server side) to a delta chip. `currentIsZero` stops "New" being shown when both periods are empty. */
export function deltaOf(bps: number | null, currentIsZero: boolean): Delta {
  if (bps === null) return currentIsZero ? { kind: "none" } : { kind: "new" };
  if (bps === 0) return { kind: "flat" };
  const tenths = Math.round(Math.abs(bps) / 10);
  if (tenths === 0) return { kind: "flat" };
  return bps > 0 ? { kind: "up", tenths } : { kind: "down", tenths };
}
/** Tenths of a percent to ASCII "12.3"; the screen localises digits. */
export const tenthsText = (tenths: number): string => `${Math.trunc(tenths / 10)}.${tenths % 10}`;
/** Basis points to ASCII percent with one decimal. */
export const bpsText = (bps: number): string => tenthsText(Math.round(bps / 10));

/** Return rate: percentage-point change, lower is better. null when either side has no rate. */
export function returnRatePointsDelta(cur: number | null, prev: number | null): Delta {
  if (cur === null || prev === null) return { kind: "none" };
  const d = cur - prev;
  if (d === 0) return { kind: "flat" };
  const tenths = Math.round(Math.abs(d) / 10);
  if (tenths === 0) return { kind: "flat" };
  return d > 0 ? { kind: "up", tenths } : { kind: "down", tenths };
}

export type Tone = "good" | "bad" | "neutral";
/** Colour tone of a delta; `lowerIsBetter` flips it (return rate). */
export function deltaTone(d: Delta, lowerIsBetter = false): Tone {
  if (d.kind === "up") return lowerIsBetter ? "bad" : "good";
  if (d.kind === "down") return lowerIsBetter ? "good" : "bad";
  return "neutral";
}

export type KpiValue =
  | { readonly kind: "money"; readonly value: bigint }
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "bps"; readonly value: number }
  | { readonly kind: "none" };

export interface KpiCard {
  readonly id: KpiId;
  readonly value: KpiValue;
  readonly previous: KpiValue;
  readonly delta: Delta;
  readonly lowerIsBetter: boolean;
  readonly definitionKey: string;
}

const money = (v: bigint | null): KpiValue => (v === null ? { kind: "none" } : { kind: "money", value: v });
const bps = (v: number | null): KpiValue => (v === null ? { kind: "none" } : { kind: "bps", value: v });

export function kpiCards(s: DashboardSummary): readonly KpiCard[] {
  const c = s.current;
  const p = s.previous;
  const card = (id: KpiId, value: KpiValue, previous: KpiValue, delta: Delta, lowerIsBetter = false): KpiCard => ({ id, value, previous, delta, lowerIsBetter, definitionKey: DEFINITION_KEY[id] });
  return [
    card("grossSales", money(c.grossSales), money(p.grossSales), deltaOf(s.growth.grossSales, c.grossSales === 0n)),
    card("netAfterCommission", money(c.netAfterCommission), money(p.netAfterCommission), deltaOf(s.growth.netAfterCommission, c.netAfterCommission === 0n)),
    card("orders", { kind: "count", value: c.orders }, { kind: "count", value: p.orders }, deltaOf(s.growth.orders, c.orders === 0)),
    card("units", { kind: "count", value: c.units }, { kind: "count", value: p.units }, deltaOf(s.growth.units, c.units === 0)),
    card("averageOrderValue", money(c.averageOrderValue), money(p.averageOrderValue), c.averageOrderValue === null ? { kind: "none" } : deltaOf(s.growth.averageOrderValue, false)),
    card("returnRate", bps(c.returnRateBp), bps(p.returnRateBp), returnRatePointsDelta(c.returnRateBp, p.returnRateBp), true),
  ];
}

export interface FunnelStep {
  readonly id: "views" | "bagAdds" | "checkouts" | "purchases";
  readonly count: number;
  /** Share of the previous step in basis points; null for the first step or when the previous step is 0. */
  readonly stepRateBp: number | null;
  /** Client events are consent-sampled, purchases are server facts. */
  readonly sampled: boolean;
  /** Bar width 0..1 relative to the first step (capped at 1). */
  readonly ratio: number;
}
export interface FunnelView {
  readonly empty: boolean;
  readonly steps: readonly FunnelStep[];
  /** purchases / views in basis points; null without views. */
  readonly overallBp: number | null;
}
export function funnelView(f: Funnel): FunnelView {
  const counts = [f.views, f.bagAdds, f.checkouts, f.purchases] as const;
  const ids = ["views", "bagAdds", "checkouts", "purchases"] as const;
  const top = counts[0];
  const steps = ids.map((id, i): FunnelStep => {
    const count = counts[i] ?? 0;
    const prev = i === 0 ? 0 : (counts[i - 1] ?? 0);
    return {
      id, count, sampled: id !== "purchases",
      stepRateBp: i === 0 || prev === 0 ? null : Math.round((count * 10_000) / prev),
      ratio: top <= 0 ? 0 : Math.min(1, count / top),
    };
  });
  return { empty: counts.every((n) => n === 0), steps, overallBp: top <= 0 ? null : Math.round((f.purchases * 10_000) / top) };
}

/** Bar heights 0..1 for the daily series; null when fewer than 2 days or all zero (nothing honest to draw). */
export function dailyBars(days: readonly DailySale[]): readonly number[] | null {
  if (days.length < 2) return null;
  const max = days.reduce((m, d) => (d.grossSales > m ? d.grossSales : m), 0n);
  if (max <= 0n) return null;
  return days.map((d) => Number((d.grossSales * 1000n) / max) / 1000);
}

/** Repeat-customer card: a value, or the "needs N buyers" state. */
export type RepeatView = { readonly kind: "value"; readonly bps: number } | { readonly kind: "needsBuyers"; readonly min: number };
export function repeatView(s: DashboardSummary): RepeatView {
  return s.current.repeatRateBp === null ? { kind: "needsBuyers", min: s.kMin } : { kind: "value", bps: s.current.repeatRateBp };
}

/** Minutes since the server's data_as_of; null when unknown. */
export function updatedMinutes(asOfMs: number | null, nowMs: number): number | null {
  if (asOfMs === null) return null;
  return Math.max(0, Math.floor((nowMs - asOfMs) / 60_000));
}

export const UNAVAILABLE_ORDER: readonly UnavailableMetric[] = ["net_sales_after_returns", "cancellation_rate", "cod_refusal_by_governorate", "in_transit_payouts"];
/** Stable order for the "Not tracked yet" rows. */
export function unavailableRows(s: Pick<DashboardSummary, "unavailable">): readonly UnavailableMetric[] {
  return UNAVAILABLE_ORDER.filter((m) => s.unavailable.includes(m));
}
