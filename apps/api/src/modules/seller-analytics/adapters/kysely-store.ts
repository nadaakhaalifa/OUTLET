import { sql } from "kysely";
import { z } from "zod";
import { aggregateDeltas, emptyFunnelCounts, factDeltas, orderDeltas, type FunnelCounts, type KCell, type RollupDelta, type RollupKey, type RollupScope, type SalesTotals } from "../domain/bridge";
import type {
  AnalyticsStore,
  DailySalesRow,
  FreshnessRow,
  GeoValue,
  ProductSalesRow,
  IngestResult,
  Range,
  ReturnReasonRow,
  SkuSalesRow,
  SourceEvent,
  StockRow,
} from "../domain/ports";
import type {
  CasOutcome,
  DefaultPartitionRows,
  NewKeyOutcome,
  PartitionReport,
  ReconciliationRecord,
  RollupMaintenance,
  RollupSnapshot,
  RollupWindow,
} from "../domain/rollup-ports";
import type { SellerAnalyticsDb } from "./db";
import { CONSUMER_WATERMARK, KyselyRollupMaintenance, advanceWatermark, applyRollupDeltas, type RollupHooks } from "./kysely-rollups";

export type { SellerAnalyticsDb };

const Num = z.union([z.number(), z.string()]).transform((v) => Number(v));
const Big = z.union([z.bigint(), z.number(), z.string()]).transform((v) => BigInt(v));
const Ms = z.union([z.number(), z.string()]).transform((v) => Number(v));

const Totals = z.object({ store_views: Num, product_views: Num, unique_visitors: Num });
const CellRow = z.object({ key: z.string(), shoppers: Num, events: Num });
const FunnelRow = z.object({
  product_id: z.string(),
  impression: Num,
  view: Num,
  save: Num,
  bag: Num,
  checkout: Num,
  purchase: Num,
});
const SalesRow = z.object({
  gmv: Big,
  commission: Big,
  units: Num,
  orders: Num,
  shoppers: Num,
  repeat_shoppers: Num,
});
const SkuRow = z.object({ sku_id: z.string(), product_id: z.string(), sold: Num, returned: Num });
const ReasonRow = z.object({ sku_id: z.string(), product_id: z.string(), reason: z.string(), units: Num });
const StockRowSchema = z.object({
  sku_id: z.string(),
  product_id: z.string(),
  size_label: z.string(),
  on_hand: Num,
  price_minor: Big,
  listed_ms: Ms,
});
const GeoRow = z.object({ key: z.string(), shoppers: Num, orders: Num, gmv: Big });
const ProductSalesDbRow = z.object({ product_id: z.string(), units: Num, gross: Big });
const DailyDbRow = z.object({ day: z.string(), gross: Big, orders: Num, units: Num });
const FreshRow = z.object({ ingest_ms: Ms, event_ms: Ms });

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;

/**
 * Postgres adapter over migration 0028. Writes run as the `system` role. Reads run with
 * `app.role = 'seller'` and `app.store_ids = <the one store>` so RLS is on for every read AND each
 * query repeats `store_id = $1` (defence in depth).
 */
export class KyselySellerAnalyticsStore implements AnalyticsStore, RollupMaintenance {
  private readonly maintenance: KyselyRollupMaintenance;

  constructor(
    private readonly db: SellerAnalyticsDb,
    private readonly hooks: RollupHooks = {},
  ) {
    this.maintenance = new KyselyRollupMaintenance(db, hooks);
  }

  snapshot(scope: RollupScope, w: RollupWindow): Promise<RollupSnapshot> {
    return this.maintenance.snapshot(scope, w);
  }
  casRepair(key: RollupKey, expected: bigint, readVersion: bigint): Promise<CasOutcome> {
    return this.maintenance.casRepair(key, expected, readVersion);
  }
  repairNewKey(key: RollupKey): Promise<NewKeyOutcome> {
    return this.maintenance.repairNewKey(key);
  }
  record(rec: ReconciliationRecord): Promise<void> {
    return this.maintenance.record(rec);
  }
  firstFactMs(): Promise<number | null> {
    return this.maintenance.firstFactMs();
  }
  maintainPartitions(nowMs: number, ahead: number, retainMonths: number): Promise<PartitionReport> {
    return this.maintenance.maintainPartitions(nowMs, ahead, retainMonths);
  }
  defaultPartitionRows(): Promise<readonly DefaultPartitionRows[]> {
    return this.maintenance.defaultPartitionRows();
  }

  private async asStore<X>(storeId: string, run: (trx: SellerAnalyticsDb) => Promise<X>): Promise<X> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'seller', true), set_config('app.store_ids', ${storeId}, true)`.execute(trx);
      return run(trx as unknown as SellerAnalyticsDb);
    });
  }

  async ingest(consumer: string, events: readonly SourceEvent[], nowMs: number): Promise<IngestResult> {
    if (events.length === 0) return { applied: 0, duplicates: 0 };
    return this.db.transaction().execute(async (trx0) => {
      const trx = trx0 as unknown as SellerAnalyticsDb;
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      let applied = 0;
      let duplicates = 0;
      const deltas: RollupDelta[] = [];
      const erased = await this.erasedKeys(trx, events);
      for (const e0 of events) {
        // H3 step 3: an old outbox payload may still carry a shopper key that was erased after it was written.
        const e: SourceEvent = e0.shopperKey !== null && erased.has(e0.shopperKey) ? { ...e0, shopperKey: null } : e0;
        const claimed = await sql<{ one: number }>`
          insert into inbox_processed (consumer, message_id) values (${consumer}, ${e.messageId}::uuid)
          on conflict do nothing returning 1 as one`.execute(trx);
        if (claimed.rows.length === 0) {
          duplicates += 1;
          continue;
        }
        applied += 1;
        if (e.kind === "purchase") {
          // `orders` counts a seller order once, in the hour of its earliest purchase fact: read the history BEFORE inserting this fact.
          const prev = await sql<{ ms: string | null }>`
            select extract(epoch from min(occurred_at))::text as ms from seller_analytics_facts
             where store_id = ${e.storeId}::uuid and kind = 'purchase' and seller_order_id = ${e.sellerOrderId}::uuid`.execute(trx);
          const prevMs = prev.rows[0]?.ms;
          deltas.push(...orderDeltas(e.storeId, prevMs === null || prevMs === undefined ? null : Math.round(Number(prevMs) * 1000), e.occurredAtMs));
        }
        deltas.push(...factDeltas(e));
        if (e.kind === "stock_snapshot") {
          await sql`
            insert into seller_analytics_stock (store_id, sku_id, product_id, size_label, on_hand, price_minor, listed_at, observed_at)
            values (${e.storeId}::uuid, ${e.skuId}::uuid, ${e.productId}::uuid, ${e.sizeLabel}, ${e.onHand},
                    ${e.priceMinor.toString()}::bigint, ${ts(e.listedAtMs)}, ${ts(e.occurredAtMs)})
            on conflict (store_id, sku_id) do update set
              listed_at = least(seller_analytics_stock.listed_at, excluded.listed_at),
              product_id = case when excluded.observed_at >= seller_analytics_stock.observed_at then excluded.product_id else seller_analytics_stock.product_id end,
              size_label = case when excluded.observed_at >= seller_analytics_stock.observed_at then excluded.size_label else seller_analytics_stock.size_label end,
              on_hand = case when excluded.observed_at >= seller_analytics_stock.observed_at then excluded.on_hand else seller_analytics_stock.on_hand end,
              price_minor = case when excluded.observed_at >= seller_analytics_stock.observed_at then excluded.price_minor else seller_analytics_stock.price_minor end,
              observed_at = greatest(seller_analytics_stock.observed_at, excluded.observed_at)`.execute(trx);
        } else {
          const p = e.kind === "purchase" ? e : null;
          const rt = e.kind === "return" ? e : null;
          await sql`
            insert into seller_analytics_facts (message_id, store_id, kind, occurred_at, product_id, sku_id, shopper_key,
              seller_order_id, qty, gross_minor, commission_minor, size_label, reason, source, governorate, term)
            values (${e.messageId}::uuid, ${e.storeId}::uuid, ${e.kind}, ${ts(e.occurredAtMs)},
              ${"productId" in e ? e.productId : null}::uuid,
              ${p !== null ? p.skuId : rt !== null ? rt.skuId : null}::uuid,
              ${e.shopperKey},
              ${p !== null ? p.sellerOrderId : null}::uuid,
              ${p !== null ? p.qty : rt !== null ? rt.qty : null}::integer,
              ${p !== null ? p.grossMinor.toString() : null}::bigint,
              ${p !== null ? p.commissionMinor.toString() : null}::bigint,
              ${p !== null ? p.sizeLabel : null},
              ${rt !== null ? rt.reason : null},
              ${"source" in e ? (e.source ?? null) : null},
              ${p !== null ? (p.governorate ?? null) : null},
              ${e.kind === "search_click" ? e.term : null})`.execute(trx);
        }
        await sql`
          insert into seller_analytics_freshness (store_id, last_event_at, last_ingest_at)
          values (${e.storeId}::uuid, ${ts(e.occurredAtMs)}, ${ts(nowMs)})
          on conflict (store_id) do update set
            last_event_at = greatest(seller_analytics_freshness.last_event_at, excluded.last_event_at),
            last_ingest_at = greatest(seller_analytics_freshness.last_ingest_at, excluded.last_ingest_at)`.execute(trx);
      }
      // Keys sorted, one advisory lock and one upsert per key, inside this same transaction (spec section 6, consumer write rule).
      await applyRollupDeltas(trx, aggregateDeltas(deltas), this.hooks);
      await advanceWatermark(trx, CONSUMER_WATERMARK, nowMs);
      return { applied, duplicates };
    });
  }

  private async erasedKeys(trx: SellerAnalyticsDb, events: readonly SourceEvent[]): Promise<ReadonlySet<string>> {
    const keys = [...new Set(events.flatMap((e) => (e.shopperKey === null ? [] : [e.shopperKey])))];
    if (keys.length === 0) return new Set();
    const r = await sql<{ shopper_key: string }>`select shopper_key from analytics_erased_keys where shopper_key in (${sql.join(keys)})`.execute(trx);
    return new Set(r.rows.map((x) => x.shopper_key));
  }

  async trafficTotals(storeId: string, r: Range) {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select count(*) filter (where kind = 'store_view') as store_views,
               count(*) filter (where kind = 'view') as product_views,
               count(distinct shopper_key) as unique_visitors
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind in ('store_view', 'view')
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}`.execute(trx);
      const row = Totals.parse(res.rows[0]);
      return { storeViews: row.store_views, productViews: row.product_views, uniqueVisitors: row.unique_visitors };
    });
  }

  async trafficBySource(storeId: string, r: Range): Promise<readonly KCell<number>[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select coalesce(source, 'unknown') as key, count(distinct shopper_key) as shoppers, count(*) as events
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind in ('store_view', 'view')
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by 1 order by 1`.execute(trx);
      return res.rows.map((x) => CellRow.parse(x)).map((c) => ({ key: c.key, distinctShoppers: c.shoppers, value: c.events }));
    });
  }

  async funnelByProduct(storeId: string, r: Range) {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select product_id::text as product_id,
          ${sql.join(
            (Object.keys(emptyFunnelCounts()) as (keyof FunnelCounts)[]).map(
              (k) => sql`count(*) filter (where kind = ${k}) as ${sql.ref(k)}`,
            ),
          )}
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and product_id is not null
           and kind in ('impression', 'view', 'save', 'bag', 'checkout', 'purchase')
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by product_id order by product_id::text`.execute(trx);
      return res.rows.map((x) => {
        const f = FunnelRow.parse(x);
        return {
          productId: f.product_id,
          counts: { impression: f.impression, view: f.view, save: f.save, bag: f.bag, checkout: f.checkout, purchase: f.purchase },
        };
      });
    });
  }

  async salesTotals(storeId: string, r: Range): Promise<SalesTotals> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        with p as (
          select shopper_key, seller_order_id, qty, gross_minor, commission_minor
            from seller_analytics_facts
           where store_id = ${storeId}::uuid and kind = 'purchase'
             and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}),
        per_shopper as (
          select shopper_key, count(distinct seller_order_id) as n from p where shopper_key is not null group by shopper_key)
        select coalesce((select sum(gross_minor) from p), 0)::text as gmv,
               coalesce((select sum(commission_minor) from p), 0)::text as commission,
               coalesce((select sum(qty) from p), 0) as units,
               (select count(distinct seller_order_id) from p) as orders,
               (select count(*) from per_shopper) as shoppers,
               (select count(*) from per_shopper where n >= 2) as repeat_shoppers`.execute(trx);
      const s = SalesRow.parse(res.rows[0]);
      return {
        gmvMinor: s.gmv,
        commissionMinor: s.commission,
        units: s.units,
        orders: s.orders,
        distinctShoppers: s.shoppers,
        repeatShoppers: s.repeat_shoppers,
      };
    });
  }

  async skuSales(storeId: string, r: Range): Promise<readonly SkuSalesRow[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select sku_id::text as sku_id, min(product_id::text) as product_id,
               coalesce(sum(qty) filter (where kind = 'purchase'), 0) as sold,
               coalesce(sum(qty) filter (where kind = 'return'), 0) as returned
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind in ('purchase', 'return')
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by sku_id order by sku_id::text`.execute(trx);
      return res.rows.map((x) => SkuRow.parse(x)).map((s) => ({ skuId: s.sku_id, productId: s.product_id, soldUnits: s.sold, returnedUnits: s.returned }));
    });
  }

  async returnReasons(storeId: string, r: Range): Promise<readonly ReturnReasonRow[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select sku_id::text as sku_id, min(product_id::text) as product_id, reason, sum(qty) as units
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind = 'return'
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by sku_id, reason order by sku_id::text || reason`.execute(trx);
      return res.rows.map((x) => ReasonRow.parse(x)).map((s) => ({ skuId: s.sku_id, productId: s.product_id, reason: s.reason, units: s.units }));
    });
  }

  async stockLevels(storeId: string): Promise<readonly StockRow[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select sku_id::text as sku_id, product_id::text as product_id, size_label, on_hand, price_minor::text as price_minor,
               floor(extract(epoch from listed_at) * 1000)::text as listed_ms
          from seller_analytics_stock where store_id = ${storeId}::uuid order by sku_id::text`.execute(trx);
      return res.rows.map((x) => StockRowSchema.parse(x)).map((s) => ({
        skuId: s.sku_id,
        productId: s.product_id,
        sizeLabel: s.size_label,
        onHand: s.on_hand,
        priceMinor: s.price_minor,
        listedAtMs: s.listed_ms,
      }));
    });
  }

  async searchTerms(storeId: string, r: Range): Promise<readonly KCell<number>[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select term as key, count(distinct shopper_key) as shoppers, count(*) as events
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind = 'search_click'
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by term order by term`.execute(trx);
      return res.rows.map((x) => CellRow.parse(x)).map((c) => ({ key: c.key, distinctShoppers: c.shoppers, value: c.events }));
    });
  }

  async geography(storeId: string, r: Range): Promise<readonly KCell<GeoValue>[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select governorate as key, count(distinct shopper_key) as shoppers,
               count(distinct seller_order_id) as orders, sum(gross_minor)::text as gmv
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind = 'purchase' and governorate is not null
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by governorate order by governorate`.execute(trx);
      return res.rows.map((x) => GeoRow.parse(x)).map((g) => ({
        key: g.key,
        distinctShoppers: g.shoppers,
        value: { orders: g.orders, gmvMinor: g.gmv },
      }));
    });
  }

  async freshness(storeId: string): Promise<FreshnessRow | null> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select floor(extract(epoch from last_ingest_at) * 1000)::text as ingest_ms,
               floor(extract(epoch from last_event_at) * 1000)::text as event_ms
          from seller_analytics_freshness where store_id = ${storeId}::uuid`.execute(trx);
      const row = res.rows[0];
      if (row === undefined) return null;
      const f = FreshRow.parse(row);
      return { lastIngestMs: f.ingest_ms, lastEventMs: f.event_ms };
    });
  }

  async productSales(storeId: string, r: Range): Promise<readonly ProductSalesRow[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select product_id::text as product_id, sum(qty) as units, sum(gross_minor)::text as gross
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind = 'purchase'
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by product_id order by product_id::text`.execute(trx);
      return res.rows.map((x) => ProductSalesDbRow.parse(x)).map((p) => ({ productId: p.product_id, units: p.units, grossMinor: p.gross }));
    });
  }

  async dailySales(storeId: string, r: Range): Promise<readonly DailySalesRow[]> {
    return this.asStore(storeId, async (trx) => {
      const res = await sql<unknown>`
        select to_char(occurred_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') as day,
               sum(gross_minor)::text as gross, count(distinct seller_order_id) as orders, sum(qty) as units
          from seller_analytics_facts
         where store_id = ${storeId}::uuid and kind = 'purchase'
           and occurred_at >= ${ts(r.fromMs)} and occurred_at < ${ts(r.toMs)}
         group by 1 order by 1`.execute(trx);
      return res.rows.map((x) => DailyDbRow.parse(x)).map((d) => ({ day: d.day, grossMinor: d.gross, orders: d.orders, units: d.units }));
    });
  }
}
