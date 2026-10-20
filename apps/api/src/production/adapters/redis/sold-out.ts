import type { RedisConnection } from "./connection";
import { keyHash } from "./connection";

/** Port shape of drops' SoldOutFlagPort (structural, so this file needs no module import). */
export interface SoldOutFlags {
  mark(dropId: string, ttlMs: number): Promise<void>;
  clear(dropId: string): Promise<void>;
  isSoldOut(dropId: string): Promise<boolean>;
}

/**
 * "Definitely sold out" pre-filter. A HINT ONLY: the Postgres reserve path always decides. So every
 * failure degrades to "not known sold out" (isSoldOut=false, writes dropped), which routes the request
 * to Postgres. A flag can only ever skip work, never grant stock.
 */
export class RedisSoldOutFlags implements SoldOutFlags {
  constructor(private readonly conn: RedisConnection) {}
  private k(dropId: string): string {
    return this.conn.key("soldout", keyHash("drop", dropId));
  }
  async mark(dropId: string, ttlMs: number): Promise<void> {
    try {
      await this.conn.exec("soldout.mark", (c) => c.set(this.k(dropId), "1", "PX", Math.max(1, Math.trunc(ttlMs))));
    } catch {
      this.conn.stats.inc("soldout.degraded");
    }
  }
  async clear(dropId: string): Promise<void> {
    try {
      await this.conn.exec("soldout.clear", (c) => c.del(this.k(dropId)));
    } catch {
      this.conn.stats.inc("soldout.degraded");
    }
  }
  async isSoldOut(dropId: string): Promise<boolean> {
    try {
      return (await this.conn.exec("soldout.get", (c) => c.get(this.k(dropId)))) === "1";
    } catch {
      this.conn.stats.inc("soldout.degraded");
      return false;
    }
  }
}
