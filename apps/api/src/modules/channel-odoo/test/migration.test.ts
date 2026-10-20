import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);
const SQL = readFileSync(fileURLToPath(new URL("0071_odoo_channel.sql", DIR)), "utf8");
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
const config = (channel: number, store: string, target: number) =>
  db.query(
    `INSERT INTO odoo_channel_configs (channel_id, store_id, target_id, db_name, odoo_uid) VALUES ($1, $2, $3, 'haul_prod', 7)`,
    [U(channel), store, U(target)],
  );
const price = (id: number, sku: number, store: string, source: string, at: string) =>
  db.query(
    `INSERT INTO price_events (id, sku_id, store_id, price_amount, valid_from, source, idempotency_key) VALUES ($1, $2, $3, 100000, $4, $5, $6)`,
    [U(id), U(sku), store, at, source, `k-${id}`],
  );

beforeAll(async () => {
  db = new PGlite();
  const names = readdirSync(fileURLToPath(DIR)).filter((f) => /^00(0[1-9]|1[01])_/.test(f)).sort();
  await migrate(withoutConcurrently(db), names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8"))));
  await db.exec(readFileSync(fileURLToPath(new URL("0024_price_integrity.sql", DIR)), "utf8"));
  await db.exec(readFileSync(fileURLToPath(new URL("0043_price_crawler.sql", DIR)), "utf8"));
  await db.exec(SQL);
  for (const [t, store, dom] of [[1, STORE_A, "odoo-a.example.com"], [2, STORE_B, "odoo-b.example.com"]] as const) {
    await db.query(
      `INSERT INTO crawl_targets (id, store_id, domain, status, verification_method, verification_token_hash, consent_at, verified_at)
       VALUES ($1, $2, $3, 'verified', 'dns_txt', repeat('a', 64), now(), now())`,
      [U(t), store, dom],
    );
    await db.query(
      `INSERT INTO channel_connections (id, store_id, kind, status, token_ref, kms_key_ref) VALUES ($1, $2, 'odoo', 'active', 'vault://odoo/x1', 'kms://key/x1')`,
      [U(10 + t), store],
    );
  }
  await config(11, STORE_A, 1);
  await config(12, STORE_B, 2);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0071_odoo_channel", () => {
  it("passes the migration linter and holds no credential column", async () => {
    expect(lintMigration(SQL)).toEqual([]);
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name in ('odoo_channel_configs','odoo_product_links')`,
    );
    expect(cols.rows.map((c) => c.column_name).filter((n) => /key|secret|token|password|login|email/.test(n))).toEqual([]);
  });

  it("accepts source 'odoo' in the immutable price ledger and still refuses unknown sources and mutation", async () => {
    await expect(price(1, 1, STORE_A, "odoo", "2026-10-01T00:00:00Z")).resolves.toBeDefined();
    await expect(price(2, 1, STORE_A, "magento", "2026-10-02T00:00:00Z")).rejects.toThrow(/check/i);
    await expect(db.query(`UPDATE price_events SET price_amount = 1 WHERE id = $1`, [U(1)])).rejects.toThrow();
    await expect(db.query(`DELETE FROM price_events WHERE id = $1`, [U(1)])).rejects.toThrow();
  });

  it("RLS: a seller reads only their own configs and links", async () => {
    await db.query(`INSERT INTO odoo_product_links (channel_id, odoo_product_id, store_id, sku_id) VALUES ($1, 101, $2, $3), ($4, 201, $5, $6)`, [U(11), STORE_A, U(21), U(12), STORE_B, U(22)]);
    const mine = await as("seller", STORE_A, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM odoo_channel_configs")).rows);
    expect(mine.map((r) => r.store_id)).toEqual([STORE_A]);
    const links = await as("seller", STORE_B, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM odoo_product_links")).rows);
    expect(links.map((r) => r.store_id)).toEqual([STORE_B]);
    const none = await as("seller", "", async () => (await db.query("SELECT 1 FROM odoo_channel_configs")).rows);
    expect(none).toEqual([]);
  });

  it("RLS: a seller cannot update state or write links, nor insert a config for another store", async () => {
    const upd = await as("seller", STORE_A, () => db.query(`UPDATE odoo_channel_configs SET breaker_failures = 9 WHERE store_id = $1`, [STORE_A]));
    expect(upd.affectedRows).toBe(0);
    await expect(as("seller", STORE_A, () => db.query(`INSERT INTO odoo_product_links (channel_id, odoo_product_id, store_id, sku_id) VALUES ($1, 9, $2, $3)`, [U(11), STORE_A, U(23)]))).rejects.toThrow(/row-level security/i);
    await expect(as("seller", STORE_A, () => config(13, STORE_B, 2))).rejects.toThrow(/row-level security|foreign key/i);
    const sys = await as("system", "", () => db.query(`UPDATE odoo_channel_configs SET breaker_failures = 2 WHERE channel_id = $1`, [U(11)]));
    expect(sys.affectedRows).toBe(1);
  });

  it("enforces poll interval bounds, positive uid and one SKU per channel", async () => {
    await expect(db.query(`UPDATE odoo_channel_configs SET poll_interval_s = 10 WHERE channel_id = $1`, [U(11)])).rejects.toThrow(/check/i);
    await expect(db.query(`UPDATE odoo_channel_configs SET odoo_uid = 0 WHERE channel_id = $1`, [U(11)])).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO odoo_product_links (channel_id, odoo_product_id, store_id, sku_id) VALUES ($1, 555, $2, $3)`, [U(11), STORE_A, U(21)])).rejects.toThrow(/unique|duplicate/i);
  });
});
