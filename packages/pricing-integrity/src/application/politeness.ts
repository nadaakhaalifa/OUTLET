/** Per-domain pacing port: at most one request per interval. `reserve` returns how long the caller must wait (ms) before sending. */
export interface DomainRateLimiterPort {
  reserve(domain: string, nowMs: number): number | Promise<number>;
}

/** Per-domain pacing: at most one request per `minIntervalMs` (default 5 s, master 9.2). The clock is injected by the caller. In-memory: one process only. */
export class DomainRateLimiter implements DomainRateLimiterPort {
  private readonly next = new Map<string, number>();
  constructor(private readonly minIntervalMs = 5000) {}

  /** Reserves the next slot and returns how long the caller must wait (ms) before sending. */
  reserve(domain: string, nowMs: number): number {
    const slot = Math.max(nowMs, this.next.get(domain) ?? 0);
    this.next.set(domain, slot + this.minIntervalMs);
    return slot - nowMs;
  }
}

/**
 * Shared slot store for a multi-worker deployment. A Redis adapter implements `claimSlot` atomically (one Lua script:
 * `slot = max(now, GET key); SET key slot + interval PX ttl; return slot`), so two workers never share a slot. No Redis in this package.
 */
export interface SlotStore {
  /** Atomically claims the next free slot for `key` and returns its start time (ms epoch). */
  claimSlot(key: string, nowMs: number, intervalMs: number): Promise<number>;
}
export class SharedDomainRateLimiter implements DomainRateLimiterPort {
  constructor(private readonly store: SlotStore, private readonly minIntervalMs = 5000, private readonly keyPrefix = "pw:rl:") {}
  async reserve(domain: string, nowMs: number): Promise<number> {
    const slot = await this.store.claimSlot(`${this.keyPrefix}${domain}`, nowMs, this.minIntervalMs);
    return Math.max(0, slot - nowMs);
  }
}
/** Test double standing in for the Redis script (same contract). */
export class InMemorySlotStore implements SlotStore {
  private readonly next = new Map<string, number>();
  claimSlot(key: string, nowMs: number, intervalMs: number): Promise<number> {
    const slot = Math.max(nowMs, this.next.get(key) ?? 0);
    this.next.set(key, slot + intervalMs);
    return Promise.resolve(slot);
  }
}
