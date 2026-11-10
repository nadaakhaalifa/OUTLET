import { gcra } from "./gcra.js";
import type { RateDecision, RateLimiterPort, RateRule } from "./port.js";

/** Single-process GCRA. For tests and local dev only: in production every instance would have its own budget. */
export class MemoryRateLimiter implements RateLimiterPort {
  private readonly tats = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  hit(key: string, rule: RateRule): Promise<RateDecision> {
    const now = this.now();
    if (this.tats.size >= this.maxKeys) this.prune(now);
    const d = gcra(this.tats.get(key), now, rule);
    if (d.allowed) this.tats.set(key, d.tat);
    return Promise.resolve({ allowed: d.allowed, retryAfterMs: d.retryAfterMs, remaining: d.remaining });
  }

  get size(): number {
    return this.tats.size;
  }

  /** A TAT in the past means the key is back to a full burst: forgetting it changes nothing. */
  private prune(now: number): void {
    for (const [k, tat] of this.tats) if (tat <= now) this.tats.delete(k);
  }
}
