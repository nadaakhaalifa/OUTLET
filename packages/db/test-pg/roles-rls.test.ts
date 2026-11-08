import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRuntimeRole, withDbContext } from "../src/index.js";
import type { DbRole } from "../src/index.js";
import { ENABLED, MARKET, pool, seedTenant, sqlClient } from "./helpers.js";
import type { Tenant } from "./helpers.js";

describe.skipIf(!ENABLED)("real roles: assertRuntimeRole and RLS isolation over two real connections", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let auth: pg.Pool;
  let worker: pg.Pool;
  let A: Tenant;
  let B: Tenant;
  beforeAll(async () => {
    admin = pool("DIRECT", 2, "test-admin");
    app = pool("APP", 4, "test-app");
    auth = pool("AUTH", 2, "test-auth");
    worker = pool("WORKER", 2, "test-worker");
    A = await seedTenant(admin, "A");
    B = await seedTenant(admin, "B");
  });
  afterAll(async () => {
    await Promise.all([admin.end(), app.end(), auth.end(), worker.end()]);
  });

  it.each([["outlet_app"], ["outlet_auth"], ["outlet_worker"]] as const)("assertRuntimeRole passes for the real %s", async (role: DbRole) => {
    const p = role === "outlet_app" ? app : role === "outlet_auth" ? auth : worker;
    await expect(assertRuntimeRole(sqlClient(p), role)).resolves.toBeUndefined();
  });

  it("assertRuntimeRole fails for the migrator, a superuser, and a role pool checked against the wrong role", async () => {
    if (process.env.DATABASE_URL_MIGRATOR) {
      const m = pool("MIGRATOR", 1, "test-migrator");
      try {
        await expect(assertRuntimeRole(sqlClient(m), "outlet_app")).rejects.toThrow(/outlet_migrator|owns relations|CREATEROLE/);
      } finally {
        await m.end();
      }
    }
    await expect(assertRuntimeRole(sqlClient(admin), "outlet_app")).rejects.toThrow();
    await expect(assertRuntimeRole(sqlClient(app), "outlet_worker")).rejects.toThrow(/connected as outlet_app/);
  });

  const userCtx = (t: Tenant) => ({ kind: "user", marketId: MARKET, userId: t.userId }) as const;
  const storeCtx = (t: Tenant) => ({ kind: "store", marketId: MARKET, storeId: t.storeId, userId: t.userId }) as const;

  it("two real connections: store A and store B each see only their own products and store_members", async () => {
    const c = sqlClient<"outlet_app">(app);
    const [a, b] = await Promise.all([
      withDbContext(c, storeCtx(A), async (tx) => ({
        products: (await tx.query<{ store_id: string }>("SELECT store_id FROM products")).rows,
        members: (await tx.query<{ store_id: string }>("SELECT store_id FROM store_members")).rows,
        pid: (await tx.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()")).rows[0]?.pg_backend_pid,
        crossProduct: (await tx.query("SELECT 1 FROM products WHERE id = $1", [B.productIds[0]])).rows.length,
      })),
      withDbContext(c, storeCtx(B), async (tx) => ({
        products: (await tx.query<{ store_id: string }>("SELECT store_id FROM products")).rows,
        members: (await tx.query<{ store_id: string }>("SELECT store_id FROM store_members")).rows,
        pid: (await tx.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()")).rows[0]?.pg_backend_pid,
        crossProduct: (await tx.query("SELECT 1 FROM products WHERE id = $1", [A.productIds[0]])).rows.length,
      })),
    ]);
    expect(a.products.length).toBeGreaterThanOrEqual(3);
    expect(a.products.every((r) => r.store_id === A.storeId)).toBe(true);
    expect(b.products.every((r) => r.store_id === B.storeId)).toBe(true);
    expect(a.members.map((r) => r.store_id)).toEqual([A.storeId]);
    expect(b.members.map((r) => r.store_id)).toEqual([B.storeId]);
    expect(a.crossProduct).toBe(0);
    expect(b.crossProduct).toBe(0);
  });

  it("user A and user B each see only their own cart_lines and order_groups; cross-tenant writes touch nothing", async () => {
    const c = sqlClient<"outlet_app">(app);
    const view = (t: Tenant) =>
      withDbContext(c, userCtx(t), async (tx) => ({
        lines: (await tx.query<{ user_id: string }>("SELECT user_id FROM cart_lines")).rows,
        groups: (await tx.query<{ id: string }>("SELECT id FROM order_groups")).rows,
      }));
    const [a, b] = await Promise.all([view(A), view(B)]);
    expect(a.lines.every((r) => r.user_id === A.userId) && a.lines.length >= 1).toBe(true);
    expect(b.lines.every((r) => r.user_id === B.userId) && b.lines.length >= 1).toBe(true);
    expect(a.groups.map((r) => r.id)).toEqual([A.orderGroupId]);
    expect(b.groups.map((r) => r.id)).toEqual([B.orderGroupId]);
    const touched = await withDbContext(c, userCtx(A), async (tx) => (await tx.query("UPDATE cart_lines SET qty = 2 WHERE user_id = $1 RETURNING id", [B.userId])).rows.length);
    expect(touched).toBe(0);
    const intact = await admin.query<{ qty: number }>("SELECT qty FROM cart_lines WHERE user_id = $1", [B.userId]);
    expect(intact.rows.every((r) => r.qty === 1)).toBe(true);
  });

  it("without a bound context nothing is visible", async () => {
    const r = await app.query("SELECT 1 FROM products");
    expect(r.rows.length).toBe(0);
  });
});
