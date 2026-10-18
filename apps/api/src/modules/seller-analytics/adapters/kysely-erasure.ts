import { sql } from "kysely";
import type { ShopperFactsEraser } from "../domain/erasure-ports";
import type { SellerAnalyticsDb } from "./db";

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;

/**
 * Postgres adapter for `forgetShopper` (migration 0090). Runs as the `system` role: the only role with the
 * column-limited UPDATE and the erase-only trigger refuses anything but `shopper_key = NULL`.
 */
export class KyselyShopperFactsEraser implements ShopperFactsEraser {
  constructor(private readonly db: SellerAnalyticsDb) {}

  async recordErasedKeys(keys: readonly string[], atMs: number): Promise<void> {
    if (keys.length === 0) return;
    await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      for (const k of keys) {
        await sql`insert into analytics_erased_keys (shopper_key, erased_at) values (${k}, ${ts(atMs)})
                  on conflict (shopper_key) do update set erased_at = greatest(analytics_erased_keys.erased_at, excluded.erased_at)`.execute(trx);
      }
    });
  }

  async nullShopperKeys(keys: readonly string[], limit: number): Promise<number> {
    if (keys.length === 0) return 0;
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql`
        update seller_analytics_facts set shopper_key = null
         where message_id in (select message_id from seller_analytics_facts where shopper_key in (${sql.join(keys)}) limit ${limit})`.execute(trx);
      return Number(r.numAffectedRows ?? 0n);
    });
  }
}
