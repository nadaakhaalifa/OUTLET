import type { Clock, IdGenerator } from "../../../platform/ports";
import { indexToIsoDay, isoDayToIndex } from "../domain/bridge";
import {
  ForecastingDisabledError,
  SeriesRowSchema,
  type ForecastFlags,
  type ForecastQuery,
  type ForecastRecord,
  type ForecastStore,
  type LatestForecasts,
  type SeriesRow,
} from "../domain/ports";
import { buildStoreForecasts } from "./build";

/** Window of history a run loads: 26 weeks is ample for weekly seasonality and bounds the work. */
export const HISTORY_WINDOW_DAYS = 182;
/** A forecast older than this is shown as stale (spec: forecasts tolerate 24 h; 12 h grace). */
export const STALE_AFTER_MS = 36 * 3_600_000;

export interface IngestResult {
  readonly accepted: number;
  readonly rejected: number;
}

/** Validates and stores day aggregates. The warehouse feeder (seller analytics) calls this; there is no HTTP route. */
export class IngestDemandSeries {
  constructor(
    private readonly store: ForecastStore,
    private readonly clock: Clock,
  ) {}

  async execute(raw: readonly unknown[]): Promise<IngestResult> {
    const rows: SeriesRow[] = [];
    let rejected = 0;
    for (const r of raw) {
      const p = SeriesRowSchema.safeParse(r);
      if (p.success) rows.push(p.data);
      else rejected += 1;
    }
    if (rows.length > 0) await this.store.upsertSeries(rows, this.clock.nowMs());
    return { accepted: rows.length, rejected };
  }
}

export interface BatchResult {
  readonly stores: number;
  readonly completed: number;
  readonly failed: number;
  readonly forecasts: number;
  readonly insufficient: number;
  readonly suppressed: number;
  readonly disabled: number;
}

const EMPTY: BatchResult = { stores: 0, completed: 0, failed: 0, forecasts: 0, insufficient: 0, suppressed: 0, disabled: 0 };

/**
 * Nightly batch. Idempotent by (store, as-of day): a store with a completed run is not selected, a
 * completed run is never rewritten, and forecast rows are unique by (store, scope, key, horizon, as-of).
 * A failure for one store is recorded and does not stop the others; the previous forecast stays
 * served and is flagged stale at read time.
 */
export class RunForecastBatch {
  constructor(
    private readonly store: ForecastStore,
    private readonly flags: ForecastFlags,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(asOfDay: string, storeLimit = 50): Promise<BatchResult> {
    if (!(await this.flags.enabled())) return { ...EMPTY, disabled: 1 };
    const fromDay = indexToIsoDay(isoDayToIndex(asOfDay) - HISTORY_WINDOW_DAYS + 1);
    const stores = await this.store.storesPendingRun(asOfDay, storeLimit);
    let completed = 0;
    let failed = 0;
    let forecasts = 0;
    let insufficient = 0;
    let suppressed = 0;
    for (const storeId of stores) {
      const startedAtMs = this.clock.nowMs();
      try {
        const rows = await this.store.loadSeries(storeId, fromDay, asOfDay);
        const built = buildStoreForecasts(storeId, rows, asOfDay, startedAtMs, () => this.ids.uuidV7());
        const res = await this.store.saveCompletedRun(
          {
            storeId,
            asOfDay,
            status: "completed",
            ...built.summary,
            errorCode: null,
            startedAtMs,
            finishedAtMs: this.clock.nowMs(),
          },
          built.records,
        );
        completed += 1;
        forecasts += res.inserted;
        insufficient += built.summary.insufficientCount;
        suppressed += built.summary.suppressedCount;
      } catch {
        failed += 1;
        // A failure while recording the failure must not abort the remaining stores either.
        await this.store
          .saveFailedRun({
            storeId,
            asOfDay,
            status: "failed",
            seriesTotal: 0,
            okCount: 0,
            insufficientCount: 0,
            suppressedCount: 0,
            servedModels: {},
            meanWapeBps: null,
            meanBaselineWapeBps: null,
            meanPinballMilli: null,
            meanCoverageBps: null,
            meanBiasBps: null,
            errorCode: "forecast_run_failed",
            startedAtMs,
            finishedAtMs: this.clock.nowMs(),
          })
          .catch(() => undefined);
      }
    }
    return { stores: stores.length, completed, failed, forecasts, insufficient, suppressed, disabled: 0 };
  }
}

export interface SellerForecastView {
  readonly storeId: string;
  readonly asOfDay: string | null;
  readonly generatedAtMs: number | null;
  readonly stale: boolean;
  readonly items: readonly ForecastRecord[];
  readonly hasMore: boolean;
}

export const MAX_LIST_LIMIT = 200;

export class SellerForecastQueries {
  constructor(
    private readonly store: ForecastStore,
    private readonly flags: ForecastFlags,
    private readonly clock: Clock,
  ) {}

  async list(storeId: string, q: Omit<ForecastQuery, "limit"> & { readonly limit?: number }): Promise<SellerForecastView> {
    if (!(await this.flags.enabled())) throw new ForecastingDisabledError();
    const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_LIST_LIMIT);
    const latest: LatestForecasts = await this.store.latest(storeId, { ...q, limit });
    const gen = latest.items.reduce<number | null>(
      (m, i) => (m === null || i.generatedAtMs > m ? i.generatedAtMs : m),
      null,
    );
    const failedAfter = latest.lastRun?.status === "failed";
    const old = gen !== null && this.clock.nowMs() - gen > STALE_AFTER_MS;
    return {
      storeId,
      asOfDay: latest.items[0]?.asOfDay ?? null,
      generatedAtMs: gen,
      stale: failedAfter || old,
      items: latest.items,
      hasMore: latest.hasMore,
    };
  }
}
