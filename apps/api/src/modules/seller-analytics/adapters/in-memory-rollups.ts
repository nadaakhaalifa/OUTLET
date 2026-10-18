/** DEVELOPMENT AND TEST FIXTURE: rollup rows, erased keys and repair for the in-memory store (same rules as the Kysely adapter). */
import { aggregateFacts, hourStart, keyString, type AggregatableFact, type RollupDelta, type RollupKey, type RollupRowState, type RollupScope } from "../domain/bridge";
import type {
  CasOutcome,
  DefaultPartitionRows,
  NewKeyOutcome,
  PartitionReport,
  ReconciliationRecord,
  RollupMaintenance,
  RollupSnapshot,
  RollupWindow,
} from "../domain/rollup-ports";

interface Row {
  key: RollupKey;
  value: bigint;
  held: bigint;
  version: bigint;
}

export class InMemoryRollups implements RollupMaintenance {
  readonly rows = new Map<string, Row>();
  readonly erasedKeys = new Set<string>();
  readonly reconciliations: ReconciliationRecord[] = [];
  /** Rows that a real partition job would have to move out of DEFAULT (hours beyond `partitionedUntilMs`). */
  partitionedUntilMs = Number.POSITIVE_INFINITY;
  watermarkMs: number | null = null;

  constructor(private readonly facts: () => readonly AggregatableFact[]) {}

  reset(): void {
    this.rows.clear();
    this.erasedKeys.clear();
    this.reconciliations.length = 0;
  }

  apply(deltas: readonly RollupDelta[]): void {
    for (const d of deltas) {
      const k = keyString(d.key);
      const cur = this.rows.get(k);
      const next = (cur?.value ?? 0n) + d.delta;
      this.rows.set(k, { key: d.key, value: next < 0n ? 0n : next, held: cur?.held ?? 0n, version: cur === undefined ? 0n : cur.version + 1n });
    }
  }

  value(scope: RollupScope, storeId: string | null, metric: string, hourMs: number): bigint {
    const r = this.rows.get(keyString({ scope, storeId, metric, hourUtcMs: hourStart(hourMs) }));
    return r === undefined ? 0n : r.value + r.held;
  }

  /** Test hook: the facts as aggregatable rows. */
  factSnapshot(): readonly AggregatableFact[] {
    return this.facts();
  }

  async snapshot(scope: RollupScope, w: RollupWindow): Promise<RollupSnapshot> {
    const rows = new Map<string, { key: RollupKey; state: RollupRowState }>();
    for (const [k, r] of this.rows) {
      if (r.key.scope !== scope || r.key.hourUtcMs < w.fromMs || r.key.hourUtcMs >= w.toMs) continue;
      if (scope === "platform" && r.key.metric !== "units_purchased" && r.key.metric !== "gmv_purchased_minor") continue;
      rows.set(k, { key: r.key, state: { value: r.value, held: r.held, version: r.version } });
    }
    return { facts: aggregateFacts(scope, this.facts(), w.fromMs, w.toMs), rows };
  }

  async casRepair(key: RollupKey, expected: bigint, readVersion: bigint): Promise<CasOutcome> {
    const k = keyString(key);
    const cur = this.rows.get(k);
    if (cur === undefined || cur.version !== readVersion) return "skipped_concurrent";
    const held = cur.held > expected ? expected : cur.held;
    this.rows.set(k, { key, value: expected - held, held, version: cur.version + 1n });
    return "corrected";
  }

  async repairNewKey(key: RollupKey): Promise<NewKeyOutcome> {
    const k = keyString(key);
    if (this.rows.has(k)) return "exists";
    const total = aggregateFacts(key.scope, this.facts(), key.hourUtcMs, key.hourUtcMs + 3_600_000).get(k)?.total ?? 0n;
    if (total === 0n) return "zero";
    this.rows.set(k, { key, value: total, held: 0n, version: 0n });
    return "inserted";
  }

  async record(rec: ReconciliationRecord): Promise<void> {
    this.reconciliations.push(rec);
  }

  async firstFactMs(): Promise<number | null> {
    const ms = this.facts().map((f) => f.occurredAtMs);
    return ms.length === 0 ? null : Math.min(...ms);
  }

  async maintainPartitions(_nowMs: number, _ahead: number, _retainMonths: number): Promise<PartitionReport> {
    return { created: 0, movedRows: 0, dropped: 0, defaultRows: 0 };
  }

  async defaultPartitionRows(): Promise<readonly DefaultPartitionRows[]> {
    return [
      { table: "seller_analytics_hourly", rows: 0 },
      { table: "platform_metrics_hourly", rows: 0 },
    ];
  }
}
