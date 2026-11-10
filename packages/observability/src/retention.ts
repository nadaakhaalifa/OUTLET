import { metrics } from "@opentelemetry/api";
import type { Meter } from "@opentelemetry/api";

/** Instruments of the nightly retention purge (privacy.retention, ADR-0016). Labels: table, market and a closed reason code only. */
export interface RetentionMetrics {
  /** `retention_rows_purged{table}`: rows deleted. */
  purged(table: string, marketId: string, rows: number): void;
  /** `retention_rows_due{table}`: rows past the cutoff seen by a dry run (nothing deleted). */
  due(table: string, marketId: string, rows: number): void;
  /** `retention_skipped{table}`: the table was not purged this run (inventory unreadable, rule missing or changed, error). */
  skipped(table: string, marketId: string, reason: string): void;
}

export const createRetentionMetrics = (meter: Meter = metrics.getMeter("@outlet/observability")): RetentionMetrics => {
  const purged = meter.createCounter("retention_rows_purged", { description: "Rows deleted by the nightly retention purge" });
  const skipped = meter.createCounter("retention_skipped", { description: "Retention purges skipped (fail closed)" });
  const due = new Map<string, { table: string; market_id: string; rows: number }>();
  meter.createObservableGauge("retention_rows_due", { description: "Rows past their retention cutoff seen by the last dry run" }).addCallback((r) => {
    for (const v of due.values()) r.observe(v.rows, { table: v.table, market_id: v.market_id });
  });
  return {
    purged: (table, market_id, rows) => {
      purged.add(rows, { table, market_id });
    },
    due: (table, market_id, rows) => {
      due.set(`${market_id}|${table}`, { table, market_id, rows });
    },
    skipped: (table, market_id, reason) => {
      skipped.add(1, { table, market_id, reason });
    },
  };
};
