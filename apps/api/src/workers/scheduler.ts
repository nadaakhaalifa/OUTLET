import { nextCairoOccurrence, type CairoSchedule } from "./cairo";

/** Time source. The scheduler never reads Date.now directly. */
export interface WorkerClock {
  nowMs(): number;
}

/** Timer source for per-job timeouts and the polling loop. Injected so tests run on a fake clock. */
export interface WorkerTimers {
  after(ms: number, fn: () => void): { cancel(): void };
}

export interface LeaderLease {
  release(): Promise<void>;
}

/**
 * Mutual exclusion across replicas. `tryAcquire` returns null when another holder has the key.
 * A lease dies with its holder (session lock or ttl), so a crashed replica never wedges a job.
 */
export interface LeaderLock {
  tryAcquire(key: string, ttlMs: number): Promise<LeaderLease | null>;
}

export type JobOutcome = "success" | "failure" | "timeout" | "skipped_blocked" | "skipped_not_leader" | "skipped_disabled";
export type Criticality = "critical" | "important" | "routine";

export interface WorkerMetrics {
  jobRan(name: string, outcome: JobOutcome, durationMs: number): void;
  /** Dead-man gauge: alert when `lastSuccessAtMs` is older than the job's expected cadence. */
  deadMan(name: string, state: { readonly lastSuccessAtMs: number | null; readonly consecutiveFailures: number }): void;
}

export type LogFields = Readonly<Record<string, string | number | boolean | null>>;
/** Structured logger. Callers pass only ids, counters and error class names, never PII. */
export interface WorkerLogger {
  log(level: "info" | "warn" | "error", event: string, fields: LogFields): void;
}

/** Capability kill switches. A blocked capability makes its jobs skip, not fail. */
export interface CapabilityGate {
  isBlocked(capability: string): Promise<boolean>;
}

export type Cadence =
  | { readonly kind: "interval"; readonly everyMs: number }
  | ({ readonly kind: "cairo" } & CairoSchedule);

export interface JobContext {
  readonly name: string;
  readonly nowMs: number;
  /** Aborted when the timeout fires. Long jobs should honour it between batches. */
  readonly signal: AbortSignal;
}

/** A job may return numeric counters; they are logged. Never return identifiers or PII. */
export type JobResult = void | Readonly<Record<string, number>>;

export interface Job {
  readonly name: string;
  readonly cadence: Cadence;
  readonly lockKey: string;
  readonly timeoutMs: number;
  readonly criticality: Criticality;
  /** Kill-switch capability. Blocked: the run is skipped and recorded as skipped_blocked. */
  readonly capability?: string;
  /** Extra enable predicate (for example event mode). False: skipped_disabled. */
  readonly enabled?: () => boolean | Promise<boolean>;
  run(ctx: JobContext): Promise<JobResult>;
}

export interface BackoffConfig {
  readonly baseMs: number;
  readonly capMs: number;
}

export interface SchedulerDeps {
  readonly clock: WorkerClock;
  readonly timers: WorkerTimers;
  readonly lock: LeaderLock;
  readonly metrics: WorkerMetrics;
  readonly logger: WorkerLogger;
  readonly gate: CapabilityGate;
  /** Uniform [0,1). */
  readonly random: () => number;
  readonly backoff?: BackoffConfig;
  /** Jitter as a fraction of the interval, capped by maxJitterMs. */
  readonly jitterFraction?: number;
  readonly maxJitterMs?: number;
  /** Lease ttl is timeout plus this margin. */
  readonly leaseMarginMs?: number;
}

export interface JobStatus {
  readonly name: string;
  readonly criticality: Criticality;
  readonly nextRunAtMs: number;
  readonly lastRunAtMs: number | null;
  readonly lastSuccessAtMs: number | null;
  readonly lastOutcome: JobOutcome | null;
  readonly consecutiveFailures: number;
  readonly running: boolean;
}

interface State {
  nextRunAtMs: number;
  lastRunAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastOutcome: JobOutcome | null;
  consecutiveFailures: number;
  running: boolean;
}

const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1_000, capMs: 5 * 60_000 };

export class Scheduler {
  private readonly jobs = new Map<string, { readonly job: Job; readonly state: State }>();
  private readonly backoff: BackoffConfig;
  private readonly inflight = new Set<Promise<void>>();
  private loop: { cancel(): void } | null = null;
  private stopping = false;

  constructor(private readonly d: SchedulerDeps) {
    this.backoff = d.backoff ?? DEFAULT_BACKOFF;
  }

  register(job: Job): void {
    if (this.jobs.has(job.name)) throw new Error(`duplicate job ${job.name}`);
    if (job.timeoutMs <= 0) throw new Error(`job ${job.name} needs a positive timeout`);
    const now = this.d.clock.nowMs();
    // First run: one cadence from now plus jitter, so a fleet restart does not stampede.
    this.jobs.set(job.name, {
      job,
      state: { nextRunAtMs: this.nextAfter(job, now, true), lastRunAtMs: null, lastSuccessAtMs: null, lastOutcome: null, consecutiveFailures: 0, running: false },
    });
  }

  status(): readonly JobStatus[] {
    return [...this.jobs.values()].map(({ job, state }) => ({ name: job.name, criticality: job.criticality, ...state }));
  }

  /** Runs every job that is due and waits for them. Safe to call repeatedly. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.d.clock.nowMs();
    const runs: Promise<void>[] = [];
    for (const { job, state } of this.jobs.values()) {
      if (state.running || state.nextRunAtMs > now) continue;
      state.running = true;
      const p = this.runJob(job, state).finally(() => {
        state.running = false;
        this.inflight.delete(p);
      });
      this.inflight.add(p);
      runs.push(p);
    }
    await Promise.all(runs);
  }

  /** Starts the polling loop. */
  start(pollMs = 1_000): void {
    if (this.loop !== null || this.stopping) return;
    const arm = (): void => {
      this.loop = this.d.timers.after(pollMs, () => {
        void this.tick().finally(() => {
          if (!this.stopping && this.loop !== null) arm();
        });
      });
    };
    arm();
  }

  /** Graceful shutdown: no new runs, waits for in-flight jobs up to `graceMs` (aborting them after). */
  async shutdown(graceMs: number): Promise<void> {
    this.stopping = true;
    this.loop?.cancel();
    this.loop = null;
    this.d.logger.log("info", "worker.shutdown", { inflight: this.inflight.size });
    if (this.inflight.size === 0) return;
    await new Promise<void>((resolve) => {
      const t = this.d.timers.after(graceMs, resolve);
      void Promise.allSettled([...this.inflight]).then(() => {
        t.cancel();
        resolve();
      });
    });
  }

  private nextAfter(job: Job, fromMs: number, withJitter: boolean): number {
    let at: number;
    let span: number;
    if (job.cadence.kind === "interval") {
      at = fromMs + job.cadence.everyMs;
      span = job.cadence.everyMs;
    } else {
      at = nextCairoOccurrence(fromMs, job.cadence);
      span = 60 * 60_000;
    }
    if (!withJitter) return at;
    const max = Math.min((this.d.jitterFraction ?? 0.1) * span, this.d.maxJitterMs ?? 30_000);
    return at + Math.floor(this.d.random() * max);
  }

  private async runJob(job: Job, state: State): Promise<void> {
    const { clock, metrics, logger } = this.d;
    const startedAt = clock.nowMs();
    state.lastRunAtMs = startedAt;
    const finish = (outcome: JobOutcome, nextAtMs: number): void => {
      state.lastOutcome = outcome;
      state.nextRunAtMs = nextAtMs;
      metrics.jobRan(job.name, outcome, clock.nowMs() - startedAt);
      metrics.deadMan(job.name, { lastSuccessAtMs: state.lastSuccessAtMs, consecutiveFailures: state.consecutiveFailures });
    };
    const regular = (): number => this.nextAfter(job, clock.nowMs(), true);

    try {
      if (job.enabled !== undefined && !(await job.enabled())) {
        logger.log("info", "job.skipped", { job: job.name, reason: "disabled" });
        return finish("skipped_disabled", regular());
      }
      if (job.capability !== undefined && (await this.d.gate.isBlocked(job.capability))) {
        logger.log("warn", "job.skipped", { job: job.name, reason: "blocked", capability: job.capability });
        return finish("skipped_blocked", regular());
      }
    } catch (e) {
      return this.fail(job, state, e, "failure", finish);
    }

    let lease: LeaderLease | null;
    try {
      lease = await this.d.lock.tryAcquire(job.lockKey, job.timeoutMs + (this.d.leaseMarginMs ?? 10_000));
    } catch (e) {
      return this.fail(job, state, e, "failure", finish);
    }
    if (lease === null) {
      logger.log("info", "job.skipped", { job: job.name, reason: "not_leader" });
      return finish("skipped_not_leader", regular());
    }

    const abort = new AbortController();
    let timedOut = false;
    const timer = this.d.timers.after(job.timeoutMs, () => {
      timedOut = true;
      abort.abort();
    });
    try {
      const result = await Promise.race([
        job.run({ name: job.name, nowMs: startedAt, signal: abort.signal }),
        new Promise<never>((_, reject) => {
          abort.signal.addEventListener("abort", () => reject(new TimeoutError(job.name)), { once: true });
        }),
      ]);
      state.consecutiveFailures = 0;
      state.lastSuccessAtMs = clock.nowMs();
      const counters = result === undefined ? {} : result;
      logger.log("info", "job.succeeded", { job: job.name, durationMs: clock.nowMs() - startedAt, ...counters });
      finish("success", regular());
    } catch (e) {
      this.fail(job, state, e, timedOut ? "timeout" : "failure", finish);
    } finally {
      timer.cancel();
      try {
        await lease.release();
      } catch {
        logger.log("warn", "job.lease_release_failed", { job: job.name });
      }
    }
  }

  private fail(job: Job, state: State, e: unknown, outcome: "failure" | "timeout", finish: (o: JobOutcome, next: number) => void): void {
    state.consecutiveFailures += 1;
    const exp = Math.min(this.backoff.capMs, this.backoff.baseMs * 2 ** Math.min(state.consecutiveFailures - 1, 30));
    const jitter = Math.floor(this.d.random() * exp * 0.2);
    // Class name only: error messages can carry user data.
    this.d.logger.log("error", `job.${outcome}`, {
      job: job.name,
      criticality: job.criticality,
      error: e instanceof Error ? e.name : "NonError",
      consecutiveFailures: state.consecutiveFailures,
      retryInMs: exp + jitter,
    });
    finish(outcome, this.d.clock.nowMs() + exp + jitter);
  }
}

export class TimeoutError extends Error {
  constructor(job: string) {
    super(`job ${job} timed out`);
    this.name = "JobTimeoutError";
  }
}

/** Seconds after which a job with no success should page someone: three cadences, or 26h for Cairo schedules. */
export function deadManThresholdMs(job: Job): number {
  return job.cadence.kind === "interval" ? job.cadence.everyMs * 3 : job.cadence.weekday === undefined ? 26 * 3_600_000 : 8 * 86_400_000;
}
