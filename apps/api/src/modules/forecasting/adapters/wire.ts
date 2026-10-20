import type { SellerForecastView } from "../application/forecasting";
import type { ForecastRecord } from "../domain/ports";
import { NOMINAL_COVERAGE_BPS } from "../domain/bridge";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Bilingual advice-only notice (spec 20.8: advice only, seller or ops acts; 19.1: a new price will
 * not show a % off unless it is verified).
 */
export const FORECAST_NOTICE = {
  en: "Estimates are advice only. The range shows where demand is expected to fall 8 times out of 10. A new price will not show a % off unless it is verified.",
  ar: "التقديرات للاسترشاد فقط. يوضح النطاق أين يُتوقع أن يقع الطلب في 8 حالات من كل 10. لن يظهر السعر الجديد بخصم % ما لم يتم التحقق منه.",
} as const;

/**
 * One forecast cell. There is no point-estimate field: a numeric forecast is only ever the
 * `interval` object (p10, p50, p90 together), and it is absent for insufficient or suppressed cells.
 */
function itemWire(f: ForecastRecord) {
  const base = {
    scope: f.scope,
    scope_key: f.scopeKey,
    horizon_days: f.horizonDays,
    status: f.status,
    reason_codes: f.reasonCodes,
    model_version: f.modelVersion,
  };
  if (f.status !== "ok" || f.p10 === null || f.p50 === null || f.p90 === null) return base;
  return {
    ...base,
    model: f.model,
    interval: { p10: f.p10, p50: f.p50, p90: f.p90, nominal_coverage_bps: NOMINAL_COVERAGE_BPS },
    history: { comparable_units: f.comparableUnits, observed_days: f.observedDays },
    backtest: {
      origins: f.backtestOrigins,
      wape_bps: f.wapeBps,
      baseline_wape_bps: f.baselineWapeBps,
      coverage_bps: f.coverageBps,
      bias_bps: f.biasBps,
    },
  };
}

export const forecastsWire = (v: SellerForecastView) => ({
  store_id: v.storeId,
  as_of_date: v.asOfDay,
  generated_at: iso(v.generatedAtMs),
  stale: v.stale,
  advice_only: true as const,
  notice: FORECAST_NOTICE,
  items: v.items.map(itemWire),
  has_more: v.hasMore,
});
