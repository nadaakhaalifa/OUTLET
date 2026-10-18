/** Public surface of the platform-metrics module (A2.3). Other code imports only this file. */
export { PlatformMetricsModule, type PlatformMetricsOverrides } from "./platform-metrics.module";
export { PLATFORM_ROLLUP_READER } from "./adapters/tokens";
export { InMemoryPlatformRollups } from "./adapters/in-memory";
export { KyselyPlatformRollups, type PlatformMetricsDb } from "./adapters/kysely-source";
export type { ElevationReader } from "./adapters/metrics.controller";
export type { PlatformRollupReader, RollupFreshness } from "./domain/ports";
export { MetricSourceUnconfiguredError, MetricsDependencyUnavailableError } from "./domain/ports";
// Shared series core: seller analytics builds its series with the same code (one bucketing, one rounding point).
export * from "./domain/buckets";
export * from "./domain/series";
export { planSeries, readSeries, seriesEtag, type Compare, type HourlySource, type PlannedSeries, type SeriesRequest } from "./application/read-series";
export { ADMIN_METRICS, adminMetric, type AdminMetricAccess, type AdminMetricDef } from "./domain/registry";
