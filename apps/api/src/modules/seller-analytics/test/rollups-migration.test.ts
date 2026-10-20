import type { PGlite } from "@electric-sql/pglite";
import { lintMigration } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRollupDatabase, migrationSql } from "./rollup-db";

const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

const as = async <X>(role: string, stores: string, fn: () => Promise<X>): Promise<X> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.role', $1, true), set_config('app.store_ids', $2, true)", [role, stores]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};
const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) q`, params)).rows[0]?.n);
const hour = "date_trunc('hour', now())";

const sellerRow = (store: string, metric = "orders"): Promise<unknown> =>
  db.query(`INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value) VALUES ($1, $2, ${hour}, current_date, 12, 120, 1)`, [store, metric]);
const platformRow = (metric = "units_purchased"): Promise<unknown> =>
  db.query(`INSERT INTO platform_metrics_hourly (metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value) VALUES ($1, ${hour}, current_date, 12, 120, 1)`, [metric]);
const fact = (id: number, store: string, shopper: string | null) =>
  db.query(`INSERT INTO seller_analytics_facts (message_id, store_id, kind, occurred_at, product_id, shopper_key) VALUES ($1, $2, 'view', now() - interval '26 months', $3, $4)`, [U(id), store, U(1), shopper]);

beforeAll(async () => {
  db = await createRollupDatabase();
  await sellerRow(STORE_A);
  await sellerRow(STORE_B);
  await platformRow();
  await db.query(`INSERT INTO analytics_rollup_watermarks (consumer, applied_through) VALUES ('seller-analytics', now())`);
  await db.query(`INSERT INTO analytics_rollup_reconciliations (id, scope, window_from, window_to, checked_rows, mismatches, corrected, outcome) VALUES ($1, 'seller', now() - interval '1 hour', now(), 1, 0, 0, 'ok')`, [U(1)]);
  await fact(1, STORE_A, "px_00000000000000000000000000000001");
  await fact(2, STORE_A, "px_00000000000000000000000000000002");
  await fact(3, STORE_B, null);
}, 120_000);
afterAll(async () => {
  await db.close();
});

describe("0088_analytics_rollups", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(migrationSql("0088_analytics_rollups.sql"))).toEqual([]);
  });

  it("M2: leaves the current month and the next five as monthly partitions plus DEFAULT, on both tables", async () => {
    for (const parent of ["seller_analytics_hourly", "platform_metrics_hourly"]) {
      const r = await db.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = $1 ORDER BY 1`,
        [parent],
      );
      expect(r.rows.filter((x) => /_p\d{6}$/.test(x.name))).toHaveLength(6);
      expect(r.rows.map((x) => x.name)).toContain(`${parent}_default`);
    }
  });

  it("M2: a row 7 months ahead lands in DEFAULT, the gauge reports it, the partition job moves it", async () => {
    await db.query(
      `INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value)
       VALUES ($1, 'orders', date_trunc('month', now()) + interval '7 months' + interval '5 hours', current_date, 1, 120, 4)`,
      [STORE_A],
    );
    expect(await n("SELECT 1 FROM seller_analytics_hourly_default")).toBe(1);
    const gauge = await db.query<{ table_name: string; n: string }>("SELECT table_name, n::text FROM analytics_rollup_default_partition_rows() ORDER BY 1");
    expect(gauge.rows).toEqual([{ table_name: "platform_metrics_hourly", n: "0" }, { table_name: "seller_analytics_hourly", n: "1" }]);
    const r = await db.query<{ created: number; moved_rows: number; dropped: number; default_rows_after: number }>("SELECT * FROM analytics_rollup_maintain_partitions(now(), 8, 25)");
    expect(r.rows[0]).toMatchObject({ created: 6, moved_rows: 1, dropped: 0, default_rows_after: 0 });
    expect(await n("SELECT 1 FROM seller_analytics_hourly_default")).toBe(0);
    expect((await db.query<{ v: string }>(`SELECT value::text AS v FROM seller_analytics_hourly WHERE value = 4`)).rows).toHaveLength(1);
    // A second run is a no-op.
    expect((await db.query<{ created: number }>("SELECT * FROM analytics_rollup_maintain_partitions(now(), 8, 25)")).rows[0]?.created).toBe(0);
  });

  it("the partition job drops whole months older than the retention and deletes reconciliations older than 2 years", async () => {
    await db.exec(`CREATE TABLE seller_analytics_hourly_p202001 PARTITION OF seller_analytics_hourly FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`);
    await db.query(`INSERT INTO analytics_rollup_reconciliations (id, scope, window_from, window_to, checked_rows, mismatches, corrected, outcome, ran_at) VALUES ($1, 'platform', now() - interval '3 years 1 hour', now() - interval '3 years', 0, 0, 0, 'ok', now() - interval '3 years')`, [U(2)]);
    const r = await db.query<{ dropped: number }>("SELECT * FROM analytics_rollup_maintain_partitions(now(), 5, 25)");
    expect(r.rows[0]?.dropped).toBe(1);
    expect(await n("SELECT 1 FROM pg_class WHERE relname = 'seller_analytics_hourly_p202001'")).toBe(0);
    expect(await n("SELECT 1 FROM analytics_rollup_reconciliations WHERE id = $1", [U(2)])).toBe(0);
  });

  it("the partition job refuses nonsense arguments", async () => {
    await expect(db.query("SELECT * FROM analytics_rollup_maintain_partitions(now(), 1, 25)")).rejects.toThrow(/invalid partition maintenance arguments/);
    await expect(db.query("SELECT * FROM analytics_rollup_maintain_partitions(now(), 5, 1)")).rejects.toThrow(/invalid partition maintenance arguments/);
  });

  it("rollup_key_hash is stable, separates the key parts and differs between store and platform", async () => {
    const h = async (sql: string): Promise<string> => (await db.query<{ h: string }>(`SELECT ${sql}::text AS h`)).rows[0]?.h ?? "";
    const a = await h(`rollup_key_hash('${STORE_A}'::uuid, 'orders', '2026-10-01T10:00:00Z'::timestamptz)`);
    expect(a).toBe(await h(`rollup_key_hash('${STORE_A}'::uuid, 'orders', '2026-10-01T10:00:00Z'::timestamptz)`));
    expect(a).not.toBe(await h(`rollup_key_hash('${STORE_B}'::uuid, 'orders', '2026-10-01T10:00:00Z'::timestamptz)`));
    expect(a).not.toBe(await h(`rollup_key_hash('${STORE_A}'::uuid, 'units', '2026-10-01T10:00:00Z'::timestamptz)`));
    expect(a).not.toBe(await h(`rollup_key_hash('${STORE_A}'::uuid, 'orders', '2026-10-01T11:00:00Z'::timestamptz)`));
    expect(await h(`rollup_key_hash(null::uuid, 'units_purchased', '2026-10-01T10:00:00Z'::timestamptz)`)).not.toBe(a);
  });

  it("row shape: whole hours only, non-negative values, Egyptian offsets only", async () => {
    await expect(db.query(`INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value) VALUES ($1, 'units', now(), current_date, 1, 120, 1)`, [STORE_A])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value) VALUES ($1, 'units', ${hour} - interval '1 hour', current_date, 1, 60, 1)`, [STORE_A])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value) VALUES ($1, 'units', ${hour} - interval '1 hour', current_date, 1, 120, -1)`, [STORE_A])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO seller_analytics_hourly (store_id, metric, hour_utc, cairo_date, cairo_hour, utc_offset_min, value) VALUES ($1, 'bogus', ${hour} - interval '1 hour', current_date, 1, 120, 1)`, [STORE_A])).rejects.toThrow(/check/i);
  });

  it("RLS: a seller session for store A cannot read store B rollups, and cannot read platform tables", async () => {
    const mine = await as("seller", STORE_A, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM seller_analytics_hourly")).rows);
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((r) => r.store_id))).toEqual(new Set([STORE_A]));
    expect(await as("seller", STORE_A, () => n("SELECT 1 FROM seller_analytics_hourly WHERE store_id = $1", [STORE_B]))).toBe(0);
    expect(await as("seller", STORE_A, () => n("SELECT 1 FROM platform_metrics_hourly"))).toBe(0);
    expect(await as("seller", STORE_A, () => n("SELECT 1 FROM analytics_rollup_watermarks"))).toBe(0);
    expect(await as("seller", STORE_A, () => n("SELECT 1 FROM analytics_rollup_reconciliations"))).toBe(0);
    expect(await as("seller", "", () => n("SELECT 1 FROM seller_analytics_hourly"))).toBe(0);
  });

  it("RLS: ops and finance read platform rollups, marketing does not; seller tables follow stores", async () => {
    expect(await as("ops", "", () => n("SELECT 1 FROM platform_metrics_hourly"))).toBeGreaterThan(0);
    expect(await as("finance", "", () => n("SELECT 1 FROM platform_metrics_hourly"))).toBeGreaterThan(0);
    expect(await as("marketing", "", () => n("SELECT 1 FROM platform_metrics_hourly"))).toBe(0);
    expect(await as("ops", "", () => n("SELECT 1 FROM seller_analytics_hourly"))).toBe(0);
    expect(await as("security", "", () => n("SELECT 1 FROM analytics_rollup_watermarks"))).toBe(1);
    expect(await as("finance", "", () => n("SELECT 1 FROM analytics_rollup_reconciliations"))).toBeGreaterThan(0);
    expect(await as("marketing", "", () => n("SELECT 1 FROM analytics_rollup_reconciliations"))).toBe(0);
    expect(await as("admin", "", () => n("SELECT 1 FROM platform_metrics_hourly"))).toBe(0);
  });

  it("RLS: only the system role writes rollups, watermarks and reconciliations", async () => {
    await expect(as("seller", STORE_A, () => sellerRow(STORE_A, "saves"))).rejects.toThrow(/row-level security/i);
    await expect(as("ops", "", () => platformRow("orders_placed"))).rejects.toThrow(/row-level security/i);
    await expect(as("finance", "", () => platformRow("gmv_purchased_minor"))).rejects.toThrow(/row-level security/i);
    await expect(as("system", "", () => sellerRow(STORE_A, "saves"))).resolves.toBeDefined();
    const upd = await as("seller", STORE_A, () => db.query("UPDATE seller_analytics_hourly SET value = 99 WHERE store_id = $1", [STORE_A]));
    expect(upd.affectedRows).toBe(0);
    const updP = await as("finance", "", () => db.query("UPDATE platform_metrics_hourly SET value = 99"));
    expect(updP.affectedRows).toBe(0);
    await expect(as("seller", STORE_A, () => db.query(`INSERT INTO analytics_rollup_watermarks (consumer, applied_through) VALUES ('x', now())`))).rejects.toThrow(/row-level security/i);
    await expect(as("ops", "", () => db.query(`INSERT INTO analytics_rollup_reconciliations (id, scope, window_from, window_to, checked_rows, mismatches, corrected, outcome) VALUES ($1, 'seller', now() - interval '1 hour', now(), 0, 0, 0, 'ok')`, [U(77)]))).rejects.toThrow(/row-level security/i);
    await expect(as("system", "", () => db.query(`DELETE FROM seller_analytics_hourly`))).rejects.toThrow(/permission denied/i);
  });
});

describe("0090_analytics_facts_privacy", () => {
  it("passes the migration linter (one reasoned drop of the replaced search check, one trigger guard)", () => {
    expect(lintMigration(migrationSql("0090_analytics_facts_privacy.sql"))).toEqual([]);
  });

  it("H3: the system role may NULL shopper_key and nothing else; other roles cannot update or delete", async () => {
    const erased = await as("system", "", () => db.query("UPDATE seller_analytics_facts SET shopper_key = NULL WHERE message_id = $1", [U(1)]));
    expect(erased.affectedRows).toBe(1);
    await expect(as("system", "", () => db.query("UPDATE seller_analytics_facts SET qty = 5 WHERE message_id = $1", [U(2)]))).rejects.toThrow(/permission denied/i);
    await expect(as("system", "", () => db.query("UPDATE seller_analytics_facts SET shopper_key = 'px_other_key_0000000001' WHERE message_id = $1", [U(2)]))).rejects.toThrow(/may only be set to NULL/);
    const seller = await as("seller", STORE_A, () => db.query("UPDATE seller_analytics_facts SET shopper_key = NULL WHERE message_id = $1", [U(2)]));
    expect(seller.affectedRows).toBe(0);
    const del = await as("seller", STORE_A, () => db.query("DELETE FROM seller_analytics_facts WHERE message_id = $1", [U(2)]));
    expect(del.affectedRows).toBe(0);
    const ops = await as("ops", "", () => db.query("DELETE FROM seller_analytics_facts"));
    expect(ops.affectedRows).toBe(0);
    expect(await n("SELECT 1 FROM seller_analytics_facts WHERE shopper_key IS NOT NULL")).toBe(1);
  });

  it("H3: the erase-only trigger also stops an owner session from changing any other column", async () => {
    await expect(db.query("UPDATE seller_analytics_facts SET qty = 7, shopper_key = NULL WHERE message_id = $1", [U(2)])).rejects.toThrow(/only shopper_key may change/);
    await expect(db.query("UPDATE seller_analytics_facts SET shopper_key = 'px_other_key_0000000001' WHERE message_id = $1", [U(2)])).rejects.toThrow(/may only be set to NULL/);
    await expect(db.query("UPDATE seller_analytics_facts SET occurred_at = now() WHERE message_id = $1", [U(2)])).rejects.toThrow(/may only be set to NULL|only shopper_key may change/);
  });

  it("H3: the system role deletes rows older than the cutoff", async () => {
    const del = await as("system", "", () => db.query("DELETE FROM seller_analytics_facts WHERE occurred_at < now() - interval '25 months'"));
    expect(del.affectedRows).toBe(3);
  });

  it("M9: a search click needs a term or a term hash; a hash must be 64 hex characters", async () => {
    const ins = (id: number, term: string | null, hash: string | null) =>
      db.query(`INSERT INTO seller_analytics_facts (message_id, store_id, kind, occurred_at, term, term_hash) VALUES ($1, $2, 'search_click', now(), $3, $4)`, [U(id), STORE_A, term, hash]);
    await expect(ins(10, "linen", null)).resolves.toBeDefined();
    await expect(ins(11, null, "a".repeat(64))).resolves.toBeDefined();
    await expect(ins(12, null, null)).rejects.toThrow(/check/i);
    await expect(ins(13, null, "XYZ")).rejects.toThrow(/check/i);
  });

  it("B2: the suppression memo is readable and writable by the system role only, never updatable", async () => {
    const ins = () =>
      db.query(`INSERT INTO seller_analytics_suppression_memo (store_id, metric, dimension, dim_key, bucket, reason) VALUES ($1, 'seller.traffic.views', 'source', 'feed', '2026-10-29', 'primary')`, [STORE_A]);
    await expect(as("seller", STORE_A, ins)).rejects.toThrow(/row-level security/i);
    await expect(as("system", "", ins)).resolves.toBeDefined();
    expect(await as("seller", STORE_A, () => n("SELECT 1 FROM seller_analytics_suppression_memo"))).toBe(0);
    expect(await as("system", "", () => n("SELECT 1 FROM seller_analytics_suppression_memo"))).toBe(1);
    await expect(as("system", "", () => db.query("UPDATE seller_analytics_suppression_memo SET reason = 'margin'"))).rejects.toThrow(/permission denied/i);
    await expect(db.query(`INSERT INTO seller_analytics_suppression_memo (store_id, metric, dimension, dim_key, bucket, reason) VALUES ($1, 'm', 'source', 'x', 'not-a-bucket', 'primary')`, [STORE_A])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO seller_analytics_suppression_memo (store_id, metric, dimension, dim_key, bucket, reason) VALUES ($1, 'm', 'source', 'x', '2026-07..2026-09', 'margin')`, [STORE_A])).resolves.toBeDefined();
  });

  it("H3: analytics_erased_keys is system only", async () => {
    const ins = () => db.query(`INSERT INTO analytics_erased_keys (shopper_key) VALUES ('px_erased_00000000000001')`);
    await expect(as("seller", STORE_A, ins)).rejects.toThrow(/row-level security/i);
    await expect(as("system", "", ins)).resolves.toBeDefined();
    expect(await as("seller", STORE_A, () => n("SELECT 1 FROM analytics_erased_keys"))).toBe(0);
  });

  it("H3: the purge and the erasure lookups use their indexes", async () => {
    await db.exec("SET enable_seqscan = off");
    const plan = async (sql: string): Promise<string> => (await db.query<Record<string, string>>(`EXPLAIN ${sql}`)).rows.map((r) => Object.values(r)[0]).join("\n");
    expect(await plan("SELECT ctid FROM seller_analytics_facts WHERE occurred_at < now() - interval '25 months' LIMIT 5000")).toMatch(/sa_facts_occurred_idx/);
    expect(await plan("SELECT message_id FROM seller_analytics_facts WHERE shopper_key IN ('px_a', 'px_b') LIMIT 5000")).toMatch(/sa_facts_shopper_idx/);
    expect(await plan(`SELECT min(occurred_at) FROM seller_analytics_facts WHERE store_id = '${STORE_A}' AND kind = 'purchase' AND seller_order_id = '${U(5)}'`)).toMatch(/sa_facts_order_idx/);
    await db.exec("SET enable_seqscan = on");
  });

  it("is idempotent: running the file again changes nothing and fails nowhere", async () => {
    await expect(db.exec(migrationSql("0090_analytics_facts_privacy.sql"))).resolves.toBeDefined();
  });
});
