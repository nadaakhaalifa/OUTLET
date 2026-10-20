import type { RollupKey, RollupRowState, RollupScope } from "./bridge";

/** Half-open, hour-aligned window `[fromMs, toMs)` of UTC hour buckets. */
export interface RollupWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * One consistent view (REPEATABLE READ) of a window: the facts aggregation and the rollup rows are read in the
 * same snapshot. A consumer writes its facts and its rollup increments in one transaction, so in this view either
 * both or neither of an event are visible (M1, step 1).
 */
export interface RollupSnapshot {
  readonly facts: ReadonlyMap<string, { readonly key: RollupKey; readonly total: bigint }>;
  readonly rows: ReadonlyMap<string, { readonly key: RollupKey; readonly state: RollupRowState }>;
}

export type CasOutcome = "corrected" | "skipped_concurrent";
export type NewKeyOutcome = "inserted" | "exists" | "zero";

export interface ReconciliationRecord {
  readonly id: string;
  readonly scope: RollupScope;
  readonly window: RollupWindow;
  readonly checkedRows: number;
  readonly mismatches: number;
  readonly corrected: number;
  readonly skippedConcurrent: number;
  readonly outcome: "ok" | "corrected" | "error";
  readonly ranAtMs: number;
}

export interface PartitionReport {
  readonly created: number;
  readonly movedRows: number;
  readonly dropped: number;
  readonly defaultRows: number;
}

export interface DefaultPartitionRows {
  readonly table: string;
  readonly rows: number;
}

/**
 * Repair and housekeeping side of the rollups (the consumer side is `AnalyticsStore.ingest`). Every method runs
 * under the system role. Adapters: Kysely (Postgres) and in-memory (tests).
 */
export interface RollupMaintenance {
  snapshot(scope: RollupScope, w: RollupWindow): Promise<RollupSnapshot>;
  /** Existing key: set value to `expected` only while `version` still equals `readVersion` (compare-and-set, M1 step 2). */
  casRepair(key: RollupKey, expected: bigint, readVersion: bigint): Promise<CasOutcome>;
  /** New key: advisory lock, re-check, recompute from facts inside the lock, insert on conflict do nothing (M1 step 3). */
  repairNewKey(key: RollupKey): Promise<NewKeyOutcome>;
  record(rec: ReconciliationRecord): Promise<void>;
  /** Earliest fact time, or null when there are none (start of a backfill). */
  firstFactMs(): Promise<number | null>;
  /** Keeps at least `ahead` months of partitions, moves DEFAULT rows into new months, drops expired months. */
  maintainPartitions(nowMs: number, ahead: number, retainMonths: number): Promise<PartitionReport>;
  defaultPartitionRows(): Promise<readonly DefaultPartitionRows[]>;
}

export interface RollupMetricsPort {
  reconciled(scope: RollupScope, mode: string, r: { mismatches: number; corrected: number; skipped: number; outcome: string }): void;
  defaultPartitionRows(table: string, rows: number): void;
}

export const NOOP_ROLLUP_METRICS: RollupMetricsPort = { reconciled: () => undefined, defaultPartitionRows: () => undefined };
