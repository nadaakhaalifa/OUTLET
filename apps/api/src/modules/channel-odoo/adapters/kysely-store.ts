import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { OdooConfig, OdooErrorCode, OdooStore, ProductLink } from "../domain/ports";

export type OdooDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const MsN = Int.transform((s) => Number(s)).nullable();
const BigN = Int.transform((s) => BigInt(s)).nullable();
const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoN = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const ConfigRow = z.object({
  channel_id: z.string(),
  store_id: z.string(),
  target_id: z.string(),
  db_name: z.string(),
  odoo_uid: z.number().int(),
  pricelist_id: z.number().int().nullable(),
  stock_location_id: z.number().int().nullable(),
  poll_interval_s: z.number().int(),
  breaker_failures: z.number().int(),
  opened_ms: MsN,
  polled_ms: MsN,
  last_error_code: z.string().nullable(),
  created_ms: Ms,
});
const CONFIG_COLS = sql`channel_id::text as channel_id, store_id::text as store_id, target_id::text as target_id, db_name,
  odoo_uid, pricelist_id, stock_location_id, poll_interval_s, breaker_failures,
  ${EPOCH("breaker_opened_at")} as opened_ms, ${EPOCH("last_polled_at")} as polled_ms, last_error_code,
  ${EPOCH("created_at")} as created_ms`;
const toConfig = (raw: unknown): OdooConfig => {
  const r = ConfigRow.parse(raw);
  return {
    channelId: r.channel_id,
    storeId: r.store_id,
    targetId: r.target_id,
    database: r.db_name,
    uid: r.odoo_uid,
    pricelistId: r.pricelist_id,
    stockLocationId: r.stock_location_id,
    pollIntervalSeconds: r.poll_interval_s,
    breakerFailures: r.breaker_failures,
    breakerOpenedAtMs: r.opened_ms,
    lastPolledAtMs: r.polled_ms,
    lastErrorCode: r.last_error_code as OdooErrorCode | null,
    createdAtMs: r.created_ms,
  };
};

const LinkRow = z.object({
  channel_id: z.string(),
  odoo_product_id: Int.transform((s) => Number(s)),
  store_id: z.string(),
  sku_id: z.string(),
  price: BigN,
  version: MsN,
  qty: z.number().int().nullable(),
  synced_ms: MsN,
});
const LINK_COLS = sql`channel_id::text as channel_id, odoo_product_id::text as odoo_product_id, store_id::text as store_id,
  sku_id::text as sku_id, last_price_amount::text as price, last_stock_source_version::text as version,
  last_stock_qty as qty, ${EPOCH("last_synced_at")} as synced_ms`;

/**
 * Raw SQL only, rows validated with Zod. Runs as the system role: the owning checks (store id of the
 * route against the config) happen in the use cases, and RLS still scopes seller-initiated reads.
 */
export class KyselyOdooStore implements OdooStore {
  constructor(private readonly db: OdooDb) {}

  private async tx<T>(run: (trx: OdooDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as OdooDb);
    });
  }

  async insertConfig(c: OdooConfig) {
    return this.tx(async (trx) => {
      const ins = await sql<unknown>`insert into odoo_channel_configs
        (channel_id, store_id, target_id, db_name, odoo_uid, pricelist_id, stock_location_id, poll_interval_s,
         breaker_failures, breaker_opened_at, last_polled_at, last_error_code, created_at)
        values (${c.channelId}::uuid, ${c.storeId}::uuid, ${c.targetId}::uuid, ${c.database}, ${c.uid}, ${c.pricelistId},
                ${c.stockLocationId}, ${c.pollIntervalSeconds}, ${c.breakerFailures}, ${isoN(c.breakerOpenedAtMs)}::timestamptz,
                ${isoN(c.lastPolledAtMs)}::timestamptz, ${c.lastErrorCode}, ${iso(c.createdAtMs)}::timestamptz)
        on conflict (channel_id) do nothing returning channel_id`.execute(trx);
      if (ins.rows.length > 0) return { kind: "created" as const, config: c };
      const r = await sql<unknown>`select ${CONFIG_COLS} from odoo_channel_configs where channel_id = ${c.channelId}::uuid`.execute(trx);
      return { kind: "exists" as const, config: toConfig(r.rows[0]) };
    });
  }

  async getConfig(channelId: string) {
    if (!UUID.test(channelId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${CONFIG_COLS} from odoo_channel_configs where channel_id = ${channelId}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toConfig(r.rows[0]);
    });
  }

  async listConfigs(storeId: string) {
    if (!UUID.test(storeId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${CONFIG_COLS} from odoo_channel_configs where store_id = ${storeId}::uuid
        order by created_at desc, channel_id desc`.execute(trx);
      return r.rows.map(toConfig);
    });
  }

  async listDue(nowMs: number, limit: number) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${CONFIG_COLS} from odoo_channel_configs
        where last_polled_at is null or last_polled_at + make_interval(secs => poll_interval_s) <= ${iso(nowMs)}::timestamptz
        order by last_polled_at nulls first, channel_id limit ${Math.max(1, Math.min(limit, 100))}`.execute(trx);
      return r.rows.map(toConfig);
    });
  }

  async updateConfig(c: OdooConfig) {
    await this.tx(async (trx) => {
      await sql`update odoo_channel_configs set breaker_failures = ${c.breakerFailures},
        breaker_opened_at = ${isoN(c.breakerOpenedAtMs)}::timestamptz, last_polled_at = ${isoN(c.lastPolledAtMs)}::timestamptz,
        last_error_code = ${c.lastErrorCode}, updated_at = now() where channel_id = ${c.channelId}::uuid`.execute(trx);
    });
  }

  async links(channelId: string) {
    if (!UUID.test(channelId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LINK_COLS} from odoo_product_links where channel_id = ${channelId}::uuid
        order by odoo_product_id`.execute(trx);
      return r.rows.map((raw): ProductLink => {
        const x = LinkRow.parse(raw);
        return {
          channelId: x.channel_id,
          odooProductId: x.odoo_product_id,
          storeId: x.store_id,
          skuId: x.sku_id,
          lastPriceAmount: x.price,
          lastStockSourceVersion: x.version,
          lastStockQty: x.qty,
          lastSyncedAtMs: x.synced_ms,
        };
      });
    });
  }

  async upsertLink(l: ProductLink) {
    await this.tx(async (trx) => {
      await sql`insert into odoo_product_links
        (channel_id, odoo_product_id, store_id, sku_id, last_price_amount, last_stock_source_version, last_stock_qty, last_synced_at)
        values (${l.channelId}::uuid, ${l.odooProductId}, ${l.storeId}::uuid, ${l.skuId}::uuid,
                ${l.lastPriceAmount === null ? null : l.lastPriceAmount.toString()}::bigint,
                ${l.lastStockSourceVersion}, ${l.lastStockQty}, ${isoN(l.lastSyncedAtMs)}::timestamptz)
        on conflict (channel_id, odoo_product_id) do update set
          sku_id = excluded.sku_id, last_price_amount = excluded.last_price_amount,
          last_stock_source_version = excluded.last_stock_source_version, last_stock_qty = excluded.last_stock_qty,
          last_synced_at = excluded.last_synced_at`.execute(trx);
    });
  }
}
