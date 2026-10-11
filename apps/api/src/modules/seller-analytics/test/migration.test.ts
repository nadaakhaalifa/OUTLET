import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);
const SQL = readFileSync(fileURLToPath(new URL("0028_seller_analytics.sql", DIR)), "utf8");
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

const view = (id: number, store: string) =>
  db.query(
    `INSERT INTO seller_analytics_facts (message_id, store_id, kind, occurred_at, product_id, shopper_key)
     VALUES ($1, $2, 'view', now(), $3, 'pseudonym-0001')`,
    [U(id), store, U(1)],
  );
const count = async (t: string) => (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`)).rows[0]?.n;

beforeAll(async () => {
  db = new PGlite();
  const names = readdirSync(fileURLToPath(DIR)).filter((f) => /^00(0[1-9]|1[01])_/.test(f)).sort();
  await migrate(withoutConcurrently(db), names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8"))));
  await db.exec(SQL);
  await view(1, STORE_A);
  await view(2, STORE_B);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0028_seller_analytics", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("has no shopper identity, measurement or budget columns", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name like 'seller_analytics_%'`,
    );
    const names = cols.rows.map((c) => c.column_name);
    expect(names).toContain("shopper_key");
    expect(names.filter((n) => /user_id|measure|budget|waist|bust|hip|device|phone|email|address/.test(n))).toEqual([]);
  });

  it("RLS: a seller sees only their store; another store and anonymous see nothing of it", async () => {
    const mine = await as("seller", STORE_A, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM seller_analytics_facts")).rows);
    expect(mine.map((r) => r.store_id)).toEqual([STORE_A]);
    const other = await as("seller", STORE_B, async () => (await db.query<{ store_id: string }>("SELECT store_id FROM seller_analytics_facts")).rows);
    expect(other.map((r) => r.store_id)).toEqual([STORE_B]);
    expect(await as("seller", "", () => count("seller_analytics_facts"))).toBe("0");
    expect(await as("seller", STORE_A, () => count("seller_analytics_stock"))).toBe("0");
  });

  it("RLS: a seller cannot write; only the system role can", async () => {
    await expect(as("seller", STORE_A, () => view(10, STORE_A))).rejects.toThrow(/row-level security/i);
    await expect(as("seller", STORE_A, () => view(11, STORE_B))).rejects.toThrow(/row-level security/i);
    await expect(as("system", "", () => view(12, STORE_A))).resolves.toBeDefined();
    const upd = await as("seller", STORE_A, () =>
      db.query(`UPDATE seller_analytics_freshness SET last_ingest_at = now() WHERE store_id = $1`, [STORE_A]),
    );
    expect(upd.affectedRows).toBe(0);
  });

  it("enforces row shape and money checks", async () => {
    await expect(
      db.query(
        `INSERT INTO seller_analytics_facts (message_id, store_id, kind, occurred_at, product_id, sku_id, qty, gross_minor, commission_minor, seller_order_id)
         VALUES ($1, $2, 'purchase', now(), $3, $3, 1, 100, 200, $3)`,
        [U(20), STORE_A, U(1)],
      ),
    ).rejects.toThrow(/check/i);
    await expect(db.query(`INSERT INTO seller_analytics_facts (message_id, store_id, kind, occurred_at) VALUES ($1, $2, 'bogus', now())`, [U(21), STORE_A])).rejects.toThrow();
    await expect(view(1, STORE_A)).rejects.toThrow(/unique|duplicate/i);
  });
});
