import { IngestEventWire, hasForbiddenKey, MAX_BATCH_EVENTS, type IngestBatch, type IngestEvent, type IngestEventInput } from "./schema";

/** Result of one send attempt, already classified by the transport. */
export type IngestOutcome =
  | { readonly kind: "accepted" }
  /** 503 analytics_ingest_disabled: the kill switch is blocked on the server. Drop, do not retry. */
  | { readonly kind: "disabled" }
  /** 400, 401 (attestation_required), 413, 422: retrying cannot help. Drop. */
  | { readonly kind: "rejected" }
  /** 429, 5xx, network failure: retry with backoff. */
  | { readonly kind: "retry" };

export interface IngestRequest {
  readonly body: IngestBatch;
  /** One per batch, reused on every retry of that batch. */
  readonly idempotencyKey: string;
  readonly platform: "ios" | "android";
  /** App Attest or Play Integrity token (X-App-Attest). */
  readonly attest: string;
}

/** Port: sends one batch. The generated api-client operation `ingestAnalyticsEvents` plugs in behind it. */
export interface IngestTransport {
  send(req: IngestRequest): Promise<IngestOutcome>;
}

/** Port: device attestation. Real App Attest wiring is a Security decision (VR-DASH-07); null means "none available". */
export interface AttestationPort {
  token(): Promise<string | null>;
}

/** Port: the kill switch `kill.analytics.ingest`. Blocked by default. */
export interface IngestGate {
  isAllowed(): boolean;
}
export const BLOCKED_GATE: IngestGate = { isAllowed: () => false };

export interface IngestEmitterConfig {
  readonly maxBatch: number;
  readonly flushIntervalMs: number;
  readonly maxQueue: number;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffCapMs: number;
}
export const DEFAULT_INGEST_CONFIG: IngestEmitterConfig = {
  maxBatch: 30,
  flushIntervalMs: 15_000,
  maxQueue: 500,
  maxAttempts: 5,
  backoffBaseMs: 1_000,
  backoffCapMs: 60_000,
};

export interface IngestEmitterDeps {
  readonly consent: { isGranted(purpose: "analytics"): boolean };
  readonly gate: IngestGate;
  readonly transport: IngestTransport;
  readonly attest: AttestationPort;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
  /** Uniform [0,1). Injected so tests are deterministic. */
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly timers: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  readonly platform: "ios" | "android";
  readonly config?: Partial<IngestEmitterConfig>;
}

export type DropReason = "no_consent" | "blocked" | "invalid" | "overflow" | "no_attestation" | "rejected" | "gave_up" | "withdrawn";

/**
 * Consent-gated, batched, in-memory-only emitter for first-party client analytics. Nothing is queued
 * before the `analytics` consent or while `kill.analytics.ingest` is blocked; withdrawal clears the
 * queue and aborts in-flight retries. The queue is never persisted. Carries no user id.
 */
export class IngestEmitter {
  private queue: IngestEvent[] = [];
  private timer: unknown = null;
  private flushing = false;
  private inflight: Promise<void> | null = null;
  private generation = 0;
  private readonly cfg: IngestEmitterConfig;
  readonly dropped: Record<DropReason, number> = {
    no_consent: 0, blocked: 0, invalid: 0, overflow: 0, no_attestation: 0, rejected: 0, gave_up: 0, withdrawn: 0,
  };

  constructor(private readonly deps: IngestEmitterDeps) {
    this.cfg = { ...DEFAULT_INGEST_CONFIG, ...deps.config, maxBatch: Math.min(deps.config?.maxBatch ?? DEFAULT_INGEST_CONFIG.maxBatch, MAX_BATCH_EVENTS) };
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Never throws. True only when the event entered the queue. */
  enqueue(input: IngestEventInput): boolean {
    try {
      if (!this.deps.consent.isGranted("analytics")) return this.drop("no_consent");
      if (!this.deps.gate.isAllowed()) return this.drop("blocked");
      if (hasForbiddenKey(input)) return this.drop("invalid");
      const parsed = IngestEventWire.safeParse({
        ...input,
        event_id: this.deps.ids.next(),
        occurred_at: this.deps.clock.now().toISOString(),
      });
      if (!parsed.success) return this.drop("invalid");
      this.queue.push(parsed.data);
      while (this.queue.length > this.cfg.maxQueue) {
        this.queue.shift();
        this.dropped.overflow += 1;
      }
      if (this.queue.length >= this.cfg.maxBatch) void this.flush();
      else this.schedule();
      return true;
    } catch {
      return this.drop("invalid");
    }
  }

  /** Call on every consent change. Withdrawal empties the queue and cancels pending work. */
  onConsentChanged(): void {
    if (!this.deps.consent.isGranted("analytics")) this.clear("withdrawn");
  }

  clear(reason: "withdrawn" | "blocked" = "withdrawn"): void {
    this.dropped[reason] += this.queue.length;
    this.queue = [];
    this.generation += 1;
    this.cancelTimer();
  }

  /** Sends queued events in batches until the queue is empty. Never throws. */
  flush(): Promise<void> {
    if (this.inflight === null) {
      const run = this.drain().finally(() => { this.inflight = null; });
      this.inflight = run;
    }
    return this.inflight;
  }

  private async drain(): Promise<void> {
    this.flushing = true;
    this.cancelTimer();
    try {
      while (this.queue.length > 0 && this.permitted()) {
        const gen = this.generation;
        const events = this.queue.splice(0, this.cfg.maxBatch);
        await this.sendWithRetry(events, gen);
        if (gen !== this.generation) break;
      }
      if (!this.permitted() && this.queue.length > 0) this.clear(this.deps.consent.isGranted("analytics") ? "blocked" : "withdrawn");
    } catch {
      // flush must never throw into the UI
    } finally {
      this.flushing = false;
      if (this.queue.length > 0 && this.permitted()) this.schedule();
    }
  }

  private permitted(): boolean {
    return this.deps.consent.isGranted("analytics") && this.deps.gate.isAllowed();
  }

  private async sendWithRetry(events: IngestEvent[], gen: number): Promise<void> {
    const key = this.deps.ids.next();
    const body: IngestBatch = { sent_at: this.deps.clock.now().toISOString(), events };
    for (let attempt = 0; attempt < this.cfg.maxAttempts; attempt += 1) {
      if (gen !== this.generation || !this.permitted()) {
        this.dropped[this.deps.consent.isGranted("analytics") ? "blocked" : "withdrawn"] += events.length;
        return;
      }
      const token = await this.deps.attest.token();
      if (token === null || token.length === 0) {
        this.dropped.no_attestation += events.length;
        return;
      }
      if (gen !== this.generation || !this.permitted()) {
        this.dropped[this.deps.consent.isGranted("analytics") ? "blocked" : "withdrawn"] += events.length;
        return;
      }
      let outcome: IngestOutcome;
      try {
        outcome = await this.deps.transport.send({ body, idempotencyKey: key, platform: this.deps.platform, attest: token });
      } catch {
        outcome = { kind: "retry" };
      }
      if (outcome.kind === "accepted") return;
      if (outcome.kind === "disabled") {
        this.dropped.blocked += events.length;
        return;
      }
      if (outcome.kind === "rejected") {
        this.dropped.rejected += events.length;
        return;
      }
      const ceiling = Math.min(this.cfg.backoffCapMs, this.cfg.backoffBaseMs * 2 ** attempt);
      await this.deps.sleep(Math.floor(this.deps.random() * ceiling) + 1);
    }
    this.dropped.gave_up += events.length;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = this.deps.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, this.cfg.flushIntervalMs);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.deps.timers.clear(this.timer);
    this.timer = null;
  }

  private drop(reason: DropReason): false {
    this.dropped[reason] += 1;
    return false;
  }
}
