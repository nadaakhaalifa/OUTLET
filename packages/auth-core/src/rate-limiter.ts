import type { SqlClient } from "@outlet/db";
import type { RateLimiter } from "./ports.js";

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  hit(key: string, limit: number, windowMs: number, now: Date): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
    const t = now.getTime();
    const live = (this.hits.get(key) ?? []).filter((h) => h > t - windowMs);
    if (live.length >= limit) {
      this.hits.set(key, live);
      return Promise.resolve({ allowed: false, remaining: 0, retryAfterMs: Math.max(0, (live[0] ?? t) + windowMs - t) });
    }
    live.push(t);
    this.hits.set(key, live);
    return Promise.resolve({ allowed: true, remaining: limit - live.length });
  }
}

/** Postgres-backed limiter (table rate_limit_hits). An advisory lock per key serialises check+insert. */
export class PgRateLimiter implements RateLimiter {
  constructor(private readonly db: SqlClient) {}
  hit(key: string, limit: number, windowMs: number, now: Date): Promise<{ allowed: boolean; remaining: number; retryAfterMs?: number }> {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const since = new Date(now.getTime() - windowMs);
      const r = await tx.query<{ n: string; oldest: Date | null }>(
        "SELECT count(*)::text AS n, min(hit_at) AS oldest FROM rate_limit_hits WHERE key = $1 AND hit_at > $2",
        [key, since.toISOString()],
      );
      const used = Number(r.rows[0]?.n ?? "0");
      if (used >= limit) {
        const oldest = r.rows[0]?.oldest;
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, (oldest ? oldest.getTime() : now.getTime()) + windowMs - now.getTime()) };
      }
      await tx.query("INSERT INTO rate_limit_hits (key, hit_at) VALUES ($1, $2)", [key, now.toISOString()]);
      return { allowed: true, remaining: limit - used - 1 };
    });
  }
}
