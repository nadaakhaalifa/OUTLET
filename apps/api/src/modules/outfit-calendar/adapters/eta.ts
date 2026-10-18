import { sql } from "kysely";
import { z } from "zod";
import type { DeliveryEtaPort } from "../domain/ports";
import type { OutfitCalendarDb } from "./kysely-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Row = z.object({ store_id: z.string(), hours: z.number().int().nullable() });

/**
 * Courier p80 transit time per store from the stores module's derived stats (store_directory_stats,
 * refreshed by jobs from delivered shipments, spec 21). Hours become whole days, rounded up.
 * A store with no stat answers null: the feasibility is then "unknown", never "ok".
 */
export class KyselyStoreDeliveryEta implements DeliveryEtaPort {
  constructor(private readonly db: OutfitCalendarDb) {}

  async p80Days(_userId: string, storeIds: readonly string[]): Promise<ReadonlyMap<string, number | null>> {
    const out = new Map<string, number | null>(storeIds.map((s) => [s, null]));
    const ids = storeIds.filter((s) => UUID.test(s));
    if (ids.length === 0) return out;
    const res = await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return sql`select store_id::text as store_id, p80_delivery_hours as hours from store_directory_stats where store_id = any(${ids}::uuid[])`.execute(trx);
    });
    for (const raw of res.rows) {
      const r = Row.parse(raw);
      out.set(r.store_id, r.hours === null ? null : Math.ceil(r.hours / 24));
    }
    return out;
  }
}
