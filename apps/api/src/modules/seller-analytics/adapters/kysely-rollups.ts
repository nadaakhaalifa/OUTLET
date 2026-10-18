import { cairoHourBucket } from "@outlet/domain";
import { sql } from "kysely";
import { z } from "zod";
import {
  PLATFORM_FACT_METRICS,
  keyString,
  type RollupDelta,
  type RollupKey,
  type RollupRowState,
  type RollupScope,
} from "../domain/bridge";
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


const Big = z.union([z.bigint(), z.number(), z.string()]).transform((v) => BigInt(v));
const Ms = z.union([z.number(), z.string()]).transform((v) => Math.round(Number(v)));

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const hourExpr = (col: ReturnType<typeof sql.ref>) => sql`floor(extract(epoch from ${col}) / 3600) * 3600 * 1000`;

/** Seams for the interleaving harness (tests only). Production passes nothing. */
export interface RollupHooks {
  /** Called inside the consumer transaction after the advisory lock of a key is held and before its upsert. */
  readonly afterLock?: (key: RollupKey) => Promise<void>;
  /** Called inside `repairNewKey` after the lock is held and the re-check is done, before the recompute. */
  readonly repairAfterLock?: (key: RollupKey) => Promise<void>;
}

/**
 * Consumer write rule (spec section 6): the caller passes the batch's deltas already merged per key and
 * sorted (`aggregateDeltas`); this takes `pg_advisory_xact_lock(rollup_key_hash(...))` for each key in that
 * order and then upserts. Runs inside the ingest transaction (inbox row, facts insert), so a rollback undoes both.
 *
 * Defensive floor: the CHECK forbids a negative value. A negative delta can only arise from a lost order move,
 * so the sum is clamped at 0 instead of poisoning the batch; the reconciler repairs any resulting drift.
 */
export async function applyRollupDeltas(trx: SellerAnalyticsDb, deltas: readonly RollupDelta[], hooks?: RollupHooks): Promise<void> {
  for (const d of deltas) {
    const b = cairoHourBucket(d.key.hourUtcMs);
    const hour = ts(d.key.hourUtcMs);
    const delta = d.delta.toString();
    if (d.key.scope === "seller") {
      await sql`select pg_advisory_xact_lock(rollup_key_hash(${d.key.storeId}::uuid, ${d.key.metric}, ${hour}))`.execute(trx);
      if (hooks?.afterLock !== undefined) await hooks.afterLock(d.key);
      await sql`
        insert into seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value, version)
        values (${d.key.storeId}::uuid, ${d.key.metric}, ${hour}, ${b.cairoDate}::date, ${b.cairoHour}, ${b.utcOffsetMin}, greatest(${delta}::bigint, 0), 0)
        on conflict (store_id, metric, hour_utc) do update set
          value = greatest(seller_analytics_hourly.value + ${delta}::bigint, 0),
          version = seller_analytics_hourly.version + 1,
          updated_at = now()`.execute(trx);
    } else {
      await sql`select pg_advisory_xact_lock(rollup_key_hash(null::uuid, ${d.key.metric}, ${hour}))`.execute(trx);
      if (hooks?.afterLock !== undefined) await hooks.afterLock(d.key);
      await sql`
        insert into platform_metrics_hourly (metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value, version)
        values (${d.key.metric}, ${hour}, ${b.cairoDate}::date, ${b.cairoHour}, ${b.utcOffsetMin}, greatest(${delta}::bigint, 0), 0)
        on conflict (metric, hour_utc) do update set
          value = greatest(platform_metrics_hourly.value + ${delta}::bigint, 0),
          version = platform_metrics_hourly.version + 1,
          updated_at = now()`.execute(trx);
    }
  }
}

/** `analytics_rollup_watermarks.consumer` of the seller-analytics rollup consumer. */
export const CONSUMER_WATERMARK = "seller-analytics";

/** Outbox event types the rollup consumers route (spec section 5); unpublished ones hold the watermark back. */
export const ROUTED_EVENT_TYPES: readonly string[] = [
  "seller_order.placed",
  "order_line.purchased",
  "return_line.received",
  "inventory.level_changed",
  "analytics.client_batch",
];

/**
 * `applied_through` = min(now, oldest `occurred_at` among unpublished outbox rows of routed types), monotone.
 * Bounded by outbox_events_unpublished_idx.
 */
export async function advanceWatermark(trx: SellerAnalyticsDb, consumer: string, nowMs: number): Promise<void> {
  await sql`
    insert into analytics_rollup_watermarks (consumer, applied_through, updated_at)
    values (${consumer}, least(${ts(nowMs)}, coalesce(
      (select min(occurred_at) from outbox_events where published_at is null and event_type in (${sql.join(ROUTED_EVENT_TYPES)})), ${ts(nowMs)})), ${ts(nowMs)})
    on conflict (consumer) do update set
      applied_through = greatest(analytics_rollup_watermarks.applied_through, excluded.applied_through),
      updated_at = excluded.updated_at`.execute(trx);
}

const FactRow = z.object({
  store_id: z.string(),
  hr: Ms,
  store_views: Big,
  product_views: Big,
  impressions: Big,
  saves: Big,
  bags: Big,
  checkouts: Big,
  purchases: Big,
  gmv: Big,
  commission: Big,
  units: Big,
  returned: Big,
});
const OrderRow = z.object({ store_id: z.string(), hr: Ms, n: Big });
const PlatformFactRow = z.object({ hr: Ms, units: Big, gmv: Big });
const SellerRowSchema = z.object({ store_id: z.string(), metric: z.string(), hr: Ms, value: Big, held_value: Big, version: Big });
const PlatformRowSchema = z.object({ metric: z.string(), hr: Ms, value: Big, version: Big });

const SELLER_COLUMNS = ["store_views", "product_views", "impressions", "saves", "bags", "checkouts", "purchases"] as const;

/** Postgres adapter for repair and housekeeping. Every statement runs under `app.role = 'system'`. */
export class KyselyRollupMaintenance implements RollupMaintenance {
  constructor(
    private readonly db: SellerAnalyticsDb,
    private readonly hooks: RollupHooks = {},
  ) {}

  private async system<X>(run: (trx: SellerAnalyticsDb) => Promise<X>, isolation: "read committed" | "repeatable read" = "read committed"): Promise<X> {
    return this.db
      .transaction()
      .setIsolationLevel(isolation)
      .execute(async (trx) => {
        await sql`select set_config('app.role', 'system', true)`.execute(trx);
        return run(trx as unknown as SellerAnalyticsDb);
      });
  }

  async snapshot(scope: RollupScope, w: RollupWindow): Promise<RollupSnapshot> {
    return this.system(async (trx) => (scope === "seller" ? this.sellerSnapshot(trx, w) : this.platformSnapshot(trx, w)), "repeatable read");
  }

  private async sellerSnapshot(trx: SellerAnalyticsDb, w: RollupWindow): Promise<RollupSnapshot> {
    const facts = new Map<string, { key: RollupKey; total: bigint }>();
    const rows = new Map<string, { key: RollupKey; state: RollupRowState }>();
    const put = (storeId: string, metric: string, hourUtcMs: number, total: bigint): void => {
      if (total === 0n) return;
      const key: RollupKey = { scope: "seller", storeId, metric, hourUtcMs };
      facts.set(keyString(key), { key, total });
    };
    const agg = await sql<unknown>`
      select store_id::text as store_id, ${hourExpr(sql.ref("occurred_at"))} as hr,
        count(*) filter (where kind = 'store_view') as store_views,
        count(*) filter (where kind = 'view') as product_views,
        count(*) filter (where kind = 'impression') as impressions,
        count(*) filter (where kind = 'save') as saves,
        count(*) filter (where kind = 'bag') as bags,
        count(*) filter (where kind = 'checkout') as checkouts,
        count(*) filter (where kind = 'purchase') as purchases,
        coalesce(sum(gross_minor) filter (where kind = 'purchase'), 0) as gmv,
        coalesce(sum(commission_minor) filter (where kind = 'purchase'), 0) as commission,
        coalesce(sum(qty) filter (where kind = 'purchase'), 0) as units,
        coalesce(sum(qty) filter (where kind = 'return'), 0) as returned
        from seller_analytics_facts
       where occurred_at >= ${ts(w.fromMs)} and occurred_at < ${ts(w.toMs)}
         and kind in ('store_view', 'view', 'impression', 'save', 'bag', 'checkout', 'purchase', 'return')
       group by 1, 2`.execute(trx);
    for (const r of agg.rows.map((x) => FactRow.parse(x))) {
      for (const c of SELLER_COLUMNS) put(r.store_id, c, r.hr, r[c]);
      put(r.store_id, "gmv_minor", r.hr, r.gmv);
      put(r.store_id, "commission_minor", r.hr, r.commission);
      put(r.store_id, "units", r.hr, r.units);
      put(r.store_id, "returned_units", r.hr, r.returned);
    }
    const orders = await sql<unknown>`
      select o.store_id::text as store_id, ${hourExpr(sql.ref("o.m"))} as hr, count(*) as n
        from (select f.store_id, f.seller_order_id, min(f.occurred_at) as m
                from seller_analytics_facts f
               where f.kind = 'purchase'
                 and (f.store_id, f.seller_order_id) in (
                   select store_id, seller_order_id from seller_analytics_facts
                    where kind = 'purchase' and occurred_at >= ${ts(w.fromMs)} and occurred_at < ${ts(w.toMs)})
               group by 1, 2) o
       where o.m >= ${ts(w.fromMs)} and o.m < ${ts(w.toMs)}
       group by 1, 2`.execute(trx);
    for (const r of orders.rows.map((x) => OrderRow.parse(x))) put(r.store_id, "orders", r.hr, r.n);

    const stored = await sql<unknown>`
      select store_id::text as store_id, metric, ${hourExpr(sql.ref("hour_utc"))} as hr, value, held_value, version
        from seller_analytics_hourly
       where hour_utc >= ${ts(w.fromMs)} and hour_utc < ${ts(w.toMs)}`.execute(trx);
    for (const r of stored.rows.map((x) => SellerRowSchema.parse(x))) {
      const key: RollupKey = { scope: "seller", storeId: r.store_id, metric: r.metric, hourUtcMs: r.hr };
      rows.set(keyString(key), { key, state: { value: r.value, held: r.held_value, version: r.version } });
    }
    return { facts, rows };
  }

  private async platformSnapshot(trx: SellerAnalyticsDb, w: RollupWindow): Promise<RollupSnapshot> {
    const facts = new Map<string, { key: RollupKey; total: bigint }>();
    const rows = new Map<string, { key: RollupKey; state: RollupRowState }>();
    const agg = await sql<unknown>`
      select ${hourExpr(sql.ref("occurred_at"))} as hr, coalesce(sum(qty), 0) as units, coalesce(sum(gross_minor), 0) as gmv
        from seller_analytics_facts
       where kind = 'purchase' and occurred_at >= ${ts(w.fromMs)} and occurred_at < ${ts(w.toMs)}
       group by 1`.execute(trx);
    for (const r of agg.rows.map((x) => PlatformFactRow.parse(x))) {
      for (const [metric, total] of [["units_purchased", r.units], ["gmv_purchased_minor", r.gmv]] as const) {
        if (total === 0n) continue;
        const key: RollupKey = { scope: "platform", storeId: null, metric, hourUtcMs: r.hr };
        facts.set(keyString(key), { key, total });
      }
    }
    const stored = await sql<unknown>`
      select metric, ${hourExpr(sql.ref("hour_utc"))} as hr, value, version
        from platform_metrics_hourly
       where hour_utc >= ${ts(w.fromMs)} and hour_utc < ${ts(w.toMs)} and metric in (${sql.join([...PLATFORM_FACT_METRICS])})`.execute(trx);
    for (const r of stored.rows.map((x) => PlatformRowSchema.parse(x))) {
      const key: RollupKey = { scope: "platform", storeId: null, metric: r.metric, hourUtcMs: r.hr };
      rows.set(keyString(key), { key, state: { value: r.value, held: 0n, version: r.version } });
    }
    return { facts, rows };
  }

  async casRepair(key: RollupKey, expected: bigint, readVersion: bigint): Promise<CasOutcome> {
    return this.system(async (trx) => {
      const hour = ts(key.hourUtcMs);
      if (key.scope === "seller") {
        // Preserve the held part (anomaly guard) when it still fits; publish the rest.
        const res = await sql`
          update seller_analytics_hourly
             set held_value = least(held_value, ${expected.toString()}::bigint),
                 value = ${expected.toString()}::bigint - least(held_value, ${expected.toString()}::bigint),
                 version = version + 1, updated_at = now()
           where store_id = ${key.storeId}::uuid and metric = ${key.metric} and hour_utc = ${hour} and version = ${readVersion.toString()}::bigint`.execute(trx);
        return Number(res.numAffectedRows ?? 0n) > 0 ? "corrected" : "skipped_concurrent";
      }
      const res = await sql`
        update platform_metrics_hourly
           set value = ${expected.toString()}::bigint, version = version + 1, updated_at = now()
         where metric = ${key.metric} and hour_utc = ${hour} and version = ${readVersion.toString()}::bigint`.execute(trx);
      return Number(res.numAffectedRows ?? 0n) > 0 ? "corrected" : "skipped_concurrent";
    });
  }

  async repairNewKey(key: RollupKey): Promise<NewKeyOutcome> {
    return this.system(async (trx) => {
      const hour = ts(key.hourUtcMs);
      await sql`select pg_advisory_xact_lock(rollup_key_hash(${key.storeId}::uuid, ${key.metric}, ${hour}))`.execute(trx);
      const exists =
        key.scope === "seller"
          ? await sql`select 1 from seller_analytics_hourly where store_id = ${key.storeId}::uuid and metric = ${key.metric} and hour_utc = ${hour}`.execute(trx)
          : await sql`select 1 from platform_metrics_hourly where metric = ${key.metric} and hour_utc = ${hour}`.execute(trx);
      if (exists.rows.length > 0) return "exists";
      if (this.hooks.repairAfterLock !== undefined) await this.hooks.repairAfterLock(key);
      const total = await this.recompute(trx, key);
      if (total === 0n) return "zero";
      const b = cairoHourBucket(key.hourUtcMs);
      if (key.scope === "seller") {
        await sql`
          insert into seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value, version)
          values (${key.storeId}::uuid, ${key.metric}, ${hour}, ${b.cairoDate}::date, ${b.cairoHour}, ${b.utcOffsetMin}, ${total.toString()}::bigint, 0)
          on conflict (store_id, metric, hour_utc) do nothing`.execute(trx);
      } else {
        await sql`
          insert into platform_metrics_hourly (metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value, version)
          values (${key.metric}, ${hour}, ${b.cairoDate}::date, ${b.cairoHour}, ${b.utcOffsetMin}, ${total.toString()}::bigint, 0)
          on conflict (metric, hour_utc) do nothing`.execute(trx);
      }
      return "inserted";
    });
  }

  /** Facts total of one key, read inside the key's advisory lock at READ COMMITTED (sees every committed consumer fact). */
  private async recompute(trx: SellerAnalyticsDb, key: RollupKey): Promise<bigint> {
    const from = ts(key.hourUtcMs);
    const to = ts(key.hourUtcMs + 3_600_000);
    const one = async (q: Promise<{ rows: unknown[] }>): Promise<bigint> => Big.parse((((await q).rows[0] ?? {}) as { n?: unknown }).n ?? 0);
    if (key.scope === "platform") {
      const col = key.metric === "units_purchased" ? sql`qty` : sql`gross_minor`;
      return one(sql<unknown>`select coalesce(sum(${col}), 0) as n from seller_analytics_facts where kind = 'purchase' and occurred_at >= ${from} and occurred_at < ${to}`.execute(trx));
    }
    const store = sql`store_id = ${key.storeId}::uuid`;
    const window = sql`occurred_at >= ${from} and occurred_at < ${to}`;
    const counts: Readonly<Record<string, string>> = {
      store_views: "store_view",
      product_views: "view",
      impressions: "impression",
      saves: "save",
      bags: "bag",
      checkouts: "checkout",
      purchases: "purchase",
    };
    const kind = counts[key.metric];
    if (kind !== undefined) return one(sql<unknown>`select count(*) as n from seller_analytics_facts where ${store} and kind = ${kind} and ${window}`.execute(trx));
    if (key.metric === "gmv_minor") return one(sql<unknown>`select coalesce(sum(gross_minor), 0) as n from seller_analytics_facts where ${store} and kind = 'purchase' and ${window}`.execute(trx));
    if (key.metric === "commission_minor") return one(sql<unknown>`select coalesce(sum(commission_minor), 0) as n from seller_analytics_facts where ${store} and kind = 'purchase' and ${window}`.execute(trx));
    if (key.metric === "units") return one(sql<unknown>`select coalesce(sum(qty), 0) as n from seller_analytics_facts where ${store} and kind = 'purchase' and ${window}`.execute(trx));
    if (key.metric === "returned_units") return one(sql<unknown>`select coalesce(sum(qty), 0) as n from seller_analytics_facts where ${store} and kind = 'return' and ${window}`.execute(trx));
    if (key.metric === "orders") {
      return one(sql<unknown>`
        select count(*) as n from (
          select seller_order_id, min(occurred_at) as m from seller_analytics_facts
           where ${store} and kind = 'purchase'
             and seller_order_id in (select seller_order_id from seller_analytics_facts where ${store} and kind = 'purchase' and ${window})
           group by 1) o
         where o.m >= ${from} and o.m < ${to}`.execute(trx));
    }
    throw new Error(`rollup metric ${key.metric} cannot be recomputed from facts`);
  }

  async record(rec: ReconciliationRecord): Promise<void> {
    await this.system(async (trx) => {
      await sql`
        insert into analytics_rollup_reconciliations (id, scope, window_from, window_to, checked_rows, mismatches, corrected, skipped_concurrent, outcome, ran_at)
        values (${rec.id}::uuid, ${rec.scope}, ${ts(rec.window.fromMs)}, ${ts(rec.window.toMs)}, ${rec.checkedRows}, ${rec.mismatches},
                ${rec.corrected}, ${rec.skippedConcurrent}, ${rec.outcome}, ${ts(rec.ranAtMs)})`.execute(trx);
    });
  }

  async firstFactMs(): Promise<number | null> {
    return this.system(async (trx) => {
      const r = await sql<{ ms: string | null }>`select (extract(epoch from min(occurred_at)) * 1000)::text as ms from seller_analytics_facts`.execute(trx);
      const v = r.rows[0]?.ms;
      return v === null || v === undefined ? null : Math.round(Number(v));
    });
  }

  async maintainPartitions(nowMs: number, ahead: number, retainMonths: number): Promise<PartitionReport> {
    return this.system(async (trx) => {
      const r = await sql<unknown>`select * from analytics_rollup_maintain_partitions(${ts(nowMs)}, ${ahead}, ${retainMonths})`.execute(trx);
      const row = z.object({ created: z.number(), moved_rows: Big, dropped: z.number(), default_rows_after: Big }).parse(r.rows[0]);
      return { created: row.created, movedRows: Number(row.moved_rows), dropped: row.dropped, defaultRows: Number(row.default_rows_after) };
    });
  }

  async defaultPartitionRows(): Promise<readonly DefaultPartitionRows[]> {
    return this.system(async (trx) => {
      const r = await sql<unknown>`select table_name, n from analytics_rollup_default_partition_rows()`.execute(trx);
      return r.rows.map((x) => {
        const p = z.object({ table_name: z.string(), n: Big }).parse(x);
        return { table: p.table_name, rows: Number(p.n) };
      });
    });
  }
}
