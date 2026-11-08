/** Per-domain pacing: at most one request per `minIntervalMs` (default 5 s, master 9.2). The clock is injected by the caller. */
export class DomainRateLimiter {
  private readonly next = new Map<string, number>();
  constructor(private readonly minIntervalMs = 5000) {}

  /** Reserves the next slot and returns how long the caller must wait (ms) before sending. */
  reserve(domain: string, nowMs: number): number {
    const slot = Math.max(nowMs, this.next.get(domain) ?? 0);
    this.next.set(domain, slot + this.minIntervalMs);
    return slot - nowMs;
  }
}
