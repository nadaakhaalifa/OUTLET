import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { getMarket } from "@outlet/markets-config";
import { SNAPSHOT_READERS } from "./snapshots.js";
import { SNAPSHOT_TILE_DATA, SNAPSHOT_TILE_KEYS, SNAPSHOT_VERSION } from "./schemas.js";
import type { SnapshotTileKey } from "./schemas.js";
import { addDays, isDay, localDay } from "./time.js";

export interface MarketClock { readonly timezone: string; readonly currency: string }
export interface RollupDeps {
  readonly client: RoleSqlClient<"outlet_worker">;
  readonly now?: () => Date;
  /** Timezone and currency of a market; defaults to markets-config (EG: Africa/Cairo, EGP). */
  readonly market?: (marketId: string) => MarketClock;
}

export interface SalesRow { readonly currency: string; readonly orders: number; readonly gmvMinor: bigint; readonly refundedMinor: bigint }
export interface StoreSalesRow { readonly storeId: string; readonly currency: string; readonly orders: number; readonly gmvMinor: bigint }
export interface DayRollup { readonly marketId: string; readonly day: string; readonly market: readonly SalesRow[]; readonly stores: readonly StoreSalesRow[] }

/**
 * Counted order groups of one market-local day (GMV basis, plan D3): reached PAID (day of paid_at), or a confirmed COD group that has no paid_at yet
 * (day of placed_at: no confirmation timestamp column exists). Cancelled COD groups never count; a paid group that is later cancelled or refunded still
 * counts here and shows up in refunded_minor. The day of an instant is `(ts AT TIME ZONE tz)::date`, which is exact on Egypt's DST switch days (a local
 * midnight that does not exist cannot be mapped back to an instant, so no day boundary is ever computed). The range predicate only narrows the index
 * scan: UTC midnight of the previous day to the day after, far wider than any UTC offset.
 */
const COUNTED_GROUPS = `
  win AS (SELECT (($2::date - 1)::timestamp AT TIME ZONE 'UTC') AS s, (($2::date + 2)::timestamp AT TIME ZONE 'UTC') AS e),
  cg AS (
    SELECT g.id, g.currency, g.total_minor FROM order_groups g, win w
     WHERE g.market_id = $1 AND g.paid_at >= w.s AND g.paid_at < w.e AND (g.paid_at AT TIME ZONE $3)::date = $2::date
    UNION ALL
    SELECT g.id, g.currency, g.total_minor FROM order_groups g, win w
     WHERE g.market_id = $1 AND g.paid_at IS NULL AND g.payment_method = 'cod' AND g.cancelled_at IS NULL
       AND g.status IN ('CONFIRMED_COD', 'PARTIALLY_FULFILLED', 'COMPLETED', 'REFUND_PENDING', 'REFUNDED')
       AND g.placed_at >= w.s AND g.placed_at < w.e AND (g.placed_at AT TIME ZONE $3)::date = $2::date
  )`;

const big = (v: string | null): bigint => (v === null ? 0n : BigInt(v));

/**
 * Writes the admin dashboard rollups (migration 0035) as worker job `reporting.rollup`. Every method is an idempotent upsert: running the same
 * day twice yields identical rows, and rows that no longer have activity are zeroed rather than deleted (the job has no DELETE grant).
 */
export class RollupService {
  private readonly now: () => Date;
  private readonly market: (marketId: string) => MarketClock;
  constructor(private readonly deps: RollupDeps) {
    this.now = deps.now ?? (() => new Date());
    this.market = deps.market ?? ((id) => { const m = getMarket(id.toLowerCase()); return { timezone: m.timezone, currency: m.currency }; });
  }

  private tx<T>(marketId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.deps.client, { kind: "worker", marketId, job: "reporting.rollup" }, fn);
  }

  /** Market-local today. */
  today(marketId: string): string {
    return localDay(this.now(), this.market(marketId).timezone);
  }

  /** Recomputes one market day (own transaction). */
  run(marketId: string, day: string): Promise<DayRollup> {
    return this.tx(marketId, (tx) => this.runIn(tx, marketId, day));
  }

  /** Recomputes the last `days` market days, today first, in the given transaction (one transaction per market). */
  async runRecentIn(tx: Queryable, marketId: string, days: number): Promise<readonly DayRollup[]> {
    const today = this.today(marketId);
    const out: DayRollup[] = [];
    for (let i = 0; i < days; i += 1) out.push(await this.runIn(tx, marketId, addDays(today, -i)));
    return out;
  }

  async runIn(tx: Queryable, marketId: string, day: string): Promise<DayRollup> {
    if (!isDay(day)) throw new Error(`invalid rollup day ${day}`);
    const { timezone, currency: marketCurrency } = this.market(marketId);
    const at = this.now().toISOString();
    const args = [marketId, day, timezone] as const;

    const sales = (await tx.query<{ currency: string; n: number; gmv: string }>(
      `WITH ${COUNTED_GROUPS} SELECT currency, count(*)::int AS n, sum(total_minor)::text AS gmv FROM cg GROUP BY currency`, args,
    )).rows;
    const refunds = (await tx.query<{ currency: string; amt: string }>(
      `WITH win AS (SELECT (($2::date - 1)::timestamp AT TIME ZONE 'UTC') AS s, (($2::date + 2)::timestamp AT TIME ZONE 'UTC') AS e)
       SELECT r.currency, sum(r.amount_minor)::text AS amt FROM refunds r, win w
        WHERE r.market_id = $1 AND r.status = 'COMPLETED' AND r.completed_at >= w.s AND r.completed_at < w.e AND (r.completed_at AT TIME ZONE $3)::date = $2::date
        GROUP BY r.currency`, args,
    )).rows;
    const stores = (await tx.query<{ store_id: string; currency: string; n: number; gmv: string; name_ar: string; name_en: string | null }>(
      `WITH ${COUNTED_GROUPS}
       SELECT so.store_id, so.currency, count(*)::int AS n, sum(so.total_minor)::text AS gmv, st.display_name_ar AS name_ar, st.display_name_en AS name_en
         FROM seller_orders so JOIN cg ON cg.id = so.order_group_id JOIN stores st ON st.id = so.store_id
        WHERE so.market_id = $1 GROUP BY so.store_id, so.currency, st.display_name_ar, st.display_name_en`, args,
    )).rows;

    const byCur = new Map<string, { orders: number; gmv: bigint; refunded: bigint }>();
    // The market currency always gets a row, even on a quiet day: its presence says "this day was rolled up" (the API never invents days before the first run).
    byCur.set(marketCurrency, { orders: 0, gmv: 0n, refunded: 0n });
    for (const s of sales) byCur.set(s.currency.trim(), { orders: s.n, gmv: big(s.gmv), refunded: byCur.get(s.currency.trim())?.refunded ?? 0n });
    for (const r of refunds) {
      const cur = r.currency.trim();
      const prev = byCur.get(cur) ?? { orders: 0, gmv: 0n, refunded: 0n };
      byCur.set(cur, { ...prev, refunded: big(r.amt) });
    }
    const marketRows: SalesRow[] = [...byCur.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, v]) => ({ currency, orders: v.orders, gmvMinor: v.gmv, refundedMinor: v.refunded }));
    for (const r of marketRows) {
      await tx.query(
        `INSERT INTO market_sales_daily (market_id, day, currency, orders_paid, gmv_minor, refunded_minor, refreshed_at) VALUES ($1, $2::date, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT (market_id, day, currency) DO UPDATE SET orders_paid = EXCLUDED.orders_paid, gmv_minor = EXCLUDED.gmv_minor, refunded_minor = EXCLUDED.refunded_minor, refreshed_at = EXCLUDED.refreshed_at`,
        [marketId, day, r.currency, r.orders, r.gmvMinor.toString(), r.refundedMinor.toString(), at],
      );
    }
    // A currency that had activity in an earlier run but none now is zeroed (never deleted).
    await tx.query(
      "UPDATE market_sales_daily SET orders_paid = 0, gmv_minor = 0, refunded_minor = 0, refreshed_at = $4::timestamptz WHERE market_id = $1 AND day = $2::date AND NOT (currency = ANY($3::text[])) AND (orders_paid <> 0 OR gmv_minor <> 0 OR refunded_minor <> 0)",
      [marketId, day, marketRows.map((r) => r.currency), at],
    );

    const storeRows: StoreSalesRow[] = stores.map((s) => ({ storeId: s.store_id, currency: s.currency.trim(), orders: s.n, gmvMinor: big(s.gmv) })).sort((a, b) => a.storeId.localeCompare(b.storeId) || a.currency.localeCompare(b.currency));
    for (const s of stores) {
      await tx.query(
        `INSERT INTO store_sales_daily (market_id, store_id, day, currency, orders_paid, gmv_minor, store_name_ar, store_name_en, refreshed_at) VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9::timestamptz)
         ON CONFLICT (market_id, store_id, day, currency) DO UPDATE SET orders_paid = EXCLUDED.orders_paid, gmv_minor = EXCLUDED.gmv_minor, store_name_ar = EXCLUDED.store_name_ar, store_name_en = EXCLUDED.store_name_en, refreshed_at = EXCLUDED.refreshed_at`,
        [marketId, s.store_id, day, s.currency.trim(), s.n, s.gmv, s.name_ar, s.name_en, at],
      );
    }
    await tx.query(
      `UPDATE store_sales_daily SET orders_paid = 0, gmv_minor = 0, refreshed_at = $5::timestamptz
        WHERE market_id = $1 AND day = $2::date AND (orders_paid <> 0 OR gmv_minor <> 0)
          AND NOT EXISTS (SELECT 1 FROM unnest($3::uuid[], $4::text[]) AS k (sid, cur) WHERE k.sid = store_sales_daily.store_id AND k.cur = store_sales_daily.currency)`,
      [marketId, day, storeRows.map((s) => s.storeId), storeRows.map((s) => s.currency), at],
    );
    return { marketId, day, market: marketRows, stores: storeRows };
  }

  /** Recomputes every snapshot tile (or the given ones) and upserts them; a payload that fails its Zod schema aborts the transaction (nothing half written). */
  snapshots(marketId: string, tiles: readonly SnapshotTileKey[] = SNAPSHOT_TILE_KEYS): Promise<readonly SnapshotTileKey[]> {
    return this.tx(marketId, (tx) => this.snapshotsIn(tx, marketId, tiles));
  }

  async snapshotsIn(tx: Queryable, marketId: string, tiles: readonly SnapshotTileKey[] = SNAPSHOT_TILE_KEYS): Promise<readonly SnapshotTileKey[]> {
    const { currency } = this.market(marketId);
    const now = this.now();
    for (const key of tiles) {
      const data = SNAPSHOT_TILE_DATA[key].parse(await (SNAPSHOT_READERS[key] as (c: Parameters<(typeof SNAPSHOT_READERS)["orders_by_step"]>[0]) => Promise<unknown>)({ tx, marketId, currency, now }));
      await tx.query(
        `INSERT INTO admin_dashboard_snapshots (market_id, tile_key, as_of, payload, version) VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5)
         ON CONFLICT (market_id, tile_key) DO UPDATE SET as_of = EXCLUDED.as_of, payload = EXCLUDED.payload, version = EXCLUDED.version`,
        [marketId, key, now.toISOString(), JSON.stringify(data), SNAPSHOT_VERSION],
      );
    }
    return tiles;
  }
}
