import { readFile } from "node:fs/promises";
import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { Logger } from "@outlet/logger";
import { createLogger } from "@outlet/logger";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_INVENTORY_PATH } from "./inventory.js";

/** Scheduler tick (`privacy.retention_requested`, worker job `privacy.retention`). */
export const RETENTION_REQUESTED_EVENT = "privacy.retention_requested";
export const RETENTION_CONSUMER = "privacy.retention";
export const RETENTION_BATCH_ROWS = 5000;
export const RETENTION_DEFAULT_BUDGET_MS = 8000;

/**
 * One purgeable table. `rule` is the key in data_inventory.yaml `retention_rules`, `period` the interval the runner (and the RLS policy of migration 0040)
 * applies, and `ruleText` the phrase that rule's text must still contain: when somebody edits the rule in the inventory the table is skipped (fail
 * closed) until this spec and the migration policy are reviewed together. `column` is compared to `now - period` (`cast` for a date column).
 */
export interface PurgeSpec {
  readonly table: string;
  readonly rule: string;
  readonly period: string;
  readonly ruleText: RegExp;
  readonly column: string;
  readonly cast?: "date";
  /** Static extra predicate (no input), mirrored by the migration policy. */
  readonly where?: string;
  /** True when the table has a market_id column (the delete is pinned to the market of the run). */
  readonly marketPinned: boolean;
}

export const PURGE_SPECS: readonly PurgeSpec[] = [
  { table: "outbox_events", rule: "outbox_60d", period: "60 days", ruleText: /60 days/, column: "published_at", marketPinned: true },
  { table: "dlq_messages", rule: "dlq_60d", period: "60 days", ruleText: /60 days/, column: "resolved_at", where: "status IN ('replayed', 'discarded')", marketPinned: false },
  { table: "inbox_processed", rule: "dedup_60d", period: "60 days", ruleText: /60 days/, column: "processed_at", marketPinned: false },
  { table: "attention_items", rule: "ops_attention_24m", period: "24 months", ruleText: /24 months/, column: "created_at", where: "status = 'RESOLVED'", marketPinned: true },
  { table: "notification_log", rule: "notification_12m", period: "12 months", ruleText: /12 months/, column: "created_at", where: "status <> 'queued'", marketPinned: true },
  { table: "market_sales_daily", rule: "sales_rollup_25m", period: "25 months", ruleText: /25 months/, column: "day", cast: "date", marketPinned: true },
  { table: "store_sales_daily", rule: "sales_rollup_25m", period: "25 months", ruleText: /25 months/, column: "day", cast: "date", marketPinned: true },
];

/**
 * Tables the inventory marks as retained on purpose or overwritten in place: nothing is purged, listed so the decision is visible (and tested).
 * admin_dashboard_snapshots: rule dashboard_snapshot_overwrite (one row per market and tile, overwritten by reporting.rollup).
 */
export const NOT_PURGED: readonly { readonly table: string; readonly rule: string }[] = [{ table: "admin_dashboard_snapshots", rule: "dashboard_snapshot_overwrite" }];

export interface RetentionMetricsPort {
  /** Rows actually deleted (`retention_rows_purged{table}`). */
  purged(table: string, marketId: string, rows: number): void;
  /** Rows past the cutoff counted in dry-run mode (`retention_rows_due{table}`). */
  due(table: string, marketId: string, rows: number): void;
  /** A table that was not purged this run (`retention_skipped{table}`); reason is a closed code, never a message. */
  skipped(table: string, marketId: string, reason: SkipReason): void;
}
export type SkipReason = "inventory_unreadable" | "rule_missing" | "rule_changed" | "table_missing" | "error";

export interface TableOutcome {
  readonly table: string;
  readonly rows: number;
  readonly mode: "purged" | "dry_run" | "skipped";
  readonly reason?: SkipReason;
  /** True when the time budget ended the loop before the table was drained (the next window continues). */
  readonly partial?: boolean;
}

const inventoryRulesSchema = z.object({
  retention_rules: z.record(z.string(), z.object({ rule: z.string() })),
  tables: z.array(z.object({ name: z.string() })),
});
export interface InventoryRules {
  readonly rules: ReadonlyMap<string, string>;
  readonly tables: ReadonlySet<string>;
}

/** Reads the retention rules and table names of data_inventory.yaml. Throws when the file is missing or malformed (the caller fails closed). */
export const loadRetentionRules = async (path: string = DEFAULT_INVENTORY_PATH): Promise<InventoryRules> => {
  const doc = inventoryRulesSchema.parse(parse(await readFile(path, "utf8")));
  return { rules: new Map(Object.entries(doc.retention_rules).map(([k, v]) => [k, v.rule])), tables: new Set(doc.tables.map((t) => t.name)) };
};

const PERIOD = /^\d+ (days|months)$/;
const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Cutoff expression: the period comes from the static spec, only `now` is bound ($1). */
export const cutoffSql = (s: PurgeSpec): string => {
  if (!PERIOD.test(s.period) || !IDENT.test(s.table) || !IDENT.test(s.column)) throw new Error("invalid purge spec");
  return s.cast === "date" ? `(${s.column} < ($1::timestamptz - interval '${s.period}')::date)` : `(${s.column} < $1::timestamptz - interval '${s.period}')`;
};

const conditions = (s: PurgeSpec): string => [cutoffSql(s), ...(s.where === undefined ? [] : [s.where]), ...(s.marketPinned ? ["market_id = $2"] : [])].join(" AND ");
const params = (s: PurgeSpec, now: Date, marketId: string): unknown[] => (s.marketPinned ? [now, marketId] : [now]);

export interface RetentionRunnerOptions {
  readonly client: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  /** True = count only, delete nothing. Default true: deletion starts only when the owner sets WORKER_RETENTION_DRY_RUN=false. */
  readonly dryRun?: boolean;
  readonly metrics?: RetentionMetricsPort;
  readonly log?: Logger;
  readonly now?: () => Date;
  readonly inventoryPath?: string;
  /** Total time for one run (all tables); the loop stops between batches once it is spent. */
  readonly budgetMs?: number;
  readonly batchRows?: number;
  /** Inventory loader, injectable for tests. */
  readonly loadRules?: () => Promise<InventoryRules>;
}

/**
 * Nightly retention purge of one market (ADR-0016). Per table: verify the inventory still carries the rule the spec was written for (else skip, fail
 * closed), then delete in batches of at most 5000 rows, each batch its own short transaction under { worker, privacy.retention, market }, until a batch
 * comes back short or the time budget is spent. The RLS policies of migration 0040 repeat the cutoff, so this code cannot delete a younger row even if it
 * is wrong. Idempotent (re-running deletes nothing new). Logs and metrics carry table names and counts only.
 */
export class RetentionRunner {
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly dryRun: boolean;
  private readonly batchRows: number;
  private readonly budgetMs: number;

  constructor(private readonly o: RetentionRunnerOptions) {
    this.log = o.log ?? createLogger();
    this.now = o.now ?? (() => new Date());
    this.dryRun = o.dryRun ?? true;
    this.batchRows = Math.min(o.batchRows ?? RETENTION_BATCH_ROWS, RETENTION_BATCH_ROWS);
    this.budgetMs = o.budgetMs ?? RETENTION_DEFAULT_BUDGET_MS;
  }

  async run(): Promise<readonly TableOutcome[]> {
    const m = this.o.marketId;
    const started = this.now().getTime();
    let inv: InventoryRules | null = null;
    try {
      inv = await (this.o.loadRules ?? (() => loadRetentionRules(this.o.inventoryPath)))();
    } catch {
      this.log.error("privacy.retention: data_inventory.yaml unreadable, nothing purged", { market: m });
    }
    const out: TableOutcome[] = [];
    for (const s of PURGE_SPECS) {
      const reason = inv === null ? "inventory_unreadable" : this.check(s, inv);
      if (reason !== null) {
        if (inv !== null) this.log.error("privacy.retention: table skipped", { market: m, table: s.table, reason });
        this.o.metrics?.skipped(s.table, m, reason);
        out.push({ table: s.table, rows: 0, mode: "skipped", reason });
        continue;
      }
      out.push(await this.purge(s, started));
    }
    this.log.info("privacy.retention: run finished", {
      market: m, dry_run: this.dryRun, tables: out.map((x) => ({ table: x.table, mode: x.mode, rows: x.rows, ...(x.partial === true ? { partial: true } : {}), ...(x.reason === undefined ? {} : { reason: x.reason }) })),
    });
    return out;
  }

  private check(s: PurgeSpec, inv: InventoryRules): SkipReason | null {
    const text = inv.rules.get(s.rule);
    if (text === undefined || !inv.tables.has(s.table)) return "rule_missing";
    return s.ruleText.test(text) ? null : "rule_changed";
  }

  private async purge(s: PurgeSpec, started: number): Promise<TableOutcome> {
    const m = this.o.marketId;
    const ctx = { kind: "worker", marketId: m, job: "privacy.retention" } as const;
    const sql = `DELETE FROM ${s.table} WHERE ctid IN (SELECT ctid FROM ${s.table} WHERE ${conditions(s)} ORDER BY ${s.column} LIMIT ${String(this.batchRows)}) RETURNING 1`;
    try {
      if (this.dryRun) {
        const r = await withDbContext(this.o.client, ctx, (tx: Queryable) => tx.query<{ n: number | string }>(`SELECT count(*) AS n FROM ${s.table} WHERE ${conditions(s)}`, params(s, this.now(), m)));
        const rows = Number(r.rows[0]?.n ?? 0);
        this.o.metrics?.due(s.table, m, rows);
        return { table: s.table, rows, mode: "dry_run" };
      }
      let total = 0;
      for (;;) {
        const r = await withDbContext(this.o.client, ctx, (tx: Queryable) => tx.query(sql, params(s, this.now(), m)));
        const n = r.rows.length;
        total += n;
        if (n > 0) this.o.metrics?.purged(s.table, m, n);
        if (n < this.batchRows) return { table: s.table, rows: total, mode: "purged" };
        if (this.now().getTime() - started >= this.budgetMs) return { table: s.table, rows: total, mode: "purged", partial: true };
      }
    } catch (e) {
      this.log.error("privacy.retention: table failed", { market: m, table: s.table, error: e instanceof Error ? e.name : "unknown" });
      this.o.metrics?.skipped(s.table, m, "error");
      return { table: s.table, rows: 0, mode: "skipped", reason: "error" };
    }
  }
}

export interface RetentionEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
const RetentionTick = z.object({ scope: z.literal("retention"), window: z.string().min(1).max(64) });

/**
 * Inbox consumer of `privacy.retention_requested` (scheduler tick), worker job `privacy.retention`. The purge is idempotent, so the inbox row is written
 * AFTER it: a crash mid-purge redelivers the tick and the next run continues; a delivered tick is never run twice. A malformed or foreign payload is
 * parked (inbox row + error log) so it cannot loop to the DLQ.
 */
export class RetentionConsumer {
  private readonly log: Logger;
  constructor(private readonly client: RoleSqlClient<"outlet_worker">, private readonly marketId: string, private readonly runner: RetentionRunner, log?: Logger) {
    this.log = log ?? createLogger();
  }

  async handle(event: RetentionEventIn): Promise<"processed" | "duplicate"> {
    const seen = await this.tx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [RETENTION_CONSUMER, event.id]));
    if (seen.rows.length > 0) return "duplicate";
    const tick = event.type === RETENTION_REQUESTED_EVENT ? RetentionTick.safeParse(event.payload) : null;
    if (tick?.success === true) await this.runner.run();
    else this.log.error("privacy.retention: event parked, not run", { event_id: event.id, type: event.type, reason: tick === null ? "unknown_type" : "invalid_payload" });
    return this.tx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [RETENTION_CONSUMER, event.id]);
      return ins.rows.length === 0 ? "duplicate" : "processed";
    });
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "privacy.retention" }, fn);
  }
}
