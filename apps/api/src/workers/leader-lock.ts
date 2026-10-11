import { createHash } from "node:crypto";
import type { LeaderLease, LeaderLock } from "./scheduler";

/** Shared across schedulers in one process to model two replicas in tests. Leases expire by ttl. */
export class InMemoryLeaderLock implements LeaderLock {
  constructor(
    private readonly held: Map<string, { token: symbol; expiresAtMs: number }>,
    private readonly nowMs: () => number,
  ) {}

  static shared(nowMs: () => number): () => InMemoryLeaderLock {
    const held = new Map<string, { token: symbol; expiresAtMs: number }>();
    return () => new InMemoryLeaderLock(held, nowMs);
  }

  async tryAcquire(key: string, ttlMs: number): Promise<LeaderLease | null> {
    const cur = this.held.get(key);
    if (cur !== undefined && cur.expiresAtMs > this.nowMs()) return null;
    const token = Symbol(key);
    this.held.set(key, { token, expiresAtMs: this.nowMs() + ttlMs });
    return {
      release: async () => {
        if (this.held.get(key)?.token === token) this.held.delete(key);
      },
    };
  }
}

/** Minimal structural view of a `pg` Pool, so the adapter stays testable without a database. */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
export interface PgClientLike {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}

/** Stable signed 64-bit advisory lock id from a job key. */
export function advisoryKey(key: string): bigint {
  return createHash("sha256").update(`outlet.worker:${key}`).digest().readBigInt64BE(0);
}

/**
 * Session-level `pg_try_advisory_lock`. The lock lives on one pooled connection that is held for the
 * run; a crashed process drops the connection and Postgres frees the lock, so there is no ttl.
 * Release unlocks, and destroys the connection if the unlock itself fails (never returns a locked
 * connection to the pool).
 */
export class PgAdvisoryLeaderLock implements LeaderLock {
  constructor(private readonly pool: PgPoolLike) {}

  async tryAcquire(key: string): Promise<LeaderLease | null> {
    const id = advisoryKey(key).toString();
    const client = await this.pool.connect();
    try {
      const r = await client.query("select pg_try_advisory_lock($1::bigint) as locked", [id]);
      if (r.rows[0]?.["locked"] !== true) {
        client.release();
        return null;
      }
    } catch (e) {
      client.release(true);
      throw e;
    }
    return {
      release: async () => {
        try {
          await client.query("select pg_advisory_unlock($1::bigint)", [id]);
          client.release();
        } catch {
          client.release(true);
        }
      },
    };
  }
}
