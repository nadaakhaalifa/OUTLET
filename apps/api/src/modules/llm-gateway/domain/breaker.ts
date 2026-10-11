export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerConfig {
  readonly failureThreshold: number;
  readonly openMs: number;
  /** Rolling one-hour cost cap in micro-EGP; exceeding it opens the breaker (LLM10). */
  readonly costCapMicrosPerHour: number;
}

/**
 * Global circuit breaker: consecutive failures or an hourly cost overrun open it for `openMs`;
 * after that one probe is allowed (half open). Pure: time is passed in.
 */
export class CostBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;
  private windowStart = 0;
  private windowCost = 0;

  constructor(private readonly cfg: BreakerConfig) {}

  state(nowMs: number): BreakerState {
    if (this.openedAt === null) return "closed";
    return nowMs - this.openedAt >= this.cfg.openMs ? "half_open" : "open";
  }

  /** True when a call may go to the provider now. In half open exactly one probe is admitted. */
  allow(nowMs: number): boolean {
    const s = this.state(nowMs);
    if (s === "closed") return true;
    if (s === "open") return false;
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  success(nowMs: number): void {
    this.failures = 0;
    this.probing = false;
    if (this.openedAt !== null && nowMs - this.openedAt >= this.cfg.openMs) this.openedAt = null;
  }

  failure(nowMs: number): void {
    this.probing = false;
    this.failures++;
    if (this.openedAt !== null || this.failures >= this.cfg.failureThreshold) this.openedAt = nowMs;
  }

  addCost(nowMs: number, micros: number): void {
    if (nowMs - this.windowStart >= 3_600_000) {
      this.windowStart = nowMs;
      this.windowCost = 0;
    }
    this.windowCost += micros;
    if (this.windowCost > this.cfg.costCapMicrosPerHour) this.openedAt = nowMs;
  }
}
