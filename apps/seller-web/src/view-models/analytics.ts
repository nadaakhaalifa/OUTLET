import type { Locale, MessageKey, Translator } from "../i18n";
import { formatBps, formatInt, formatMoney } from "../lib/format";
import type { AnalyticsMeta, FunnelReport, GeographyReport, SalesReport, TrafficReport } from "../api/schemas";

export type FreshnessLevel = "within" | "stale" | "unknown";

export function freshnessLevel(m: AnalyticsMeta): FreshnessLevel {
  if (m.freshness.as_of === null) return "unknown";
  return m.freshness.within_slo ? "within" : "stale";
}

export function freshnessKey(level: FreshnessLevel): MessageKey {
  return level === "within" ? "dashboard.freshWithin" : level === "stale" ? "dashboard.freshStale" : "dashboard.freshUnknown";
}

export interface Tile {
  readonly id: "gmv" | "net" | "orders" | "units" | "aov" | "repeat";
  readonly labelKey: MessageKey;
  /** null means "no value": the screen shows the not-enough-data text, never zero. */
  readonly value: string | null;
}

export function salesTiles(r: SalesReport, locale: Locale): readonly Tile[] {
  const noOrders = r.orders === 0;
  return [
    { id: "gmv", labelKey: "dashboard.gmv", value: formatMoney(r.gmv.minor, locale) },
    { id: "net", labelKey: "dashboard.net", value: formatMoney(r.net.minor, locale) },
    { id: "orders", labelKey: "dashboard.orders", value: formatInt(r.orders, locale) },
    { id: "units", labelKey: "dashboard.units", value: formatInt(r.units, locale) },
    { id: "aov", labelKey: "dashboard.aov", value: r.aov === null || noOrders ? null : formatMoney(r.aov.minor, locale) },
    {
      id: "repeat",
      labelKey: "dashboard.repeat",
      value: r.repeat_rate_suppressed || r.repeat_rate_bps === null ? null : formatBps(r.repeat_rate_bps, locale),
    },
  ];
}

export interface SuppressionNote {
  readonly text: string;
}

/** Suppressed cells are only counted, never named. */
export function suppressionNote(count: number, k: number, t: Translator, locale: Locale): SuppressionNote | null {
  if (count <= 0) return null;
  return { text: t("dashboard.suppressed", { count: formatInt(count, locale), k: formatInt(k, locale) }) };
}

export interface BreakdownRow {
  readonly key: string;
  readonly value: string;
  readonly includesSuppressed: boolean;
}

export function trafficRows(r: TrafficReport, locale: Locale): readonly BreakdownRow[] {
  return r.by_source.items.map((i) => ({ key: i.key, value: formatInt(i.events, locale), includesSuppressed: i.includes_suppressed === true }));
}

export function geographyRows(r: GeographyReport, locale: Locale): readonly (BreakdownRow & { readonly orders: string })[] {
  return r.governorates.map((g) => ({
    key: g.governorate,
    value: formatMoney(g.gmv.minor, locale),
    orders: formatInt(g.orders, locale),
    includesSuppressed: g.includes_suppressed === true,
  }));
}

export interface FunnelRow {
  readonly stage: string;
  readonly count: string;
  readonly fromPrevious: string | null;
}

export function funnelRows(r: FunnelReport, locale: Locale): readonly FunnelRow[] {
  return r.total.steps.map((s) => ({
    stage: s.stage,
    count: formatInt(s.count, locale),
    fromPrevious: s.from_previous_bps === null ? null : formatBps(s.from_previous_bps, locale),
  }));
}

export function isEmptyReport(r: SalesReport): boolean {
  return r.orders === 0 && r.units === 0 && r.gmv.minor === 0n;
}

/** Default period: the last 30 whole UTC days ending today (server will snap to days anyway). */
export function defaultRange(nowMs: number): { from: string; to: string } {
  const day = 86_400_000;
  const end = Math.floor(nowMs / day) * day + day;
  return { from: new Date(end - 30 * day).toISOString(), to: new Date(end).toISOString() };
}
