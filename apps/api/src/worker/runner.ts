import type { Logger } from "@outlet/logger";
import { withSpan } from "@outlet/observability";
import type { WorkerMetrics } from "@outlet/observability";
import { OutboxDispatchRelay, errorCode } from "@outlet/outbox";
import type { OutboxEvent, SqlClient } from "@outlet/outbox";
import { RELAY_KILL_SWITCH } from "./jobs.js";
import type { KillRead, WorkerJobDef } from "./jobs.js";

export interface RunnerOptions {
  readonly marketId: string;
  /** outlet_worker bound to { kind: worker, job: outbox.relay, marketId } (contextClient). */
  readonly relayDb: SqlClient;
  readonly jobs: readonly WorkerJobDef[];
  readonly kill: KillRead;
  readonly metrics: WorkerMetrics;
  readonly log: Logger;
  readonly pollMs: number;
  readonly pollMaxMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly handlerTimeoutMs: number;
  readonly lagMs: number;
  readonly now?: () => Date;
}

export interface ConsumerStatus {
  readonly job: string;
  readonly killed: boolean;
  readonly pending: number;
  /** Age in seconds of the oldest unpublished event this job consumes; 0 when none. null until the first lag read. */
  readonly lagSeconds: number | null;
}

export interface RunnerStatus {
  readonly marketId: string;
  readonly relayKilled: boolean;
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly consumers: readonly ConsumerStatus[];
}

class HandlerTimeout extends Error {
  constructor() {
    super("handler timed out");
    this.name = "HandlerTimeout";
  }
}

/**
 * One market's relay loop (ADR-0016): claim a batch (kill-switched job types excluded), dispatch each event to its job's handler (span, timeout,
 * metrics), ack or back off. Idle polls double the sleep up to pollMaxMs; a full batch polls again at once. Consumer lag is refreshed every lagMs.
 * stop() asks the loop to finish: the event in flight completes (bounded by the caller's deadline), the rest of the batch is released.
 */
export class MarketRunner {
  private readonly relay: OutboxDispatchRelay;
  private readonly byType = new Map<string, { job: WorkerJobDef; handler: (e: OutboxEvent) => Promise<string> }>();
  private readonly now: () => Date;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastPollAt: Date | null = null;
  private lastError: string | null = null;
  private relayKilled = false;
  private killed = new Set<string>();
  private lag = new Map<string, { pending: number; lagSeconds: number }>();
  private lastLagAt = 0;

  constructor(private readonly o: RunnerOptions) {
    this.now = o.now ?? (() => new Date());
    for (const job of o.jobs) for (const [type, handler] of job.handlers) this.byType.set(type, { job, handler: (e) => handler({ id: e.id, type: e.type, payload: e.payload }) });
    this.relay = new OutboxDispatchRelay({ db: o.relayDb, dispatch: (e) => this.dispatch(e), batchSize: o.batchSize, maxAttempts: o.maxAttempts, leaseMs: o.leaseMs, now: this.now });
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Resolves true when the loop finished before deadlineMs, false when it was still in a handler (its lease then expires and it is redelivered). */
  async stop(deadlineMs: number): Promise<boolean> {
    this.stopping = true;
    this.wake?.();
    if (this.loop === undefined) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((r) => (timer = setTimeout(() => { r(false); }, deadlineMs)));
    const done = this.loop.then(() => true as const);
    const out = await Promise.race([done, timedOut]);
    clearTimeout(timer);
    return out;
  }

  /** Heartbeat for liveness: the loop records a poll (or a skipped poll when killed) on every turn. */
  lastBeat(): Date | null {
    return this.lastPollAt;
  }

  status(): RunnerStatus {
    return {
      marketId: this.o.marketId,
      relayKilled: this.relayKilled,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastError: this.lastError,
      consumers: this.o.jobs.map((j) => {
        const l = this.lag.get(j.job);
        return { job: j.job, killed: this.killed.has(j.job), pending: l?.pending ?? 0, lagSeconds: l?.lagSeconds ?? null };
      }),
    };
  }

  /** One loop turn; returns how long to sleep before the next. Exposed for tests. */
  async turn(idleMs: number): Promise<number> {
    try {
      this.relayKilled = await this.o.kill.isKilled(RELAY_KILL_SWITCH, { marketId: this.o.marketId });
      const killed = new Set<string>();
      for (const j of this.o.jobs) if (await this.o.kill.isKilled(j.killSwitch, { marketId: this.o.marketId })) killed.add(j.job);
      this.killed = killed;
      await this.refreshLag();
      if (this.relayKilled) {
        this.lastPollAt = this.now();
        return this.o.pollMaxMs;
      }
      const excludeTypes = this.o.jobs.filter((j) => killed.has(j.job)).flatMap((j) => [...j.handlers.keys()]);
      const r = await this.relay.runOnce({ excludeTypes, shouldStop: () => this.stopping });
      this.lastPollAt = this.now();
      this.lastError = null;
      this.o.metrics.recordPoll({ market_id: this.o.marketId, claimed: r.claimed, failed: r.failed, dead_lettered: r.deadLettered });
      if (r.deadLettered > 0) this.o.log.error("worker: events dead-lettered", { market: this.o.marketId, count: r.deadLettered });
      if (r.claimed >= this.o.batchSize && r.failed === 0) return 0;
      return r.claimed > 0 && r.failed === 0 ? this.o.pollMs : Math.min(Math.max(idleMs * 2, this.o.pollMs), this.o.pollMaxMs);
    } catch (e) {
      this.lastPollAt = this.now();
      this.lastError = errorCode(e);
      this.o.log.error("worker: relay poll failed", { market: this.o.marketId, error: this.lastError });
      return this.o.pollMaxMs;
    }
  }

  private isStopping(): boolean {
    return this.stopping;
  }

  private async run(): Promise<void> {
    let sleep = 0;
    while (!this.isStopping()) {
      sleep = await this.turn(sleep);
      if (this.isStopping()) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this.wake = undefined; resolve(); }, sleep);
        this.wake = () => { clearTimeout(t); this.wake = undefined; resolve(); };
      });
    }
  }

  private async refreshLag(): Promise<void> {
    const at = this.now().getTime();
    if (at - this.lastLagAt < this.o.lagMs && this.lastLagAt !== 0) return;
    this.lastLagAt = at;
    const pending = await this.relay.pending([...this.byType.keys()]);
    const next = new Map<string, { pending: number; lagSeconds: number }>();
    for (const j of this.o.jobs) next.set(j.job, { pending: 0, lagSeconds: 0 });
    for (const p of pending) {
      const owner = this.byType.get(p.type);
      if (owner === undefined) continue;
      const cur = next.get(owner.job.job) ?? { pending: 0, lagSeconds: 0 };
      next.set(owner.job.job, { pending: cur.pending + p.pending, lagSeconds: Math.max(cur.lagSeconds, Math.max(0, Math.round((at - p.oldestOccurredAt.getTime()) / 1000))) });
    }
    this.lag = next;
    for (const [job, v] of next) this.o.metrics.setLag(job, this.o.marketId, v.lagSeconds, v.pending);
  }

  private async dispatch(e: OutboxEvent): Promise<void> {
    const entry = this.byType.get(e.type);
    if (entry === undefined) {
      // No in-process consumer for this type (e.g. ops.attention_opened, shipment.cancelled): acked as published, like a bus with no subscriber.
      this.o.metrics.recordHandled(0, { job: "none", event_type: e.type, outcome: "unhandled", market_id: this.o.marketId });
      return;
    }
    const job = entry.job.job;
    const started = performance.now();
    let outcome = "failed";
    try {
      outcome = await withSpan("worker.handle", { "worker.job": job, "event.type": e.type, "event.id": e.id, market_id: this.o.marketId }, () => this.withTimeout(entry.handler(e)));
    } catch (err) {
      this.o.log.warn("worker: handler failed, will retry", { market: this.o.marketId, job, event_id: e.id, event_type: e.type, error: errorCode(err) });
      throw err;
    } finally {
      this.o.metrics.recordHandled((performance.now() - started) / 1000, { job, event_type: e.type, outcome, market_id: this.o.marketId });
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => (timer = setTimeout(() => { reject(new HandlerTimeout()); }, this.o.handlerTimeoutMs)));
    return Promise.race([p, t]).finally(() => { clearTimeout(timer); });
  }
}
