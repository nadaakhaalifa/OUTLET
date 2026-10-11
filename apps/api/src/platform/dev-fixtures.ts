import type { AuditRecord } from "@outlet/policy";
import type { AuditSink, RateLimitOutcome, RateLimitRule, RateLimiter } from "./ports";

/**
 * DEVELOPMENT FIXTURE. Per-process fixed-window counter. It is not shared between instances,
 * so it cannot enforce limits in a multi-replica deployment. Production needs an atomic
 * shared-store adapter (Redis or Postgres) behind the same port.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAtMs: number }>();

  async consume(key: string, rule: RateLimitRule, nowMs: number): Promise<RateLimitOutcome> {
    let w = this.windows.get(key);
    if (w === undefined || nowMs >= w.resetAtMs) {
      w = { count: 0, resetAtMs: nowMs + rule.windowMs };
      this.windows.set(key, w);
      this.evictExpired(nowMs);
    }
    w.count += 1;
    return {
      allowed: w.count <= rule.limit,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - w.count),
      resetAtMs: w.resetAtMs,
    };
  }

  private evictExpired(nowMs: number): void {
    if (this.windows.size < 10_000) return;
    for (const [k, w] of this.windows) if (nowMs >= w.resetAtMs) this.windows.delete(k);
  }
}

/** DEVELOPMENT FIXTURE. Keeps audit records in memory; production writes to the append-only audit log. */
export class InMemoryAuditSink implements AuditSink {
  readonly entries: AuditRecord[] = [];
  async record(entry: AuditRecord): Promise<void> {
    this.entries.push(entry);
  }
}
