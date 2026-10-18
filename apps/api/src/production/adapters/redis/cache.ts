import type { ZodType } from "zod";
import { keyHash, type RedisConnection } from "./connection";

export interface CacheOptions<T> {
  /** Bump when the cached shape changes: old entries are simply never read again. */
  readonly version: number;
  readonly ttlMs: number;
  readonly schema: ZodType<T>;
}

/**
 * Read-through JSON cache (values must be JSON-safe: no bigint, Date or undefined; convert money to
 * strings at the boundary). Stampede protection: concurrent misses in one process share one loader call
 * (single-flight), and across processes a short NX lock lets one loader refill while the others wait
 * briefly, then load themselves. Redis down, corrupt or schema-invalid entries all degrade to calling the
 * loader: the cache is an optimisation and never a source of truth.
 */
export class RedisCache {
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(
    private readonly conn: RedisConnection,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private k(ns: string, version: number, key: string): string {
    return this.conn.key("c", `v${version}`, ns, keyHash(ns, key));
  }

  async getOrLoad<T>(ns: string, key: string, opts: CacheOptions<T>, loader: () => Promise<T>): Promise<T> {
    const full = this.k(ns, opts.version, key);
    const pending = this.inflight.get(full);
    if (pending !== undefined) return (await pending) as T;
    const p = this.fill(full, opts, loader).finally(() => this.inflight.delete(full));
    this.inflight.set(full, p);
    return p;
  }

  private async fill<T>(full: string, opts: CacheOptions<T>, loader: () => Promise<T>): Promise<T> {
    const hit = await this.read(full, opts);
    if (hit.found) return hit.value;
    let locked = false;
    try {
      locked = (await this.conn.exec("cache.lock", (c) => c.set(`${full}:lock`, "1", "PX", 5000, "NX"))) === "OK";
    } catch {
      // Redis down: load directly
    }
    if (!locked) {
      for (let i = 0; i < 3; i++) {
        await this.sleep(40);
        const again = await this.read(full, opts);
        if (again.found) return again.value;
      }
    }
    try {
      const value = await loader();
      try {
        await this.conn.exec("cache.set", (c) => c.set(full, JSON.stringify(value), "PX", Math.max(1, Math.trunc(opts.ttlMs))));
      } catch {
        this.conn.stats.inc("cache.write_failed");
      }
      return value;
    } finally {
      if (locked) await this.conn.exec("cache.unlock", (c) => c.del(`${full}:lock`)).catch(() => undefined);
    }
  }

  private async read<T>(full: string, opts: CacheOptions<T>): Promise<{ found: true; value: T } | { found: false }> {
    let raw: string | null;
    try {
      raw = await this.conn.exec("cache.get", (c) => c.get(full));
    } catch {
      return { found: false };
    }
    if (raw === null) {
      this.conn.stats.inc("cache.miss");
      return { found: false };
    }
    try {
      const parsed = opts.schema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.conn.stats.inc("cache.hit");
        return { found: true, value: parsed.data };
      }
    } catch {
      // fall through: corrupt entry is a miss
    }
    this.conn.stats.inc("cache.invalid");
    return { found: false };
  }

  async invalidate(ns: string, key: string, version: number): Promise<void> {
    await this.conn.exec("cache.del", (c) => c.del(this.k(ns, version, key))).catch(() => undefined);
  }
}
