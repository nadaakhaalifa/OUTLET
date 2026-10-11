/** Public surface of the retention module (A2.3). */
export { RetentionModule, type RetentionModuleOptions } from "./retention.module";
export { RETENTION_PURGE, RETENTION_RUNNER } from "./adapters/tokens";
export { InMemoryPurgeExecutor, InMemoryRunStore, InMemoryBlobDelete, RecordingMetrics, LogRetentionMetrics } from "./adapters/in-memory";
export { KyselyPurgeExecutor, KyselyPurgeRunStore, UnconfiguredBlobDelete, type RetentionDb } from "./adapters/kysely-store";
export { PurgeRetentionJob, RunRetention, targetsOf, type RuleReport, type TargetReport } from "./application/purge";
export { TARGETS, DISPOSITIONS } from "./domain/catalog";
export type { BlobDeletePort, PurgeExecutor, PurgeRunStore, PurgeTarget, RetentionMetrics } from "./domain/ports";
