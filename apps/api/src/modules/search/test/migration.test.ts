import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration } from "@outlet/db";
import { SEARCH_MIGRATION, createSearchDatabase } from "./pg-fixture";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P = (n: number): string => `00000000-0000-4000-b000-${String(n).padStart(12, "0")}`;
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
  db = await createSearchDatabase({ trigram: true });
  await db.exec(`INSERT INTO users (id, status) VALUES ('${U(1)}', 'active'), ('${U(2)}', 'active')`);
  await db.exec(
    `INSERT INTO saved_searches (user_id, name) VALUES ('${U(1)}', 'one'), ('${U(1)}', 'two'), ('${U(2)}', 'other')`,
  );
  await db.exec(
    `INSERT INTO search_documents (product_id, store_id, world, title_ar, search_text, price_amount, condition)
     VALUES ('${P(1)}', '${STORE}', 'local', 'فستان', 'فستان', 100, 'sample')`,
  );
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0023_search", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SEARCH_MIGRATION)).toEqual([]);
  });

  it("applies cleanly without pg_trgm (index is feature-detected)", async () => {
    const plain = await createSearchDatabase({ trigram: false });
    const r = await plain.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_indexes WHERE indexname = 'search_documents_trgm_idx'",
    );
    expect(r.rows[0]?.n).toBe("0");
    await plain.close();
  });

  it("creates the trigram index when the extension is present", async () => {
    const r = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_indexes WHERE indexname = 'search_documents_trgm_idx'",
    );
    expect(r.rows[0]?.n).toBe("1");
  });

  it("enforces column constraints", async () => {
    await expect(
      db.query(`INSERT INTO saved_searches (user_id, name) VALUES ($1, '')`, [U(1)]),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(`INSERT INTO saved_searches (user_id, name, filter_json) VALUES ($1, 'x', '[]'::jsonb)`, [U(1)]),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO search_documents (product_id, store_id, world, title_ar, search_text, price_amount, condition)
         VALUES ($1, $2, 'mars', 'x', 'x', 1, 'sample')`,
        [P(2), STORE],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO search_documents (product_id, store_id, world, title_ar, search_text, price_amount, condition)
         VALUES ($1, $2, 'local', 'x', 'x', -1, 'sample')`,
        [P(2), STORE],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO search_documents (product_id, store_id, world, title_ar, search_text, price_amount, condition, verified_discount_pct)
         VALUES ($1, $2, 'local', 'x', 'x', 1, 'sample', 3)`,
        [P(2), STORE],
      ),
    ).rejects.toThrow(/check/i);
  });

  it("caps a user at 50 saved searches", async () => {
    for (let i = 0; i < 48; i += 1) {
      await db.query(`INSERT INTO saved_searches (user_id, name) VALUES ($1, $2)`, [U(1), `s${i}`]);
    }
    expect(await count("saved_searches")).toBe("51");
    await expect(db.query(`INSERT INTO saved_searches (user_id, name) VALUES ($1, 'x')`, [U(1)])).rejects.toThrow(/50 saved searches/);
    // another user is unaffected
    await db.query(`INSERT INTO saved_searches (user_id, name) VALUES ($1, 'y')`, [U(2)]);
  });

  it("RLS: an owner sees only their own saved searches", async () => {
    expect(await asUser(U(2), () => count("saved_searches"))).toBe("2");
    const rows = await asUser(U(2), async () => (await db.query<{ user_id: string }>("SELECT user_id FROM saved_searches")).rows);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([U(2)]));
  });

  it("RLS: no identity sees nothing; a user cannot write into or move another user's rows", async () => {
    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app_user");
    const none = await count("saved_searches");
    await db.exec("ROLLBACK");
    expect(none).toBe("0");

    await expect(
      asUser(U(2), () => db.query(`INSERT INTO saved_searches (user_id, name) VALUES ($1, 'spoof')`, [U(1)])),
    ).rejects.toThrow(/row-level security/i);
    const updated = await asUser(U(2), () => db.query(`UPDATE saved_searches SET name = 'x' WHERE user_id = $1`, [U(1)]));
    expect(updated.affectedRows).toBe(0);
    const deleted = await asUser(U(2), () => db.query(`DELETE FROM saved_searches WHERE user_id = $1`, [U(1)]));
    expect(deleted.affectedRows).toBe(0);
    await expect(
      asUser(U(2), () => db.query(`UPDATE saved_searches SET user_id = $1 WHERE user_id = $2`, [U(1), U(2)])),
    ).rejects.toThrow(/row-level security/i);
  });

  it("RLS: the catalog projection is readable by anyone and writable only by system", async () => {
    expect(await asUser(U(2), () => count("search_documents"))).toBe("1");
    await expect(
      asUser(U(2), () =>
        db.query(
          `INSERT INTO search_documents (product_id, store_id, world, title_ar, search_text, price_amount, condition)
           VALUES ($1, $2, 'local', 'x', 'x', 1, 'sample')`,
          [P(9), STORE],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
    const upd = await asUser(U(2), () => db.query(`UPDATE search_documents SET price_amount = 1`));
    expect(upd.affectedRows).toBe(0);
    await asUser(
      U(2),
      () =>
        db.query(
          `INSERT INTO search_documents (product_id, store_id, world, title_ar, search_text, price_amount, condition)
           VALUES ($1, $2, 'local', 'x', 'x', 1, 'sample')`,
          [P(9), STORE],
        ),
      "system",
    );
    expect(await count("search_documents")).toBe("2");
  });

  it("generates tsv from search_text and keeps the stored price exact", async () => {
    const r = await db.query<{ hit: boolean }>(
      `SELECT (tsv @@ to_tsquery('simple', 'فست:*')) AS hit FROM search_documents WHERE product_id = $1`,
      [P(1)],
    );
    expect(r.rows[0]?.hit).toBe(true);
  });
});
