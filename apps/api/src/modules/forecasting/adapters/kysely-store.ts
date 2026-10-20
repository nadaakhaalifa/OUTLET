import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { HorizonDays, ModelId } from "../domain/bridge";
import type {
  ForecastQuery,
  ForecastRecord,
  ForecastScope,
  ForecastStatus,
  ForecastStore,
  LatestForecasts,
  RunSummary,
  SeriesRow,
} from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the seller-analytics adapter). */
export type ForecastingDb = Kysely<Record<string, never>>;

const Num = z.union([z.number(), z.string()]).transform((v) => Number(v));
const NumOrNull = z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v)));
const Ms = z.union([z.number(), z.string()]).transform((v) => Number(v));

const ForecastRow = z.object({
  id: z.string(),
  store_id: z.string(),
  scope: z.enum(["sku", "category", "category_size", "category_governorate"]),
  scope_key: z.string(),
  horizon_days: Num,
  as_of_date: z.string(),
  model: z.enum(["seasonal_naive", "ets_seasonal", "croston_sba"]).nullable(),
  model_version: z.string(),
  status: z.enum(["ok", "insufficient_history", "suppressed"]),
  p10: NumOrNull,
  p50: NumOrNull,
  p90: NumOrNull,
  reason_codes: z.array(z.string()),
  comparable_units: Num,
  observed_days: Num,
  backtest_origins: Num,
  wape_bps: NumOrNull,
  baseline_wape_bps: NumOrNull,
  pinball_milli: NumOrNull,
  coverage_bps: NumOrNull,
  bias_bps: NumOrNull,
  generated_ms: Ms,
});
const RunRow = z.object({
  store_id: z.string(),
  as_of_date: z.string(),
  status: z.enum(["completed", "failed"]),
  series_total: Num,
  ok_count: Num,
  insufficient_count: Num,
  suppressed_count: Num,
  served_models: z.record(z.string(), z.number()),
  mean_wape_bps: NumOrNull,
  mean_baseline_wape_bps: NumOrNull,
  mean_pinball_milli: NumOrNull,
  mean_coverage_bps: NumOrNull,
  mean_bias_bps: NumOrNull,
  error_code: z.string().nullable(),
  started_ms: Ms,
  finished_ms: Ms,
});
const SeriesDbRow = z.object({
  store_id: z.string(),
  sku_id: z.string(),
  category_code: z.string(),
  size_label: z.string(),
  governorate: z.string(),
  day: z.string(),
  units_gross: Num,
  units_net: Num,
  censored: z.boolean(),
  flagged: z.boolean(),
  shoppers: Num,
});

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;

function toRecord(r: z.infer<typeof ForecastRow>): ForecastRecord {
  return {
    id: r.id,
    storeId: r.store_id,
    scope: r.scope as ForecastScope,
    scopeKey: r.scope_key,
    horizonDays: r.horizon_days as HorizonDays,
    asOfDay: r.as_of_date,
    model: r.model as ModelId | null,
    modelVersion: r.model_version,
    status: r.status as ForecastStatus,
    p10: r.p10,
    p50: r.p50,
    p90: r.p90,
    reasonCodes: r.reason_codes,
    comparableUnits: r.comparable_units,
    observedDays: r.observed_days,
    backtestOrigins: r.backtest_origins,
    wapeBps: r.wape_bps,
    baselineWapeBps: r.baseline_wape_bps,
    pinballMilli: r.pinball_milli,
    coverageBps: r.coverage_bps,
    biasBps: r.bias_bps,
    generatedAtMs: r.generated_ms,
  };
}

function toRun(r: z.infer<typeof RunRow>): RunSummary {
  return {
    storeId: r.store_id,
    asOfDay: r.as_of_date,
    status: r.status,
    seriesTotal: r.series_total,
    okCount: r.ok_count,
    insufficientCount: r.insufficient_count,
    suppressedCount: r.suppressed_count,
    servedModels: r.served_models,
    meanWapeBps: r.mean_wape_bps,
    meanBaselineWapeBps: r.mean_baseline_wape_bps,
    meanPinballMilli: r.mean_pinball_milli,
    meanCoverageBps: r.mean_coverage_bps,
    meanBiasBps: r.mean_bias_bps,
    errorCode: r.error_code,
    startedAtMs: r.started_ms,
    finishedAtMs: r.finished_ms,
  };
}

const FORECAST_COLS = sql`id::text as id, store_id::text as store_id, scope, scope_key, horizon_days,
  to_char(as_of_date, 'YYYY-MM-DD') as as_of_date, model, model_version, status, p10, p50, p90, reason_codes,
  comparable_units, observed_days, backtest_origins, wape_bps, baseline_wape_bps, pinball_milli, coverage_bps,
  bias_bps, (extract(epoch from generated_at) * 1000)::bigint as generated_ms`;
const RUN_COLS = sql`store_id::text as store_id, to_char(as_of_date, 'YYYY-MM-DD') as as_of_date, status,
  series_total, ok_count, insufficient_count, suppressed_count, served_models, mean_wape_bps,
  mean_baseline_wape_bps, mean_pinball_milli, mean_coverage_bps, mean_bias_bps, error_code,
  (extract(epoch from started_at) * 1000)::bigint as started_ms,
  (extract(epoch from finished_at) * 1000)::bigint as finished_ms`;

/**
 * Postgres adapter over migrations 0064 and 0065. Writes run as the `system` role. Reads run with
 * `app.role = 'seller'` and `app.store_ids = <the one store>` so RLS is on for every read AND each
 * query repeats `store_id = $1` (defence in depth).
 */
export class KyselyForecastStore implements ForecastStore {
  constructor(private readonly db: ForecastingDb) {}

  private async asRole<X>(role: "system" | "seller", storeId: string | null, run: (trx: ForecastingDb) => Promise<X>): Promise<X> {
    return this.db.transaction().execute(async (trx) => {
      if (role === "seller") {
        await sql`select set_config('app.role', 'seller', true), set_config('app.store_ids', ${storeId ?? ""}, true)`.execute(trx);
      } else {
        await sql`select set_config('app.role', 'system', true)`.execute(trx);
      }
      return run(trx as unknown as ForecastingDb);
    });
  }

  async upsertSeries(rows: readonly SeriesRow[], _nowMs: number): Promise<{ upserted: number }> {
    if (rows.length === 0) return { upserted: 0 };
    await this.asRole("system", null, async (trx) => {
      for (const r of rows) {
        await sql`
          insert into forecast_demand_series (store_id, sku_id, category_code, size_label, governorate, day,
            units_gross, units_net, censored, flagged, shoppers)
          values (${r.storeId}::uuid, ${r.skuId}::uuid, ${r.categoryCode}, ${r.sizeLabel}, ${r.governorate},
            ${r.day}::date, ${r.unitsGross}, ${r.unitsNet}, ${r.censored}, ${r.flagged}, ${r.shoppers})
          on conflict (store_id, sku_id, governorate, day) do update set
            category_code = excluded.category_code, size_label = excluded.size_label,
            units_gross = excluded.units_gross, units_net = excluded.units_net,
            censored = excluded.censored, flagged = excluded.flagged, shoppers = excluded.shoppers,
            ingested_at = now()`.execute(trx);
      }
    });
    return { upserted: rows.length };
  }

  async loadSeries(storeId: string, fromDay: string, asOfDay: string): Promise<readonly SeriesRow[]> {
    return this.asRole("system", null, async (trx) => {
      const res = await sql`
        select store_id::text as store_id, sku_id::text as sku_id, category_code, size_label, governorate,
               to_char(day, 'YYYY-MM-DD') as day, units_gross, units_net, censored, flagged, shoppers
        from forecast_demand_series
        where store_id = ${storeId}::uuid and day >= ${fromDay}::date and day <= ${asOfDay}::date
        order by day, sku_id, governorate`.execute(trx);
      return res.rows.map((raw) => {
        const r = SeriesDbRow.parse(raw);
        return {
          storeId: r.store_id,
          skuId: r.sku_id,
          categoryCode: r.category_code,
          sizeLabel: r.size_label,
          governorate: r.governorate,
          day: r.day,
          unitsGross: r.units_gross,
          unitsNet: r.units_net,
          censored: r.censored,
          flagged: r.flagged,
          shoppers: r.shoppers,
        };
      });
    });
  }

  async storesPendingRun(asOfDay: string, limit: number): Promise<readonly string[]> {
    return this.asRole("system", null, async (trx) => {
      const res = await sql<{ store_id: string }>`
        select distinct s.store_id::text as store_id
        from forecast_demand_series s
        where s.day <= ${asOfDay}::date
          and not exists (select 1 from forecast_runs r
                          where r.store_id = s.store_id and r.as_of_date = ${asOfDay}::date and r.status = 'completed')
        order by 1 limit ${limit}`.execute(trx);
      return res.rows.map((r) => r.store_id);
    });
  }

  async saveCompletedRun(run: RunSummary, forecasts: readonly ForecastRecord[]): Promise<{ inserted: number }> {
    return this.asRole("system", null, async (trx) => {
      const claimed = await sql<{ one: number }>`
        insert into forecast_runs (store_id, as_of_date, status, series_total, ok_count, insufficient_count,
          suppressed_count, served_models, mean_wape_bps, mean_baseline_wape_bps, mean_pinball_milli,
          mean_coverage_bps, mean_bias_bps, error_code, started_at, finished_at)
        values (${run.storeId}::uuid, ${run.asOfDay}::date, 'completed', ${run.seriesTotal}, ${run.okCount},
          ${run.insufficientCount}, ${run.suppressedCount}, ${JSON.stringify(run.servedModels)}::jsonb,
          ${run.meanWapeBps}, ${run.meanBaselineWapeBps}, ${run.meanPinballMilli}, ${run.meanCoverageBps},
          ${run.meanBiasBps}, null, ${ts(run.startedAtMs)}, ${ts(run.finishedAtMs)})
        on conflict (store_id, as_of_date) do update set
          status = 'completed', series_total = excluded.series_total, ok_count = excluded.ok_count,
          insufficient_count = excluded.insufficient_count, suppressed_count = excluded.suppressed_count,
          served_models = excluded.served_models, mean_wape_bps = excluded.mean_wape_bps,
          mean_baseline_wape_bps = excluded.mean_baseline_wape_bps, mean_pinball_milli = excluded.mean_pinball_milli,
          mean_coverage_bps = excluded.mean_coverage_bps, mean_bias_bps = excluded.mean_bias_bps,
          error_code = null, started_at = excluded.started_at, finished_at = excluded.finished_at
        where forecast_runs.status = 'failed'
        returning 1 as one`.execute(trx);
      if (claimed.rows.length === 0) return { inserted: 0 };
      let inserted = 0;
      for (const f of forecasts) {
        const r = await sql<{ one: number }>`
          insert into demand_forecasts (id, store_id, scope, scope_key, horizon_days, as_of_date, model,
            model_version, status, p10, p50, p90, reason_codes, comparable_units, observed_days,
            backtest_origins, wape_bps, baseline_wape_bps, pinball_milli, coverage_bps, bias_bps, generated_at)
          values (${f.id}::uuid, ${f.storeId}::uuid, ${f.scope}, ${f.scopeKey}, ${f.horizonDays},
            ${f.asOfDay}::date, ${f.model}, ${f.modelVersion}, ${f.status}, ${f.p10}, ${f.p50}, ${f.p90},
            ${JSON.stringify(f.reasonCodes)}::jsonb, ${f.comparableUnits}, ${f.observedDays}, ${f.backtestOrigins},
            ${f.wapeBps}, ${f.baselineWapeBps}, ${f.pinballMilli}, ${f.coverageBps}, ${f.biasBps}, ${ts(f.generatedAtMs)})
          on conflict (store_id, scope, scope_key, horizon_days, as_of_date) do nothing
          returning 1 as one`.execute(trx);
        inserted += r.rows.length;
      }
      return { inserted };
    });
  }

  async saveFailedRun(run: RunSummary): Promise<void> {
    await this.asRole("system", null, async (trx) => {
      await sql`
        insert into forecast_runs (store_id, as_of_date, status, series_total, ok_count, insufficient_count,
          suppressed_count, error_code, started_at, finished_at)
        values (${run.storeId}::uuid, ${run.asOfDay}::date, 'failed', 0, 0, 0, 0, ${run.errorCode},
          ${ts(run.startedAtMs)}, ${ts(run.finishedAtMs)})
        on conflict (store_id, as_of_date) do update set
          error_code = excluded.error_code, started_at = excluded.started_at, finished_at = excluded.finished_at
        where forecast_runs.status = 'failed'`.execute(trx);
    });
  }

  async latest(storeId: string, q: ForecastQuery): Promise<LatestForecasts> {
    return this.asRole("seller", storeId, async (trx) => {
      const runRes = await sql`
        select ${RUN_COLS} from forecast_runs where store_id = ${storeId}::uuid
        order by as_of_date desc limit 1`.execute(trx);
      const lastRun = runRes.rows[0] === undefined ? null : toRun(RunRow.parse(runRes.rows[0]));
      const doneRes = await sql<{ d: string }>`
        select to_char(max(as_of_date), 'YYYY-MM-DD') as d from forecast_runs
        where store_id = ${storeId}::uuid and status = 'completed'`.execute(trx);
      const day = doneRes.rows[0]?.d ?? null;
      if (day === null) return { items: [], hasMore: false, lastRun };
      const res = await sql`
        select ${FORECAST_COLS} from demand_forecasts
        where store_id = ${storeId}::uuid and as_of_date = ${day}::date
          and (${q.scope ?? null}::text is null or scope = ${q.scope ?? null})
          and (${q.scopeKey ?? null}::text is null or scope_key = ${q.scopeKey ?? null})
          and (${q.horizonDays ?? null}::int is null or horizon_days = ${q.horizonDays ?? null})
        order by scope, scope_key, horizon_days
        limit ${q.limit + 1}`.execute(trx);
      const all = res.rows.map((r) => toRecord(ForecastRow.parse(r)));
      return { items: all.slice(0, q.limit), hasMore: all.length > q.limit, lastRun };
    });
  }
}
