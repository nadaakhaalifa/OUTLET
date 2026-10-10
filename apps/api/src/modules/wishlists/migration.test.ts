import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @electric-sql/pglite is a dependency of packages/db, not of apps/api (no new packages may be
// added in this wave), so it is reached through packages/db's own installation.
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, type MigrationFile, withoutConcurrently } from "@outlet/db";

const DIR = fileURLToPath(new URL("../../../../../packages/db/migrations/", import.meta.url));
const MINE = "0014_wishlists.sql";
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (n: number): Uint8Array => new Uint8Array(32).fill(n);

let db: PGlite;

/** Other agents own 0012 and 0013 in this wave, so the sequence has a gap here; apply 0001..0011 then 0014. */
function dependencies(): MigrationFile[] {
  return readdirSync(DIR)
    .filter((n) => n.endsWith(".sql") && (Number(n.slice(0, 4)) <= 11 || n === MINE))
    .sort()
    .map((n) => parseMigration(n, readFileSync(join(DIR, n), "utf8")));
}

beforeAll(async () => {
  db = new PGlite();
  await migrate(withoutConcurrently(db), dependencies());
  await db.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [U(1), U(2)]);
}, 60_000);
afterAll(async () => {
  await db.close();
});

const asUser = async <T>(user: string | null, role: string, fn: (q: PGlite) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_user");
    await tx.query(`SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)`, [user ?? "", role]);
    return fn(tx as unknown as PGlite);
  });

describe("0014_wishlists", () => {
  it("passes the migration linter", () => {
    const sql = readFileSync(join(DIR, MINE), "utf8");
    expect(lintMigration(sql)).toEqual([]);
  });

  it("enforces intent, gift, cool-off and share consistency", async () => {
    const ins = (cols: string, vals: unknown[]) =>
      db.query(`INSERT INTO wishlists (user_id, ${cols}) VALUES ($1, ${vals.map((_, i) => `$${i + 2}`).join(",")})`, [
        U(1),
        ...vals,
      ]);
    await ins("intent, title", ["need", "ok"]);
    await expect(ins("intent, title", ["wedding", "x"])).rejects.toThrow(/check/);
    await expect(ins("intent, title", ["need", ""])).rejects.toThrow(/check/);
    await expect(ins("intent, title, cool_off_enabled", ["treat", "x", true])).rejects.toThrow(/cool_off_want_only/);
    await ins("intent, title, cool_off_enabled", ["want", "x", true]);
    await expect(ins("intent, title", ["gift_for_someone", "x"])).rejects.toThrow(/gift_for_intent/);
    await expect(ins("intent, title, gift_nickname", ["need", "x", "Sara"])).rejects.toThrow(/gift_for_intent/);
    await ins("intent, title, gift_nickname", ["gift_for_someone", "x", "Sara"]);
    await expect(ins("intent, title, budget_amount, budget_currency", ["need", "x", 0, "EGP"])).rejects.toThrow(/check/);
    await expect(ins("intent, title, budget_amount", ["need", "x", 100])).rejects.toThrow(/budget_pair/);
    await expect(ins("intent, title, share_token_hash", ["need", "x", sha(1)])).rejects.toThrow(/share_consistent/);
    await ins("intent, title, share_token_hash, share_created_at", ["need", "x", sha(2), new Date().toISOString()]);
    await expect(
      ins("intent, title, share_token_hash, share_created_at", ["need", "x", sha(2), new Date().toISOString()]),
    ).rejects.toThrow(/share_token_uq|unique/);
  });

  it("keeps items unique per product and size, and cascades on list delete", async () => {
    const w = await db.query<{ id: string }>(
      `INSERT INTO wishlists (user_id, intent, title) VALUES ($1, 'custom', 'items') RETURNING id`,
      [U(1)],
    );
    const id = w.rows[0]?.id ?? "";
    const item = (sku: string | null, user = U(1)) =>
      db.query(
        `INSERT INTO wishlist_items (wishlist_id, user_id, product_id, sku_pref_id, added_amount) VALUES ($1,$2,$3,$4,100)`,
        [id, user, U(50), sku],
      );
    await item(null);
    await expect(item(null)).rejects.toThrow(/unique/);
    await item(U(60));
    await expect(item(U(60))).rejects.toThrow(/unique/);
    // the denormalised owner must match the list's owner
    await expect(item(U(61), U(2))).rejects.toThrow(/owner_fk|foreign key/);
    await db.query(`INSERT INTO wishlist_alert_dedupe (dedupe_key, wishlist_id) VALUES ('k1', $1)`, [id]);
    await db.query(`DELETE FROM wishlists WHERE id = $1`, [id]);
    const left = await db.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM wishlist_items WHERE wishlist_id=$1)::text || ',' ||
              (SELECT count(*) FROM wishlist_alert_dedupe WHERE wishlist_id=$1)::text AS n`,
      [id],
    );
    expect(left.rows[0]?.n).toBe("0,0");
  });

  it("applies row level security: owner only, deny by default, system for jobs", async () => {
    const w = await db.query<{ id: string }>(
      `INSERT INTO wishlists (user_id, intent, title) VALUES ($1, 'custom', 'rls') RETURNING id`,
      [U(1)],
    );
    const id = w.rows[0]?.id ?? "";
    await db.query(
      `INSERT INTO wishlist_items (wishlist_id, user_id, product_id, added_amount) VALUES ($1,$2,$3,5)`,
      [id, U(1), U(70)],
    );
    const count = (user: string | null, role: string, table: string) =>
      asUser(user, role, async (q) => Number((await q.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${table === "wishlists" ? "id" : "wishlist_id"} = $1`, [id])).rows[0]?.n));
    expect(await count(U(1), "customer", "wishlists")).toBe(1);
    expect(await count(U(2), "customer", "wishlists")).toBe(0);
    expect(await count(null, "customer", "wishlists")).toBe(0);
    expect(await count(U(1), "customer", "wishlist_items")).toBe(1);
    expect(await count(U(2), "customer", "wishlist_items")).toBe(0);
    expect(await count(null, "system", "wishlists")).toBe(1);
    // another user cannot update or delete it, and cannot insert on someone else's behalf
    const upd = await asUser(U(2), "customer", (q) => q.query(`UPDATE wishlists SET title='x' WHERE id=$1 RETURNING id`, [id]));
    expect(upd.rows).toHaveLength(0);
    const del = await asUser(U(2), "customer", (q) => q.query(`DELETE FROM wishlists WHERE id=$1 RETURNING id`, [id]));
    expect(del.rows).toHaveLength(0);
    await expect(
      asUser(U(2), "customer", (q) => q.query(`INSERT INTO wishlists (user_id, intent, title) VALUES ($1,'need','x')`, [U(1)])),
    ).rejects.toThrow(/row-level security/);
    // dedupe table: system only
    await expect(
      asUser(U(1), "customer", (q) => q.query(`INSERT INTO wishlist_alert_dedupe (dedupe_key, wishlist_id) VALUES ('rls-k', $1)`, [id])),
    ).rejects.toThrow(/row-level security/);
    await asUser(null, "system", (q) => q.query(`INSERT INTO wishlist_alert_dedupe (dedupe_key, wishlist_id) VALUES ('rls-k', $1)`, [id]));
    expect(await count(U(1), "customer", "wishlist_alert_dedupe")).toBe(0);
  });
});
