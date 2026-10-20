import type { HourlyRow } from "./series";

export interface RollupFreshness {
  /** Consumer low watermark `analytics_rollup_watermarks.applied_through`; null = never ingested. */
  readonly asOfMs: number | null;
  /** Reconciliation epoch (bumps when a reconciliation corrects rows); part of the ETag. */
  readonly epoch: number;
}

/** Read side of the hourly rollups. Cheap `freshness` is called before the aggregate so an ETag hit skips the read. */
export interface PlatformRollupReader {
  freshness(): Promise<RollupFreshness>;
  /** Hour rows in `[fromMs, toMs)` for one platform rollup metric. */
  read(metric: string, fromMs: number, toMs: number): Promise<readonly HourlyRow[]>;
}

export class MetricsDependencyUnavailableError extends Error {
  constructor(what: string) {
    super(`platform metrics dependency unavailable: ${what}`);
    this.name = "MetricsDependencyUnavailableError";
  }
}

/** A metric whose source is not configured in this deployment: never answered with zeros (503 metric_source_unconfigured). */
export class MetricSourceUnconfiguredError extends Error {
  constructor(readonly metricId: string) {
    super(`metric source unconfigured: ${metricId}`);
    this.name = "MetricSourceUnconfiguredError";
  }
}
