import { z } from "zod";
import { isoDayToIndex, type HorizonDays, type ModelId } from "./bridge";

export const SCOPES = ["sku", "category", "category_size", "category_governorate"] as const;
export type ForecastScope = (typeof SCOPES)[number];
export type ForecastStatus = "ok" | "insufficient_history" | "suppressed";

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    try {
      isoDayToIndex(d);
      return true;
    } catch {
      return false;
    }
  }, "not a real calendar day");
const label = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !s.includes("|") && ![...s].some((c) => c.charCodeAt(0) < 32), "label must not contain '|' or control characters");

/**
 * One day of demand for a (store, sku, governorate). A day aggregate, replaced idempotently by the
 * same key. Strict: a `user_id`, `measurements` or `budget` property fails validation at ingest.
 * Orders flagged by fraud must be excluded by the feeder (spec: sellers could game demand signals).
 */
export const SeriesRowSchema = z
  .strictObject({
    storeId: z.uuid(),
    skuId: z.uuid(),
    categoryCode: z.string().regex(/^[a-z0-9_.-]{1,32}$/),
    sizeLabel: label(1, 16),
    governorate: label(2, 40).default("unknown"),
    day: isoDay,
    unitsGross: z.number().int().min(0).max(100_000),
    unitsNet: z.number().int().min(0).max(100_000),
    censored: z.boolean(),
    flagged: z.boolean(),
    /** Distinct shoppers that day; used only for the k-anonymity gate, never summed or returned. */
    shoppers: z.number().int().min(0).max(100_000),
  })
  .refine((r) => r.unitsNet <= r.unitsGross && r.shoppers <= r.unitsGross, "net and shoppers cannot exceed gross units");
export type SeriesRow = z.infer<typeof SeriesRowSchema>;

export interface ForecastRecord {
  readonly id: string;
  readonly storeId: string;
  readonly scope: ForecastScope;
  readonly scopeKey: string;
  readonly horizonDays: HorizonDays;
  readonly asOfDay: string;
  readonly model: ModelId | null;
  readonly modelVersion: string;
  readonly status: ForecastStatus;
  readonly p10: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly reasonCodes: readonly string[];
  readonly comparableUnits: number;
  readonly observedDays: number;
  readonly backtestOrigins: number;
  readonly wapeBps: number | null;
  readonly baselineWapeBps: number | null;
  readonly pinballMilli: number | null;
  readonly coverageBps: number | null;
  readonly biasBps: number | null;
  readonly generatedAtMs: number;
}

export interface RunSummary {
  readonly storeId: string;
  readonly asOfDay: string;
  readonly status: "completed" | "failed";
  readonly seriesTotal: number;
  readonly okCount: number;
  readonly insufficientCount: number;
  readonly suppressedCount: number;
  readonly servedModels: Readonly<Record<string, number>>;
  readonly meanWapeBps: number | null;
  readonly meanBaselineWapeBps: number | null;
  readonly meanPinballMilli: number | null;
  readonly meanCoverageBps: number | null;
  readonly meanBiasBps: number | null;
  readonly errorCode: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

export interface ForecastQuery {
  readonly scope?: ForecastScope;
  readonly scopeKey?: string;
  readonly horizonDays?: HorizonDays;
  readonly limit: number;
}

export interface LatestForecasts {
  readonly items: readonly ForecastRecord[];
  readonly hasMore: boolean;
  /** Highest as-of run for the store (completed or failed), or null before the first run. */
  readonly lastRun: RunSummary | null;
}

export interface ForecastStore {
  /** Replace-by-key upsert of day aggregates. Idempotent. */
  upsertSeries(rows: readonly SeriesRow[], nowMs: number): Promise<{ readonly upserted: number }>;
  /** Rows with `fromDay <= day <= asOfDay` for one store. */
  loadSeries(storeId: string, fromDay: string, asOfDay: string): Promise<readonly SeriesRow[]>;
  /** Stores that have series up to `asOfDay` and no completed run for it. Oldest data first, stable. */
  storesPendingRun(asOfDay: string, limit: number): Promise<readonly string[]>;
  /** Atomically stores the run and its forecasts. A completed run is never rewritten (returns inserted 0). */
  saveCompletedRun(run: RunSummary, forecasts: readonly ForecastRecord[]): Promise<{ readonly inserted: number }>;
  /** Records a failed attempt unless a completed run already exists for the day. */
  saveFailedRun(run: RunSummary): Promise<void>;
  latest(storeId: string, query: ForecastQuery): Promise<LatestForecasts>;
}

export class ForecastingDisabledError extends Error {
  constructor() {
    super("demand forecasting is disabled by its kill switch");
    this.name = "ForecastingDisabledError";
  }
}

export interface ForecastFlags {
  /** `kill.demand_forecasting` allowed. Unknown or unconfigured answers false (blocked). */
  enabled(): Promise<boolean>;
}
