import type { RetentionPeriod } from "./bridge";

export type PurgeAction = "delete" | "nullify";

/**
 * One purge handler: a single table, one age expression, optional guards. All SQL fragments are constants
 * in the catalog (never user input); the catalog test checks their shape. Alias `t` is the target table.
 */
export interface PurgeTarget {
  readonly id: string;
  readonly ruleId: string;
  readonly table: string;
  readonly action: PurgeAction;
  /** SQL timestamptz expression; a row is eligible when it is strictly older than the cutoff. */
  readonly age: string;
  /** Extra eligibility predicate (terminal states, foreign-key guards, no open dispute). */
  readonly where?: string;
  /** SQL uuid expression naming the user whose legal hold protects the row (alias t). */
  readonly holdUser?: string;
  /** Child tables deleted first in the same batch, matched on `fk = t.id`. Needs `pk: "id"`. */
  readonly dependents?: readonly { readonly table: string; readonly fk: string }[];
  /** "ctid" for tables without a single id column. */
  readonly pk: "ctid" | "id";
  /** Columns set to NULL by a nullify action. */
  readonly nullify?: readonly string[];
  /** Column holding an object-store reference deleted before the row (needs pk "id"). */
  readonly blobColumn?: string;
  /** Used only when the rule has no fixed period (event-driven rules): how long after the trigger the row goes. */
  readonly grace?: RetentionPeriod;
}

export interface PurgeCount {
  readonly eligible: number;
  readonly held: number;
  readonly oldestEligibleMs: number | null;
}

export interface PurgeExecutor {
  /** Read-only: what a purge at `cutoffMs` would touch. Never mutates. */
  count(target: PurgeTarget, cutoffMs: number): Promise<PurgeCount>;
  /** Purges at most `limit` eligible, unheld rows in one short transaction. Returns rows affected. */
  purgeBatch(target: PurgeTarget, cutoffMs: number, limit: number): Promise<number>;
}

/** Deletes object-store payloads (return photos). Must be idempotent: deleting a missing object succeeds. */
export interface BlobDeletePort {
  deleteMany(refs: readonly string[]): Promise<void>;
}

export type RunStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

export interface PurgeRunRecord {
  readonly id: string;
  readonly ruleId: string;
  readonly targetId: string;
  readonly dryRun: boolean;
  readonly cutoffMs: number;
  readonly startedMs: number;
  readonly finishedMs: number | null;
  readonly status: RunStatus;
  readonly rowsPurged: number;
  readonly rowsEligible: number | null;
  readonly rowsHeld: number;
  readonly batches: number;
  readonly oldestEligibleMs: number | null;
  readonly errorCode: string | null;
}

/** Audit ledger of purge runs (counts only, never row content). */
export interface PurgeRunStore {
  start(r: Pick<PurgeRunRecord, "id" | "ruleId" | "targetId" | "dryRun" | "cutoffMs" | "startedMs">): Promise<void>;
  finish(id: string, f: Pick<PurgeRunRecord, "finishedMs" | "status" | "rowsPurged" | "rowsEligible" | "rowsHeld" | "batches" | "oldestEligibleMs" | "errorCode">): Promise<void>;
  list(ruleId?: string): Promise<readonly PurgeRunRecord[]>;
}

export interface RetentionMetrics {
  counter(name: string, value: number, labels: Readonly<Record<string, string>>): void;
  gauge(name: string, value: number, labels: Readonly<Record<string, string>>): void;
}
