import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lintMigration, migrate, parseMigration, withoutConcurrently } from "@outlet/db";

const DIR = new URL("../../../../../../packages/db/migrations/", import.meta.url);
const SQL = readFileSync(fileURLToPath(new URL("0020_returns.sql", DIR)), "utf8");
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LINE = "00000000-0000-4000-9000-000000000001";
const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";
const SNAP = `{"qtyOrdered":2,"unitPrice":"1000","discountAlloc":"0","deliveryFeeAlloc":"0"}`;

let db: PGlite;

const asUser = async <X>(userId: string, fn: () => Promise<X>, opts: { role?: string; stores?: string } = {}): Promise<X> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true), set_config('app.store_ids', $3, true)", [
      userId,
      opts.role ?? "customer",
      opts.stores ?? "",
    ]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const insertReturn = (id: number, userId: number, store: string, over: Record<string, string> = {}) =>
  db.query(
    `INSERT INTO returns (id, user_id, order_line_id, seller_order_id, store_id, qty, reason, resolution, method,
                          shipping_payer, delivered_at, window_ends_at, line_snapshot, idempotency_key, state)
     VALUES ($1, $2, $3, $4, $5, 1, 'changed_mind', 'refund', 'pickup', 'shopper', now(), now() + interval '14 days',
             $6::jsonb, $7, $8)`,
    [U(id), U(userId), LINE, LINE, store, SNAP, `k-${id}`, over.state ?? "REQUESTED"],
  );

const count = async (table: string): Promise<string | undefined> =>
  (await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]?.n;

beforeAll(async () => {
  db = new PGlite();
  // 0020 depends only on 0001-0011 (users, helpers, RLS functions). Other modules' migrations are not needed.
  const names = readdirSync(fileURLToPath(DIR)).filter((f) => /^00(0[1-9]|1[01])_/.test(f)).sort();
  const base = names.map((f) => parseMigration(f, readFileSync(fileURLToPath(new URL(f, DIR)), "utf8")));
  await migrate(withoutConcurrently(db), base);
  await db.exec(SQL);
  await db.exec(`INSERT INTO users (id, status) VALUES ('${U(1)}', 'active'), ('${U(2)}', 'active')`);
  await insertReturn(101, 1, STORE_A);
  await insertReturn(102, 2, STORE_B);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0020_returns", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("enforces enums, quantity, exchange SKU and idempotency uniqueness", async () => {
    await expect(insertReturn(110, 1, STORE_A, { state: "BOGUS" })).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO returns (user_id, order_line_id, seller_order_id, store_id, qty, reason, resolution, method, shipping_payer,
                              delivered_at, window_ends_at, line_snapshot, idempotency_key)
         VALUES ($1, $2, $2, $3, 0, 'changed_mind', 'refund', 'pickup', 'shopper', now(), now(), $4::jsonb, 'q0')`,
        [U(1), LINE, STORE_A, SNAP],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO returns (user_id, order_line_id, seller_order_id, store_id, qty, reason, resolution, method, shipping_payer,
                              delivered_at, window_ends_at, line_snapshot, idempotency_key)
         VALUES ($1, $2, $2, $3, 1, 'too_small', 'exchange', 'pickup', 'shopper', now(), now(), $4::jsonb, 'x1')`,
        [U(1), LINE, STORE_A, SNAP],
      ),
    ).rejects.toThrow(/returns_exchange_sku_chk|check/i);
    await expect(insertReturn(111, 1, STORE_A, {}).then(() => insertReturn(112, 1, STORE_A))).resolves.toBeDefined();
    await expect(
      db.query(`UPDATE returns SET idempotency_key = 'k-101' WHERE id = $1`, [U(112)]),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it("RLS: the shopper sees only their own returns, a store only its own, and nobody anonymous sees any", async () => {
    const mine = await asUser(U(1), async () => (await db.query<{ user_id: string }>("SELECT user_id FROM returns")).rows);
    expect(new Set(mine.map((r) => r.user_id))).toEqual(new Set([U(1)]));
    const other = await asUser(U(2), async () => (await db.query<{ user_id: string }>("SELECT user_id FROM returns")).rows);
    expect(new Set(other.map((r) => r.user_id))).toEqual(new Set([U(2)]));

    const seller = await asUser(U(50), async () => (await db.query<{ store_id: string }>("SELECT store_id FROM returns")).rows, {
      role: "seller",
      stores: STORE_A,
    });
    expect(seller.length).toBeGreaterThan(0);
    expect(new Set(seller.map((r) => r.store_id))).toEqual(new Set([STORE_A]));

    await db.exec("BEGIN");
    await db.exec("SET LOCAL ROLE app_user");
    const none = await count("returns");
    await db.exec("ROLLBACK");
    expect(none).toBe("0");
  });

  it("RLS: a shopper cannot insert for another user or update a return, and a store can only update its own", async () => {
    await expect(asUser(U(2), () => insertReturn(120, 1, STORE_A))).rejects.toThrow(/row-level security/i);
    const shopperUpdate = await asUser(U(1), () => db.query(`UPDATE returns SET note = 'x' WHERE id = $1`, [U(101)]));
    expect(shopperUpdate.affectedRows).toBe(0);
    const foreign = await asUser(U(50), () => db.query(`UPDATE returns SET note = 'x' WHERE id = $1`, [U(102)]), {
      role: "seller",
      stores: STORE_A,
    });
    expect(foreign.affectedRows).toBe(0);
    const own = await asUser(U(50), () => db.query(`UPDATE returns SET note = 'seen' WHERE id = $1`, [U(101)]), {
      role: "seller",
      stores: STORE_A,
    });
    expect(own.affectedRows).toBe(1);
  });

  it("RLS: evidence and disputes follow the parent return", async () => {
    await db.query(`INSERT INTO return_evidence (return_id, upload_id, kind, uploaded_by_type, uploaded_by_id)
                    VALUES ($1, $2, 'shopper_photo', 'shopper', $3)`, [U(101), U(7001), U(1)]);
    await db.query(`INSERT INTO return_disputes (return_id, statement, review_due_at) VALUES ($1, 'unused', now())`, [U(101)]);
    expect(await asUser(U(1), () => count("return_evidence"))).toBe("1");
    expect(await asUser(U(2), () => count("return_evidence"))).toBe("0");
    expect(await asUser(U(1), () => count("return_disputes"))).toBe("1");
    expect(await asUser(U(2), () => count("return_disputes"))).toBe("0");
    await expect(
      db.query(`INSERT INTO return_disputes (return_id, statement, review_due_at) VALUES ($1, 'again', now())`, [U(101)]),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
