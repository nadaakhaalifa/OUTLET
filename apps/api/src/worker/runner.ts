import type { Logger } from "@outlet/logger";
import { withSpan } from "@outlet/observability";
import type { WorkerMetrics } from "@outlet/observability";
import { OutboxDispatchRelay, errorCode } from "@outlet/outbox";
import { measureStaleness, outboxPendingSource } from "@outlet/search";
import type { SearchFreshness } from "@outlet/search";
import type { OutboxEvent, PendingByType, SqlClient } from "@outlet/outbox";
import { RELAY_KILL_SWITCH, UNSUBSCRIBED_TYPES } from "./jobs.js";
import type { Handler, KillRead, WorkerJobDef } from "./jobs.js";

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
  /** Types acked without a handler (default UNSUBSCRIBED_TYPES). Any other type with no consumer is never claimed. */
  readonly unsubscribed?: readonly string[];
  readonly now?: () => Date;
}

export interface ConsumerStatus {
  readonly job: string;
  readonly killed: boolean;
  readonly pending: number;
  /** Age in seconds of the oldest unpublished event this job consumes; 0 when none. null until the first lag read. */
  readonly lagSeconds: number | null;
}

export interface UnroutedStatus {
  readonly pending: number;
  readonly lagSeconds: number;
  /** Event type names only (no ids, no payloads). */
  readonly types: readonly string[];
}

export interface SearchStatus {
  readonly stalenessMs: number;
  /** search_provider_unconfigured while no external engine exists (ADR-0010, ADR-0029): never reported as fresh. */
  readonly status: SearchFreshness;
  readonly deadLettered: number;
}

export interface RunnerStatus {
  readonly marketId: string;
  readonly relayKilled: boolean;
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly consumers: readonly ConsumerStatus[];
  /** Pending events no consumer of this process claims (null until the first lag read). */
  readonly unrouted: UnroutedStatus | null;
  /** Search index staleness (null until the first lag read). */
  readonly search: SearchStatus | null;
}

class HandlerTimeout extends Error {
  constructor() {
    super("handler timed out");
    this.name = "HandlerTimeout";
  }
}

interface Owner {
  readonly def: WorkerJobDef;
  readonly handler: Handler;
}

const ageSeconds = (at: number, p: PendingByType): number => Math.max(0, Math.round((at - p.oldestOccurredAt.getTime()) / 1000));

/**
 * One market's relay loop (ADR-0016): claim a batch of the routable types only (a type is routable when every consumer that owns it is enabled, or
 * when it is in the explicit unsubscribed allow-list), dispatch each event to ALL its owners in registration order (each in its own inbox
 * transaction; any failure fails the event, and the owners that already succeeded dedupe on the retry), ack or back off (never sooner than the
 * handler timeout). A kill switch flipped mid-batch is honoured per event (shouldSkip). Idle polls double the sleep up to pollMaxMs.
 */
export class MarketRunner {
  private readonly relay: OutboxDispatchRelay;
  private readonly owners = new Map<string, Owner[]>();
  private readonly unsubscribed: ReadonlySet<string>;
  private readonly now: () => Date;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastPollAt: Date | null = null;
  private lastError: string | null = null;
  private relayKilled = false;
  private killed = new Set<string>();
  private lag = new Map<string, { pending: number; lagSeconds: number }>();
  private unrouted: UnroutedStatus | null = null;
  private search: SearchStatus | null = null;
  private lastLagAt = 0;

  constructor(private readonly o: RunnerOptions) {
    this.now = o.now ?? (() => new Date());
    for (const def of o.jobs) for (const [type, handler] of def.handlers) this.owners.set(type, [...(this.owners.get(type) ?? []), { def, handler }]);
    this.unsubscribed = new Set((o.unsubscribed ?? UNSUBSCRIBED_TYPES).filter((t) => !this.owners.has(t)));
    this.relay = new OutboxDispatchRelay({
      db: o.relayDb, dispatch: (e) => this.dispatch(e), batchSize: o.batchSize, maxAttempts: o.maxAttempts, leaseMs: o.leaseMs, minRetryMs: o.handlerTimeoutMs, now: this.now,
    });
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
        const l = this.lag.get(j.name);
        return { job: j.name, killed: this.killed.has(j.name), pending: l?.pending ?? 0, lagSeconds: l?.lagSeconds ?? null };
      }),
      unrouted: this.unrouted,
      search: this.search,
    };
  }

  /** Types claimable now: every owner enabled, plus the unsubscribed allow-list. */
  routableTypes(killed: ReadonlySet<string>): string[] {
    const owned = [...this.owners].filter(([, os]) => os.every((x) => !killed.has(x.def.name))).map(([t]) => t);
    return [...owned, ...this.unsubscribed];
  }

  /** One loop turn; returns how long to sleep before the next. Exposed for tests. */
  async turn(idleMs: number): Promise<number> {
    try {
      this.relayKilled = await this.o.kill.isKilled(RELAY_KILL_SWITCH, { marketId: this.o.marketId });
      this.killed = await this.killedJobs();
      await this.refreshLag();
      if (this.relayKilled) {
        this.lastPollAt = this.now();
        return this.o.pollMaxMs;
      }
      const r = await this.relay.runOnce({ includeTypes: this.routableTypes(this.killed), shouldStop: () => this.stopping, shouldSkip: (e) => this.skip(e.type) });
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

  private async killedJobs(): Promise<Set<string>> {
    const killed = new Set<string>();
    for (const j of this.o.jobs) if (await this.o.kill.isKilled(j.killSwitch, { marketId: this.o.marketId })) killed.add(j.name);
    return killed;
  }

  /** Per-event re-check (F6): the flag service answers from its 5 s cache, so a money switch flipped mid-batch stops the remaining events. */
  private async skip(type: string): Promise<boolean> {
    if (await this.o.kill.isKilled(RELAY_KILL_SWITCH, { marketId: this.o.marketId })) return true;
    for (const x of this.owners.get(type) ?? []) if (await this.o.kill.isKilled(x.def.killSwitch, { marketId: this.o.marketId })) return true;
    return false;
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
    const pending = await this.relay.pending([...this.owners.keys()]);
    const next = new Map<string, { pending: number; lagSeconds: number }>();
    for (const j of this.o.jobs) next.set(j.name, { pending: 0, lagSeconds: 0 });
    for (const p of pending) {
      for (const x of this.owners.get(p.type) ?? []) {
        const cur = next.get(x.def.name) ?? { pending: 0, lagSeconds: 0 };
        next.set(x.def.name, { pending: cur.pending + p.pending, lagSeconds: Math.max(cur.lagSeconds, ageSeconds(at, p)) });
      }
    }
    this.lag = next;
    for (const [job, v] of next) this.o.metrics.setLag(job, this.o.marketId, v.lagSeconds, v.pending);
    const other = await this.relay.unrouted([...this.owners.keys(), ...this.unsubscribed]);
    this.unrouted = {
      pending: other.reduce((n, p) => n + p.pending, 0),
      lagSeconds: other.reduce((m, p) => Math.max(m, ageSeconds(at, p)), 0),
      types: other.map((p) => p.type).sort(),
    };
    this.o.metrics.setUnrouted(this.o.marketId, this.unrouted.pending, this.unrouted.lagSeconds);
    // Search staleness from the outbox.relay context (it already reads outbox_events). No engine is contracted (ADR-0010, ADR-0029): the engine state is fixed
    // Unconfigured, so the status reads search_provider_unconfigured (never fresh) unless an event is stale or dead-lettered.
    const s = await measureStaleness(outboxPendingSource(this.o.relayDb, this.o.marketId), this.now(), { state: () => Promise.resolve({ configured: false, unsyncedDocuments: 0, oldestUnsyncedAt: null }) });
    this.search = { stalenessMs: s.stalenessMs, status: s.status, deadLettered: s.deadLettered };
    this.o.metrics.setSearchStaleness(this.o.marketId, s.stalenessMs, s.status);
  }

  private async dispatch(e: OutboxEvent): Promise<void> {
    const owners = this.owners.get(e.type) ?? [];
    if (owners.length === 0) {
      // Only the explicit allow-list is ever claimed without an owner; anything else here is a routing bug, so fail rather than ack.
      if (!this.unsubscribed.has(e.type)) throw new Error("unrouted event type claimed");
      this.o.metrics.recordHandled(0, { job: "none", event_type: e.type, outcome: "unsubscribed", market_id: this.o.marketId });
      return;
    }
    for (const x of owners) await this.handleOne(x, e);
  }

  private async handleOne(x: Owner, e: OutboxEvent): Promise<void> {
    const job = x.def.name;
    const started = performance.now();
    let outcome = "failed";
    try {
      outcome = await withSpan("worker.handle", { "worker.job": job, "event.type": e.type, "event.id": e.id, market_id: this.o.marketId }, () =>
        this.withTimeout(x.handler({ id: e.id, type: e.type, payload: e.payload, occurredAt: e.occurredAt })),
      );
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
