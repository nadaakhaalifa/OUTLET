import type { PGlite } from "@electric-sql/pglite";
import { lintMigration } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_SQL, promotionsDatabase } from "./pglite-db";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STORE_A = "00000000-0000-4000-a000-000000000001";
const STORE_B = "00000000-0000-4000-a000-000000000002";
let db: PGlite;

interface Ctx {
  readonly userId?: string;
  readonly role?: string;
  readonly stores?: readonly string[];
}

const as = async <T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> => {
  await db.exec("BEGIN");
  try {
    await db.exec("SET LOCAL ROLE app_user");
    await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true), set_config('app.store_ids', $3, true)", [
      ctx.userId ?? "",
      ctx.role ?? "",
      (ctx.stores ?? []).join(","),
    ]);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
};

const count = async (table: string): Promise<number> =>
  Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]?.n);

const insertPromo = (code: string, store: string | null, createdBy = U(1)) =>
  db.query(
    `INSERT INTO promotions (owner_kind, store_id, kind, scope, code, title_ar, funding_platform_pct, funding_seller_pct,
       percent_bp, starts_at, ends_at, created_by)
     VALUES ($1, $2, 'percent', 'order', $3, 'x', $4, $5, 1000, now(), now() + interval '1 day', $6)`,
    [store === null ? "platform" : "store", store, code, store === null ? 100 : 0, store === null ? 0 : 100, createdBy],
  );

beforeAll(async () => {
  db = await promotionsDatabase();
  await db.exec(`INSERT INTO users (id, status) VALUES ('${U(1)}', 'active'), ('${U(2)}', 'active')`);
  await insertPromo("PLATFORM1", null);
  await insertPromo("STOREA1", STORE_A);
  await insertPromo("STOREB1", STORE_B);
  const p = await db.query<{ id: string }>(`SELECT id::text AS id FROM promotions WHERE code = 'PLATFORM1'`);
  const id = p.rows[0]?.id ?? "";
  await db.query(
    `INSERT INTO promotion_redemptions (promotion_id, promotion_version, user_id, order_group_id, discount_amount,
       platform_funded_amount, seller_funded_amount, day_key) VALUES ($1, 1, $2, $3, 100, 100, 0, '2027-01-01'),
       ($1, 1, $4, $5, 100, 100, 0, '2027-01-01')`,
    [id, U(1), U(11), U(2), U(12)],
  );
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe("0021_promotions", () => {
  it("passes the expand-only migration linter", () => {
    expect(lintMigration(MIGRATION_SQL)).toEqual([]);
  });

  it("RLS promotions: a seller sees only their own store, never platform or other stores", async () => {
    const codes = await as({ userId: U(1), role: "seller", stores: [STORE_A] }, async () =>
      (await db.query<{ code: string }>(`SELECT code FROM promotions ORDER BY code`)).rows.map((r) => r.code),
    );
    expect(codes).toEqual(["STOREA1"]);
  });

  it("RLS promotions: shoppers and anonymous callers see nothing", async () => {
    expect(await as({ userId: U(2), role: "customer" }, () => count("promotions"))).toBe(0);
    expect(await as({}, () => count("promotions"))).toBe(0);
  });

  it("RLS promotions: marketing and ops see platform and store rows; system sees all", async () => {
    expect(await as({ userId: U(1), role: "marketing" }, () => count("promotions"))).toBe(3);
    expect(await as({ userId: U(1), role: "system" }, () => count("promotions"))).toBe(3);
    expect(await as({ userId: U(1), role: "finance" }, () => count("promotions"))).toBe(0);
  });

  it("RLS promotions: a seller cannot write platform rows or another store's rows", async () => {
    const seller = { userId: U(1), role: "seller", stores: [STORE_A] } as const;
    await expect(as(seller, () => insertPromo("PLATFORM2", null))).rejects.toThrow(/row-level security/i);
    await expect(as(seller, () => insertPromo("STOREB2", STORE_B))).rejects.toThrow(/row-level security/i);
    await as(seller, () => insertPromo("STOREA2", STORE_A));
    const upd = await as(seller, () => db.query(`UPDATE promotions SET status = 'paused' WHERE code = 'STOREB1'`));
    expect(upd.affectedRows).toBe(0);
    const own = await as(seller, () => db.query(`UPDATE promotions SET status = 'paused' WHERE code = 'STOREA1'`));
    expect(own.affectedRows).toBe(1);
  });

  it("RLS promotions: a seller cannot move a promotion to another store", async () => {
    const seller = { userId: U(1), role: "seller", stores: [STORE_A] } as const;
    await expect(
      as(seller, () => db.query(`UPDATE promotions SET store_id = $1 WHERE code = 'STOREA1'`, [STORE_B])),
    ).rejects.toThrow();
  });

  it("promotions can never be deleted through the app role", async () => {
    await expect(as({ userId: U(1), role: "marketing" }, () => db.query(`DELETE FROM promotions`))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("RLS redemptions: a shopper reads only their own rows and cannot write", async () => {
    expect(await as({ userId: U(1), role: "customer" }, () => count("promotion_redemptions"))).toBe(1);
    expect(await as({ userId: U(2), role: "customer" }, () => count("promotion_redemptions"))).toBe(1);
    expect(await as({ userId: U(1), role: "system" }, () => count("promotion_redemptions"))).toBe(2);
    const id = (await db.query<{ id: string }>(`SELECT id::text AS id FROM promotions WHERE code = 'PLATFORM1'`)).rows[0]?.id;
    await expect(
      as({ userId: U(1), role: "customer" }, () =>
        db.query(
          `INSERT INTO promotion_redemptions (promotion_id, promotion_version, user_id, order_group_id, discount_amount,
             platform_funded_amount, seller_funded_amount, day_key) VALUES ($1, 1, $2, $3, 1, 1, 0, '2027-01-01')`,
          [id, U(1), U(99)],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission/i);
  });

  it("redemption constraints: funding adds up, once per promotion and order group", async () => {
    const id = (await db.query<{ id: string }>(`SELECT id::text AS id FROM promotions WHERE code = 'PLATFORM1'`)).rows[0]?.id;
    await expect(
      db.query(
        `INSERT INTO promotion_redemptions (promotion_id, promotion_version, user_id, order_group_id, discount_amount,
           platform_funded_amount, seller_funded_amount, day_key) VALUES ($1, 1, $2, $3, 100, 60, 30, '2027-01-01')`,
        [id, U(1), U(50)],
      ),
    ).rejects.toThrow(/funding_ck/);
    await expect(
      db.query(
        `INSERT INTO promotion_redemptions (promotion_id, promotion_version, user_id, order_group_id, discount_amount,
           platform_funded_amount, seller_funded_amount, day_key) VALUES ($1, 1, $2, $3, 100, 100, 0, '2027-01-01')`,
        [id, U(1), U(11)],
      ),
    ).rejects.toThrow(/once_ck|unique|duplicate/i);
  });
});
