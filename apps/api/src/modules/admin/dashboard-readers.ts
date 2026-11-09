import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { DashboardReaderPort, SalesDaily, SnapshotRow, StoreTop } from "./dashboard.js";

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/**
 * Reads the three rollup tables (migration 0035) as the `admin.dashboard` worker job: SELECT only, market pinned by policy and by the SQL below. Each method is one
 * statement. The route has already proven `dashboard.read` and the per-tile actions; this class never decides who may see what.
 */
export class PgDashboardReader implements DashboardReaderPort {
  constructor(private readonly worker: RoleSqlClient<"outlet_worker">) {}

  private job<T>(marketId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.worker, { kind: "worker", marketId, job: "admin.dashboard" }, fn);
  }

  async snapshots(marketId: string, keys: readonly string[]): Promise<readonly SnapshotRow[]> {
    const r = await this.job(marketId, (tx) =>
      tx.query<{ tile_key: string; as_of: Date | string; payload: unknown; version: number }>(
        "SELECT tile_key, as_of, payload, version FROM admin_dashboard_snapshots WHERE market_id = $1 AND tile_key = ANY($2::text[])",
        [marketId, [...keys]],
      ),
    );
    return r.rows.map((x) => ({ key: x.tile_key, asOf: iso(x.as_of), payload: x.payload, version: x.version }));
  }

  async salesDaily(marketId: string, currency: string, from: string, to: string): Promise<SalesDaily> {
    const r = await this.job(marketId, (tx) =>
      tx.query<{ day: string; orders_paid: number; gmv: string; refunded: string; refreshed_at: Date | string; first_day: string | null }>(
        `SELECT day::text AS day, orders_paid, gmv_minor::text AS gmv, refunded_minor::text AS refunded, refreshed_at,
                (SELECT min(day)::text FROM market_sales_daily WHERE market_id = $1 AND currency = $2) AS first_day
           FROM market_sales_daily WHERE market_id = $1 AND currency = $2 AND day >= $3::date AND day <= $4::date ORDER BY day`,
        [marketId, currency, from, to],
      ),
    );
    let refreshed: string | null = null;
    for (const x of r.rows) {
      const at = iso(x.refreshed_at);
      if (refreshed === null || at > refreshed) refreshed = at;
    }
    return {
      rows: r.rows.map((x) => ({ day: x.day, orders: x.orders_paid, gmvMinor: BigInt(x.gmv), refundedMinor: BigInt(x.refunded) })),
      firstDay: r.rows[0]?.first_day ?? null,
      refreshedAt: refreshed,
    };
  }

  async storeSalesTop(marketId: string, currency: string, from: string, to: string, limit: number): Promise<StoreTop> {
    const r = await this.job(marketId, (tx) =>
      tx.query<{ part: "top" | "other"; store_id: string | null; name_ar: string | null; name_en: string | null; orders: number; gmv: string; stores: number; refreshed_at: Date | string | null }>(
        `WITH agg AS (
           SELECT store_id, sum(orders_paid)::int AS orders, sum(gmv_minor) AS gmv, max(refreshed_at) AS refreshed_at,
                  (array_agg(store_name_ar ORDER BY day DESC))[1] AS name_ar, (array_agg(store_name_en ORDER BY day DESC))[1] AS name_en
             FROM store_sales_daily WHERE market_id = $1 AND currency = $2 AND day >= $3::date AND day <= $4::date GROUP BY store_id),
         ranked AS (SELECT *, row_number() OVER (ORDER BY gmv DESC, store_id) AS rn FROM agg)
         SELECT 'top' AS part, store_id::text AS store_id, name_ar, name_en, orders, gmv::text AS gmv, 0 AS stores, refreshed_at FROM ranked WHERE rn <= $5
         UNION ALL
         SELECT 'other', NULL, NULL, NULL, COALESCE(sum(orders), 0)::int, COALESCE(sum(gmv), 0)::text, count(*)::int, max(refreshed_at) FROM ranked WHERE rn > $5`,
        [marketId, currency, from, to, limit],
      ),
    );
    const top = r.rows.filter((x) => x.part === "top");
    const other = r.rows.find((x) => x.part === "other");
    let asOf: string | null = null;
    for (const x of r.rows) if (x.refreshed_at !== null && (asOf === null || iso(x.refreshed_at) > asOf)) asOf = iso(x.refreshed_at);
    return {
      items: top.map((x) => ({ storeId: x.store_id ?? "", nameAr: x.name_ar ?? "", nameEn: x.name_en, orders: x.orders, gmvMinor: BigInt(x.gmv) })).sort((a, b) => (a.gmvMinor === b.gmvMinor ? 0 : a.gmvMinor > b.gmvMinor ? -1 : 1)),
      other: { stores: other?.stores ?? 0, orders: other?.orders ?? 0, gmvMinor: BigInt(other?.gmv ?? "0") },
      asOf,
    };
  }
}
