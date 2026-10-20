import { instruments } from "../../../platform/telemetry";
import type { RollupMetricsPort } from "../domain/rollup-ports";

/** OpenTelemetry bindings for the rollup instruments registered in platform/telemetry/metrics.ts (track 6 block). */
export class TelemetryRollupMetrics implements RollupMetricsPort {
  reconciled(scope: string, mode: string, r: { mismatches: number; corrected: number; skipped: number; outcome: string }): void {
    const i = instruments();
    i.counter("outlet.analytics.rollup.reconciliations").add(1, { scope, mode, outcome: r.outcome });
    i.setGauge("outlet.analytics.rollup.mismatches", r.mismatches, { scope, mode });
  }
  defaultPartitionRows(table: string, rows: number): void {
    instruments().setGauge("outlet.analytics.rollup_default_partition_rows", rows, { table });
  }
}
