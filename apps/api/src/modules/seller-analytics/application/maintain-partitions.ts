import { NOOP_ROLLUP_METRICS, type RollupMaintenance, type RollupMetricsPort } from "../domain/rollup-ports";

/** Keep six months (the migration creates the same) so the spec's "at least 3 months ahead" always holds. */
export const PARTITIONS_AHEAD = 5;
/** Rollups follow the 25-month analytics rule (VR-DASH-04); whole monthly partitions are dropped. */
export const ROLLUP_RETAIN_MONTHS = 25;

/**
 * Worker `analytics.maintain-rollup-partitions` (M2): creates missing months, moves rows out of DEFAULT, drops
 * expired months and exports `outlet.analytics.rollup_default_partition_rows{table}` (alert: > 0 for 10m).
 */
export class MaintainRollupPartitions {
  constructor(
    private readonly rollups: RollupMaintenance,
    private readonly clock: { nowMs(): number },
    private readonly metrics: RollupMetricsPort = NOOP_ROLLUP_METRICS,
  ) {}

  async execute(): Promise<{ created: number; movedRows: number; dropped: number; defaultRows: number }> {
    const r = await this.rollups.maintainPartitions(this.clock.nowMs(), PARTITIONS_AHEAD, ROLLUP_RETAIN_MONTHS);
    await this.exportGauge();
    return r;
  }

  /** Cheap gauge refresh (also called on its own by a short-interval job and by the API at collection). */
  async exportGauge(): Promise<{ defaultRows: number }> {
    let total = 0;
    for (const t of await this.rollups.defaultPartitionRows()) {
      this.metrics.defaultPartitionRows(t.table, t.rows);
      total += t.rows;
    }
    return { defaultRows: total };
  }
}
