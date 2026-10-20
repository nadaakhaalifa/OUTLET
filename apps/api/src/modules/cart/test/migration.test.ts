import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const SQL = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/db/migrations/0015_cart.sql", import.meta.url)),
  "utf8",
);
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SKU = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const STORE = "00000000-0000-4000-a000-000000000001";

let db: PGlite;

const asUser = async <T>(userId: string, fn: () => Promise<T>, role = "customer"): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)", [userId, role]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const count = async (table: string): Promise<string | undefined> =>
  (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]?.n;

beforeAll(async () => {
  db = new PGlite();
  // 0012-0014 belong to other modules; this migration depends only on 0001-0011.
  // loadMigrations() rejects directory gaps, so read the first eleven files directly.
  const dir = new URL("../../../../../../packages/db/migrations/", import.meta.url);
  const names = readdirSync(fileURLToPath(dir)).filter((f) => /^00(0[1-9]|1[01])_/.test(f)).sort();
  const base = names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, dir)), "utf8")));
  await migrate(withoutConcurrently(db), base);
  await db.exec(SQL);
  await db.exec(`INSERT INTO users (id, status) VALUES ('${U(1)}', 'active'), ('${U(2)}', 'active')`);
  await db.exec(`INSERT INTO carts (id, user_id) VALUES ('${U(101)}', '${U(1)}'), ('${U(102)}', '${U(2)}')`);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0015_cart", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("enforces quantity, price and uniqueness constraints", async () => {
    const ins = (sku: number, qty: number, price: number) =>
      db.query(
        `INSERT INTO cart_lines (cart_id, sku_id, store_id, qty, price_at_add_amount) VALUES ($1,$2,$3,$4,$5)`,
        [U(102), SKU(sku), STORE, qty, price],
      );
    await expect(ins(1, 0, 100)).rejects.toThrow();
    await expect(ins(1, 11, 100)).rejects.toThrow();
    await expect(ins(1, 1, -1)).rejects.toThrow();
    await ins(1, 10, 0);
    await expect(ins(1, 1, 100)).rejects.toThrow(/unique|duplicate/i);
  });

  it("caps a bag at 50 lines", async () => {
    for (let i = 1; i <= 50; i += 1) {
      await db.query(
        `INSERT INTO cart_lines (cart_id, sku_id, store_id, qty, price_at_add_amount) VALUES ($1,$2,$3,1,100)`,
        [U(101), SKU(1000 + i), STORE],
      );
    }
    await expect(
      db.query(`INSERT INTO cart_lines (cart_id, sku_id, store_id, qty, price_at_add_amount) VALUES ($1,$2,$3,1,100)`, [
        U(101),
        SKU(2000),
        STORE,
      ]),
    ).rejects.toThrow(/50 lines/);
  });

  it("RLS: an owner sees only their own bag and lines", async () => {
    expect(await asUser(U(1), () => count("cart_lines"))).toBe("50");
    expect(await asUser(U(2), () => count("cart_lines"))).toBe("1");
    const carts = await asUser(U(2), async () => (await db.query<{ user_id: string }>("SELECT user_id FROM carts")).rows);
    expect(carts.map((c) => c.user_id)).toEqual([U(2)]);
  });

  it("RLS: no identity sees nothing; a user cannot write into or move rows from another bag", async () => {
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app_user");
    const none = await count("carts");
    await db.exec("ROLLBACK");
    expect(none).toBe("0");

    await expect(
      asUser(U(2), () =>
        db.query(`INSERT INTO cart_lines (cart_id, sku_id, store_id, qty, price_at_add_amount) VALUES ($1,$2,$3,1,100)`, [
          U(101),
          SKU(3000),
          STORE,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);

    const updated = await asUser(U(2), () => db.query(`UPDATE cart_lines SET qty = 5 WHERE cart_id = $1`, [U(101)]));
    expect(updated.affectedRows).toBe(0);
    const deleted = await asUser(U(2), () => db.query(`DELETE FROM carts WHERE id = $1`, [U(101)]));
    expect(deleted.affectedRows).toBe(0);
    await expect(
      asUser(U(2), () => db.query(`UPDATE cart_lines SET cart_id = $1 WHERE cart_id = $2`, [U(101), U(102)])),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an owner can write their own lines through the app role", async () => {
    await asUser(U(2), () =>
      db.query(`INSERT INTO cart_lines (cart_id, sku_id, store_id, qty, price_at_add_amount) VALUES ($1,$2,$3,2,500)`, [
        U(102),
        SKU(4000),
        STORE,
      ]),
    );
    expect(await asUser(U(2), () => count("cart_lines"))).toBe("2");
  });
});
