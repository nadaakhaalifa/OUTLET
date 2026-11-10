import { createHash } from "node:crypto";
import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { Logger } from "@outlet/logger";
import type { WorkerMetrics } from "@outlet/observability";
import { errorCode } from "@outlet/outbox";
import { INTEGRITY_REQUESTED_EVENT } from "@outlet/payouts";
import { RETENTION_REQUESTED_EVENT } from "@outlet/privacy";
import { ROLLUP_REQUESTED_EVENT } from "@outlet/reporting";
import { LEDGER_INTEGRITY_KILL_SWITCH, RETENTION_KILL_SWITCH, ROLLUP_KILL_SWITCH } from "./jobs.js";
import type { KillRead } from "./jobs.js";
import { tryLeaderTx } from "./leader.js";

export type TickScope = "snapshots" | "sales" | "nightly" | "retention" | "ledger_integrity" | "ledger_integrity_full";
export type TickOutcome = "emitted" | "exists" | "not_leader" | "killed" | "failed";

export interface SchedulerMarket {
  readonly marketId: string;
  /** IANA zone of the market (markets-config), for the nightly window. */
  readonly timezone: string;
}

/** ADR-0015 cadence: snapshots every 60 s, sales every 5 min; nightly once per market-local date, in the 00:00-06:00 local window. */
export const SNAPSHOT_WINDOW_MS = 60_000;
export const SALES_WINDOW_MS = 300_000;
export const NIGHTLY_LAST_HOUR = 6;
/** Ledger integrity tick: once per market-local date, opens one hour after the rollup nightly (01:00-06:00 local) so the two scans never start together. */
export const INTEGRITY_FIRST_HOUR = 1;
/** Retention purge ticks: hourly in the 03:00-06:00 local window (after the nightly rollup and ledger integrity), so a backlog is drained over three runs a night. */
export const RETENTION_FIRST_HOUR = 3;
/** Weekly full chain re-verify (cursor reset to 0): Friday (market-local) in the same 01:00-06:00 window. It REPLACES that night's incremental tick (one run per date). */
export const INTEGRITY_FULL_WEEKDAY = "Fri";

export interface TickWindow {
  readonly scope: TickScope;
  /** Stable window identity, e.g. "sales:5894400" or "nightly:2026-11-10". */
  readonly key: string;
  /** Start of the window (ms since epoch); the timestamp part of the tick id. */
  readonly startMs: number;
}

const localParts = (at: Date, tz: string): { date: string; hour: number; weekday: string } => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year ?? ""}-${p.month ?? ""}-${p.day ?? ""}`, hour: Number(p.hour), weekday: p.weekday ?? "" };
};

/** The windows open at `at` for one market. Nightly is open only in the first hours of the local day (a restart at 15:00 never starts a 90-day re-run). */
export const windowsAt = (at: Date, tz: string): readonly TickWindow[] => {
  const ms = at.getTime();
  const snap = Math.floor(ms / SNAPSHOT_WINDOW_MS);
  const sales = Math.floor(ms / SALES_WINDOW_MS);
  const out: TickWindow[] = [
    { scope: "snapshots", key: `snapshots:${String(snap)}`, startMs: snap * SNAPSHOT_WINDOW_MS },
    { scope: "sales", key: `sales:${String(sales)}`, startMs: sales * SALES_WINDOW_MS },
  ];
  const local = localParts(at, tz);
  if (local.hour < NIGHTLY_LAST_HOUR) out.push({ scope: "nightly", key: `nightly:${local.date}`, startMs: Date.parse(`${local.date}T00:00:00Z`) });
  if (local.hour >= INTEGRITY_FIRST_HOUR && local.hour < NIGHTLY_LAST_HOUR) {
    const scope = local.weekday === INTEGRITY_FULL_WEEKDAY ? "ledger_integrity_full" : "ledger_integrity";
    out.push({ scope, key: `${scope}:${local.date}`, startMs: Date.parse(`${local.date}T00:00:00Z`) });
  }
  if (local.hour >= RETENTION_FIRST_HOUR && local.hour < NIGHTLY_LAST_HOUR) {
    out.push({ scope: "retention", key: `retention:${local.date}:${String(local.hour).padStart(2, "0")}`, startMs: Date.parse(`${local.date}T${String(local.hour).padStart(2, "0")}:00:00Z`) });
  }
  return out;
};

/**
 * Deterministic UUIDv7 per (market, window): 48-bit timestamp = window start, version 7, RFC 4122 variant, the rest from SHA-256 of the key. Two replicas
 * that both decide to emit insert the same primary key, so the database keeps exactly one tick per window (ON CONFLICT DO NOTHING).
 */
export const tickId = (marketId: string, w: TickWindow): string => {
  const h = createHash("sha256").update(`reporting.rollup|${marketId}|${w.key}`).digest("hex");
  const ts = Math.max(0, w.startMs).toString(16).padStart(12, "0").slice(-12);
  const variant = ((parseInt(h.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${h.slice(0, 3)}-${variant}${h.slice(4, 7)}-${h.slice(7, 19)}`;
};

export interface SchedulerOptions {
  readonly markets: readonly SchedulerMarket[];
  readonly worker: RoleSqlClient<"outlet_worker">;
  readonly kill: KillRead;
  readonly metrics: WorkerMetrics;
  readonly log: Logger;
  readonly now?: () => Date;
}

export interface TickResult {
  readonly marketId: string;
  readonly scope: TickScope;
  readonly outcome: TickOutcome;
}

/**
 * Emits `reporting.rollup_requested` ticks into the outbox (job outbox.relay, which may INSERT outbox_events: 0007). Two guards, so N replicas emit one
 * tick per window: a transaction-scoped advisory lock per (market, scope) elects one emitter at a time, and the deterministic tick id makes a second
 * insert for the same window a no-op even if the lock was missed (lock released between replicas, clock skew). A window that ended in emitted or
 * exists is remembered in memory and not retried; not_leader and failed are retried on the next turn.
 */
export class RollupScheduler {
  private readonly done = new Map<string, string>();
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<unknown> | undefined;
  private lastTickAt: Date | null = null;

  constructor(private readonly o: SchedulerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  start(intervalMs: number): void {
    if (this.timer !== undefined) return;
    const run = (): void => {
      this.inflight ??= this.tickOnce().finally(() => { this.inflight = undefined; });
    };
    run();
    this.timer = setInterval(run, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inflight;
  }

  lastBeat(): Date | null {
    return this.lastTickAt;
  }

  async tickOnce(): Promise<readonly TickResult[]> {
    const at = this.now();
    const out: TickResult[] = [];
    for (const m of this.o.markets) {
      const killed = await this.o.kill.isKilled(ROLLUP_KILL_SWITCH, { marketId: m.marketId });
      // The retention scope is gated by its own switch, read only inside its window (a deleting job: unreadable flag store = killed, fail closed).
      let retentionKilled: boolean | undefined;
      // Ledger integrity is money class (unreadable flag store = killed), read only inside its window.
      let integrityKilled: boolean | undefined;
      for (const w of windowsAt(at, m.timezone)) {
        const memo = `${m.marketId}|${w.scope}`;
        if (this.done.get(memo) === w.key) continue;
        if (w.scope === "ledger_integrity" || w.scope === "ledger_integrity_full") integrityKilled ??= await this.o.kill.isKilled(LEDGER_INTEGRITY_KILL_SWITCH, { marketId: m.marketId });
        if (w.scope === "retention") retentionKilled ??= await this.o.kill.isKilled(RETENTION_KILL_SWITCH, { marketId: m.marketId });
        const outcome = (w.scope === "retention" ? retentionKilled === true : w.scope === "ledger_integrity" || w.scope === "ledger_integrity_full" ? integrityKilled === true : killed) ? "killed" : await this.emit(m.marketId, w, at);
        if (outcome === "emitted" || outcome === "exists") this.done.set(memo, w.key);
        this.o.metrics.recordTick({ market_id: m.marketId, scope: w.scope, outcome });
        out.push({ marketId: m.marketId, scope: w.scope, outcome });
      }
    }
    this.lastTickAt = this.now();
    return out;
  }

  private async emit(marketId: string, w: TickWindow, at: Date): Promise<TickOutcome> {
    const id = tickId(marketId, w);
    try {
      return await withDbContext(this.o.worker, { kind: "worker", marketId, job: "outbox.relay" }, async (tx) => {
        if (!(await tryLeaderTx(tx, `worker.scheduler|${marketId}|${w.scope}`))) return "not_leader";
        const r = await tx.query(
          `INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, visibility, payload, occurred_at)
           VALUES ($1, $2, $6, $1, $3, 'internal', $4::jsonb, $5::timestamptz) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [id, marketId, w.scope === "retention" ? RETENTION_REQUESTED_EVENT : w.scope === "ledger_integrity" || w.scope === "ledger_integrity_full" ? INTEGRITY_REQUESTED_EVENT : ROLLUP_REQUESTED_EVENT, JSON.stringify({ scope: w.scope, window: w.key }), at.toISOString(), w.scope === "retention" ? "privacy_retention" : w.scope === "ledger_integrity" || w.scope === "ledger_integrity_full" ? "ledger_integrity" : "reporting_rollup"],
        );
        return r.rows.length === 1 ? "emitted" : "exists";
      });
    } catch (e) {
      this.o.log.error("worker: scheduler tick failed", { market: marketId, scope: w.scope, error: errorCode(e) });
      return "failed";
    }
  }
}
