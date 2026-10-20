import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { withoutConcurrently, lintMigration, migrate, parseMigration } from "@outlet/db";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SQL = readFileSync(resolve(HERE, "../../../../../packages/db/migrations/0013_stores.sql"), "utf8");

let db: PGlite;
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Ctx { readonly user?: string; readonly role?: string; readonly stores?: readonly string[] }

async function as<T>(ctx: Ctx, fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE app_user");
    await tx.query(`SELECT set_config('app.user_id',$1,true), set_config('app.role',$2,true), set_config('app.store_ids',$3,true)`, [
      ctx.user ?? "", ctx.role ?? "", (ctx.stores ?? []).join(","),
    ]);
    return fn((sql, p) => tx.query<Record<string, unknown>>(sql, p));
  });
}

const insertStore = (n: number, over: { status?: string; kyc?: string; kind?: string } = {}) =>
  db.query(
    `INSERT INTO stores (id, seller_id, kind, slug, name_ar, status, seller_kyc_state)
     VALUES ($1,$2,$3,$4,'متجر',$5,$6)`,
    [U(n), U(900 + n), over.kind ?? "local", `s-${n}`, over.status ?? "ACTIVE", over.kyc ?? "APPROVED"],
  );

beforeAll(async () => {
  // Apply 0001..0013 only. Sibling modules add 0012 and 0014+ in parallel and the shared
  // loader rejects a sequence gap, which this test must not depend on.
  const dir = resolve(HERE, "../../../../../packages/db/migrations");
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && Number(n.slice(0, 4)) <= 13)
    .sort()
    .map((n) => parseMigration(n, readFileSync(resolve(dir, n), "utf8")));
  db = new PGlite();
  await migrate(withoutConcurrently(db), files);
  await db.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [U(1), U(2)]);
  await insertStore(10);
  await insertStore(11, { status: "SUSPENDED" });
  await insertStore(12, { kyc: "SUSPENDED" });
  await insertStore(13, { status: "DRAFT", kyc: "DRAFT" });
  await insertStore(14, { kind: "global", status: "PAUSED" });
  await db.query(`INSERT INTO store_directory_stats (store_id, trending_score) SELECT id, 1 FROM stores`);
}, 60_000);
afterAll(async () => { await db?.close(); });

describe("0013_stores migration", () => {
  it("passes the migration linter (expand only)", () => {
    expect(lintMigration(SQL)).toEqual([]);
  });

  it("is applied by the shared runner", async () => {
    const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM schema_migrations WHERE name = 'stores'`);
    expect(r.rows[0]?.n).toBe("1");
  });

  it("closes the value domains with CHECK constraints", async () => {
    await expect(db.query(`INSERT INTO stores (seller_id, kind, slug, name_ar) VALUES ($1,'mars','x1','م')`, [U(1)])).rejects.toThrow(/check/);
    await expect(db.query(`INSERT INTO stores (seller_id, kind, slug, name_ar) VALUES ($1,'local','Bad Slug','م')`, [U(1)])).rejects.toThrow(/check/);
    await expect(db.query(`INSERT INTO stores (seller_id, kind, slug, name_ar, free_delivery_threshold_amount) VALUES ($1,'local','neg','م',-1)`, [U(1)])).rejects.toThrow(/check/);
    await expect(db.query(`INSERT INTO stores (seller_id, kind, slug, name_ar) VALUES ($1,'local','s-10','م')`, [U(1)])).rejects.toThrow(/duplicate key/);
  });

  it("refuses a seller-supplied discount below 5 or above 100 and a rating without a count", async () => {
    await expect(db.query(`UPDATE store_directory_stats SET max_verified_discount_pct = 4 WHERE store_id = $1`, [U(10)])).rejects.toThrow(/check/);
    await expect(db.query(`UPDATE store_directory_stats SET max_verified_discount_pct = 101 WHERE store_id = $1`, [U(10)])).rejects.toThrow(/check/);
    await expect(db.query(`UPDATE store_directory_stats SET rating_avg = 4.5 WHERE store_id = $1`, [U(10)])).rejects.toThrow(/check/);
    await db.query(`UPDATE store_directory_stats SET max_verified_discount_pct = 40, rating_avg = 4.5, rating_count = 3 WHERE store_id = $1`, [U(10)]);
  });
});

describe("RLS on stores", () => {
  it("shoppers see only trading stores of approved sellers", async () => {
    const ids = await as({ user: U(1), role: "customer" }, async (q) => (await q(`SELECT id FROM stores ORDER BY id`)).rows.map((r) => r.id));
    expect(ids).toEqual([U(10), U(14)]);
  });

  it("no identity means deny by default for user-owned data, and platform roles see everything", async () => {
    const none = await as({}, async (q) => (await q(`SELECT 1 FROM user_favorite_stores`)).rows.length);
    expect(none).toBe(0);
    const all = await as({ user: U(1), role: "ops" }, async (q) => (await q(`SELECT 1 FROM stores`)).rows.length);
    expect(all).toBe(5);
  });

  it("seller staff see their own suspended store but cannot change platform columns", async () => {
    const own = await as({ user: U(1), role: "seller", stores: [U(11)] }, async (q) => (await q(`SELECT status FROM stores WHERE id = $1`, [U(11)])).rows.length);
    expect(own).toBe(1);
    await expect(
      as({ user: U(1), role: "seller", stores: [U(11)] }, (q) => q(`UPDATE stores SET status = 'ACTIVE' WHERE id = $1`, [U(11)])),
    ).rejects.toThrow(/platform-owned store columns/);
    await expect(
      as({ user: U(1), role: "seller", stores: [U(10)] }, (q) => q(`UPDATE stores SET verified_badge = true, health_score = 100 WHERE id = $1`, [U(10)])),
    ).rejects.toThrow(/platform-owned store columns/);
    const edited = await as({ user: U(1), role: "seller", stores: [U(10)] }, async (q) => {
      await q(`UPDATE stores SET name_ar = 'اسم جديد' WHERE id = $1`, [U(10)]);
      return (await q(`SELECT name_ar FROM stores WHERE id = $1`, [U(10)])).rows[0]?.name_ar;
    });
    expect(edited).toBe("اسم جديد");
  });

  it("a seller cannot touch another tenant's store (row invisible, update affects nothing)", async () => {
    const touched = await as({ user: U(1), role: "seller", stores: [U(10)] }, async (q) => {
      const r = await q(`UPDATE stores SET name_ar = 'اختراق' WHERE id = $1 RETURNING id`, [U(14)]);
      return r.rows.length;
    });
    expect(touched).toBe(0);
  });

  it("a shopper cannot insert or lifecycle-change stores", async () => {
    await expect(
      as({ user: U(1), role: "customer" }, (q) => q(`INSERT INTO stores (seller_id, kind, slug, name_ar) VALUES ($1,'local','hack','م')`, [U(1)])),
    ).rejects.toThrow(/row-level security/);
  });

  it("directory stats follow store visibility", async () => {
    const n = await as({ user: U(1), role: "customer" }, async (q) => (await q(`SELECT store_id FROM store_directory_stats`)).rows.length);
    expect(n).toBe(2);
  });
});

describe("user_favorite_stores", () => {
  it("is owner-only: another user sees none and cannot insert for someone else", async () => {
    await as({ user: U(1), role: "customer" }, (q) => q(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,0)`, [U(1), U(10)]));
    const other = await as({ user: U(2), role: "customer" }, async (q) => (await q(`SELECT 1 FROM user_favorite_stores`)).rows.length);
    expect(other).toBe(0);
    await expect(
      as({ user: U(2), role: "customer" }, (q) => q(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,0)`, [U(1), U(14)])),
    ).rejects.toThrow(/row-level security/);
    const staff = await as({ user: U(3), role: "seller", stores: [U(10)] }, async (q) => (await q(`SELECT 1 FROM user_favorite_stores`)).rows.length);
    expect(staff).toBe(0);
  });

  it("caps the list at 30 through the position constraint and keeps positions unique", async () => {
    await expect(db.query(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,30)`, [U(2), U(10)])).rejects.toThrow(/check/);
    await db.query(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,0)`, [U(2), U(10)]);
    await expect(db.query(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,0)`, [U(2), U(14)])).rejects.toThrow(/duplicate key/);
    await expect(db.query(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,1)`, [U(2), U(10)])).rejects.toThrow(/duplicate key/);
  });

  it("allows swapping two positions inside one transaction (deferred uniqueness)", async () => {
    await db.query(`INSERT INTO user_favorite_stores (user_id, store_id, position) VALUES ($1,$2,1)`, [U(2), U(14)]);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE user_favorite_stores SET position = 1 WHERE user_id = $1 AND store_id = $2`, [U(2), U(10)]);
      await tx.query(`UPDATE user_favorite_stores SET position = 0 WHERE user_id = $1 AND store_id = $2`, [U(2), U(14)]);
    });
    const r = await db.query<{ store_id: string }>(`SELECT store_id FROM user_favorite_stores WHERE user_id = $1 ORDER BY position`, [U(2)]);
    expect(r.rows.map((x) => x.store_id)).toEqual([U(14), U(10)]);
  });
});

describe("store_activity_events and legal identity", () => {
  it("activity events are append-only", async () => {
    await db.query(`INSERT INTO store_activity_events (store_id, kind, occurred_at) VALUES ($1,'product_published', now())`, [U(10)]);
    await expect(db.query(`UPDATE store_activity_events SET kind = 'drop_scheduled'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM store_activity_events`)).rejects.toThrow(/append-only/);
    await expect(db.query(`INSERT INTO store_activity_events (store_id, kind, occurred_at) VALUES ($1,'bogus', now())`, [U(10)])).rejects.toThrow(/check/);
  });

  it("legal identity needs an Arabic name and a governorate and is readable only with its visible store", async () => {
    await expect(db.query(`INSERT INTO store_legal_identity_public (store_id, legal_name_ar, governorate) VALUES ($1,' ','القاهرة')`, [U(10)])).rejects.toThrow(/check/);
    await db.query(`INSERT INTO store_legal_identity_public (store_id, legal_name_ar, governorate) VALUES ($1,'شركة','القاهرة'), ($2,'شركة 2','الجيزة')`, [U(10), U(11)]);
    const n = await as({ user: U(1), role: "customer" }, async (q) => (await q(`SELECT store_id FROM store_legal_identity_public`)).rows.map((r) => r.store_id));
    expect(n).toEqual([U(10)]);
  });
});
