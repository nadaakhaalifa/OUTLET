import type { ForecastItem, ForecastList, ForecastScope } from "../api/schemas-phase3";
import type { Locale, MessageKey } from "../i18n";
import { formatBps, formatDateTime, formatInt } from "../lib/format";

export const SCOPES: readonly ForecastScope[] = ["category", "category_size", "category_governorate", "sku"];
export const HORIZONS = ["7", "14", "28"] as const;
export type Horizon = (typeof HORIZONS)[number];

export const parseScope = (v: string | undefined): ForecastScope | undefined => SCOPES.find((s) => s === v);
export const parseHorizon = (v: string | undefined): Horizon | undefined => HORIZONS.find((h) => h === v);

const REASONS = [
  "units_below_minimum", "days_below_minimum", "no_valid_backtest", "k_anonymity_below_minimum", "weekly_seasonality",
  "intermittent_demand", "stockout_days_excluded", "promotion_days_excluded", "baseline_served", "model_beat_baseline",
  "not_reconciled_partial_children", "reconciled_to_parent",
] as const;

/** Unknown server reason codes fall back to a neutral sentence; the raw code is never shown as copy. */
export function reasonKey(code: string): MessageKey {
  return ((REASONS as readonly string[]).includes(code) ? `forecasts.reason.${code}` : "forecasts.reason.other") as MessageKey;
}

export interface IntervalVM {
  readonly p10: string; readonly p50: string; readonly p90: string;
  /** e.g. "80%": the nominal coverage the model targets, not a measured hit rate. */
  readonly coverage: string;
}
export interface ForecastRowVM {
  readonly key: string;
  readonly scope: ForecastScope;
  readonly scopeKey: string;
  readonly horizon: number;
  readonly status: ForecastItem["status"];
  /** Present only for status "ok" with all three quantiles; there is no bare point estimate anywhere. */
  readonly interval: IntervalVM | null;
  readonly modelKey: MessageKey | null;
  readonly reasons: readonly MessageKey[];
  readonly history: string | null;
  readonly backtestCoverage: string | null;
}
export interface ForecastsVM {
  readonly storeId: string;
  readonly asOf: string;
  readonly generatedAt: string;
  readonly stale: boolean;
  readonly notice: string;
  readonly rows: readonly ForecastRowVM[];
  readonly hasMore: boolean;
}

export function forecastRows(items: readonly ForecastItem[], locale: Locale): readonly ForecastRowVM[] {
  return items.map((i) => {
    const iv = i.status === "ok" ? i.interval : undefined;
    return {
      key: `${i.scope}|${i.scope_key}|${i.horizon_days}`,
      scope: i.scope, scopeKey: i.scope_key, horizon: i.horizon_days, status: i.status,
      interval: iv === undefined
        ? null
        : { p10: formatInt(iv.p10, locale), p50: formatInt(iv.p50, locale), p90: formatInt(iv.p90, locale), coverage: formatBps(iv.nominal_coverage_bps, locale) },
      modelKey: i.status === "ok" && i.model !== undefined ? (`forecasts.model.${i.model}` as MessageKey) : null,
      reasons: i.reason_codes.map(reasonKey),
      history: i.history?.comparable_units === undefined ? null : formatInt(i.history.comparable_units, locale),
      backtestCoverage: i.backtest?.coverage_bps === undefined ? null : formatBps(i.backtest.coverage_bps, locale),
    };
  });
}

export function forecastsView(l: ForecastList, locale: Locale): ForecastsVM {
  return {
    storeId: l.store_id, asOf: l.as_of_date, generatedAt: formatDateTime(l.generated_at, locale), stale: l.stale,
    notice: locale === "ar" ? l.notice.ar : l.notice.en, rows: forecastRows(l.items, locale), hasMore: l.has_more,
  };
}
