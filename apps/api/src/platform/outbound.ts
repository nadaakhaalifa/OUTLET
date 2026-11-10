/** BUILD-PROMPT §3: every outbound call has a timeout and a circuit breaker. */
export class TimeoutError extends Error {
  constructor(readonly label: string, readonly ms: number) {
    super(`${label} timed out after ${String(ms)} ms`);
    this.name = "TimeoutError";
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly label: string) {
    super(`${label} circuit is open`);
    this.name = "CircuitOpenError";
  }
}

export const withTimeout = async <T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(label, ms));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export interface BreakerOptions {
  readonly label: string;
  /** Consecutive failures that open the circuit. Default 5. */
  readonly failureThreshold?: number;
  /** How long the circuit stays open before one trial call. Default 10 s. */
  readonly openMs?: number;
  readonly now?: () => number;
}

/** closed → (N failures) → open → (openMs) → half-open: one trial; success closes, failure re-opens. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private trialInFlight = false;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: BreakerOptions) {
    this.threshold = opts.failureThreshold ?? 5;
    this.openMs = opts.openMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  get state(): "closed" | "open" | "half-open" {
    if (this.failures < this.threshold) return "closed";
    return this.now() < this.openUntil ? "open" : "half-open";
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "open" || (state === "half-open" && this.trialInFlight)) throw new CircuitOpenError(this.opts.label);
    const trial = state === "half-open";
    if (trial) this.trialInFlight = true;
    try {
      const r = await fn();
      this.failures = 0;
      return r;
    } catch (e) {
      this.failures = Math.min(this.failures + 1, this.threshold);
      if (this.failures >= this.threshold) this.openUntil = this.now() + this.openMs;
      throw e;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }
}
