import { diffRollups, hourStart, type RollupScope } from "../domain/bridge";
import { NOOP_ROLLUP_METRICS, type ReconciliationRecord, type RollupMaintenance, type RollupMetricsPort, type RollupWindow } from "../domain/rollup-ports";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** `analytics.reconcile-rollups`: every hour for the last 48 hours, nightly (04:00 Cairo) for the last 35 days. */
export const HOURLY_LOOKBACK_MS = 48 * HOUR_MS;
export const NIGHTLY_LOOKBACK_MS = 35 * DAY_MS;
const BACKFILL_CHUNK_MS = 7 * DAY_MS;

export type ReconcileMode = "hourly" | "nightly" | "backfill";

export interface ScopeReport {
  readonly scope: RollupScope;
  readonly checkedRows: number;
  readonly mismatches: number;
  readonly corrected: number;
  readonly skippedConcurrent: number;
}

export interface ReconcileReport {
  readonly runs: number;
  readonly checkedRows: number;
  readonly mismatches: number;
  readonly corrected: number;
  readonly skippedConcurrent: number;
}

export interface ReconcileDeps {
  readonly rollups: RollupMaintenance;
  readonly clock: { nowMs(): number };
  readonly ids: { uuidV7(): string };
  readonly metrics?: RollupMetricsPort;
}

/**
 * Repairs rollup drift from facts (spec section 6, "Reconciliation job"; M1). One consistent snapshot per window and
 * scope, then per mismatch: existing key -> version compare-and-set (a consumer touch since the snapshot wins and is
 * counted as skipped_concurrent, rechecked next run); new key -> advisory lock, re-check, recompute inside the lock.
 * The comparison is facts against `value + held_value`.
 */
export class ReconcileRollups {
  private readonly metrics: RollupMetricsPort;
  constructor(private readonly d: ReconcileDeps) {
    this.metrics = d.metrics ?? NOOP_ROLLUP_METRICS;
  }

  hourly(): Promise<ReconcileReport> {
    return this.window("hourly", this.d.clock.nowMs() - HOURLY_LOOKBACK_MS, this.d.clock.nowMs());
  }

  nightly(): Promise<ReconcileReport> {
    return this.window("nightly", this.d.clock.nowMs() - NIGHTLY_LOOKBACK_MS, this.d.clock.nowMs());
  }

  /**
   * First run over the whole retained range, before any series flag is allowed: creates rollups for existing
   * facts. Chunked (7 days) so each snapshot stays bounded.
   */
  async backfill(): Promise<ReconcileReport> {
    const first = await this.d.rollups.firstFactMs();
    const now = this.d.clock.nowMs();
    if (first === null) return { runs: 0, checkedRows: 0, mismatches: 0, corrected: 0, skippedConcurrent: 0 };
    let total: ReconcileReport = { runs: 0, checkedRows: 0, mismatches: 0, corrected: 0, skippedConcurrent: 0 };
    for (let from = hourStart(first); from <= now; from += BACKFILL_CHUNK_MS) {
      const to = Math.min(from + BACKFILL_CHUNK_MS, hourStart(now) + HOUR_MS);
      total = add(total, await this.window("backfill", from, to - 1));
    }
    return total;
  }

  private async window(mode: ReconcileMode, fromMs: number, toMs: number): Promise<ReconcileReport> {
    const w: RollupWindow = { fromMs: hourStart(fromMs), toMs: hourStart(toMs) + HOUR_MS };
    let total: ReconcileReport = { runs: 0, checkedRows: 0, mismatches: 0, corrected: 0, skippedConcurrent: 0 };
    for (const scope of ["seller", "platform"] as const) total = add(total, await this.scope(mode, scope, w));
    return total;
  }

  private async scope(mode: ReconcileMode, scope: RollupScope, w: RollupWindow): Promise<ReconcileReport> {
    let rep: ScopeReport = { scope, checkedRows: 0, mismatches: 0, corrected: 0, skippedConcurrent: 0 };
    let failure: unknown;
    try {
      const snap = await this.d.rollups.snapshot(scope, w);
      const diffs = diffRollups(snap.facts, snap.rows);
      const keys = new Set([...snap.facts.keys(), ...snap.rows.keys()]);
      let corrected = 0;
      let skipped = 0;
      for (const diff of diffs) {
        if (diff.kind === "existing") {
          const o = await this.d.rollups.casRepair(diff.key, diff.expected, diff.actual.version);
          if (o === "corrected") corrected += 1;
          else skipped += 1;
        } else {
          const o = await this.d.rollups.repairNewKey(diff.key);
          if (o === "inserted") corrected += 1;
          else skipped += 1;
        }
      }
      rep = { scope, checkedRows: keys.size, mismatches: diffs.length, corrected, skippedConcurrent: skipped };
    } catch (e) {
      failure = e;
    }
    const outcome: ReconciliationRecord["outcome"] = failure !== undefined ? "error" : rep.mismatches === 0 ? "ok" : "corrected";
    await this.d.rollups.record({
      id: this.d.ids.uuidV7(),
      scope,
      window: w,
      checkedRows: rep.checkedRows,
      mismatches: rep.mismatches,
      corrected: rep.corrected,
      skippedConcurrent: rep.skippedConcurrent,
      outcome,
      ranAtMs: this.d.clock.nowMs(),
    });
    this.metrics.reconciled(scope, mode, { mismatches: rep.mismatches, corrected: rep.corrected, skipped: rep.skippedConcurrent, outcome });
    if (failure !== undefined) throw failure;
    return { runs: 1, checkedRows: rep.checkedRows, mismatches: rep.mismatches, corrected: rep.corrected, skippedConcurrent: rep.skippedConcurrent };
  }
}

const add = (a: ReconcileReport, b: ReconcileReport): ReconcileReport => ({
  runs: a.runs + b.runs,
  checkedRows: a.checkedRows + b.checkedRows,
  mismatches: a.mismatches + b.mismatches,
  corrected: a.corrected + b.corrected,
  skippedConcurrent: a.skippedConcurrent + b.skippedConcurrent,
});

