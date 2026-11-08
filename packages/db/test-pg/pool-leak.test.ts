import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withDbContext } from "../src/index.js";
import { ENABLED, MARKET, pool, seedTenant, sqlClient } from "./helpers.js";
import type { Tenant } from "./helpers.js";

const SETTINGS = ["app.ctx", "app.current_user_id", "app.current_store_id", "app.current_market_id", "app.job"] as const;
const read = `SELECT ${SETTINGS.map((s) => `coalesce(current_setting('${s}', true), '') AS "${s}"`).join(", ")}`;

describe.skipIf(!ENABLED)("withDbContext does not leak across pooled connections (transaction-pooling proof)", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let A: Tenant;
  let B: Tenant;
  beforeAll(async () => {
    admin = pool("DIRECT", 2, "test-admin");
    app = pool("APP", 5, "test-app-leak");
    A = await seedTenant(admin, "leakA");
    B = await seedTenant(admin, "leakB");
  });
  afterAll(async () => {
    await Promise.all([admin.end(), app.end()]);
  });

  it("200 interleaved transactions on a pool of 5: every transaction sees exactly its own context, and nothing survives commit", async () => {
    const c = sqlClient<"outlet_app">(app);
    const bad: string[] = [];
    const run = async (i: number): Promise<void> => {
      const t = i % 2 === 0 ? A : B;
      const store = i % 3 === 0;
      const ctx = store ? ({ kind: "store", marketId: MARKET, storeId: t.storeId, userId: t.userId } as const) : ({ kind: "user", marketId: MARKET, userId: t.userId } as const);
      await withDbContext(c, ctx, async (tx) => {
        await tx.query("SELECT pg_sleep($1)", [Math.random() * 0.02]);
        const s = (await tx.query<Record<string, string>>(read)).rows[0] ?? {};
        if (s["app.current_user_id"] !== t.userId) bad.push(`#${String(i)} user ${String(s["app.current_user_id"])}`);
        if (s["app.current_store_id"] !== (store ? t.storeId : "")) bad.push(`#${String(i)} store ${String(s["app.current_store_id"])}`);
        if (s["app.ctx"] !== ctx.kind) bad.push(`#${String(i)} ctx ${String(s["app.ctx"])}`);
        const lines = (await tx.query<{ user_id: string }>("SELECT user_id FROM cart_lines")).rows;
        if (!lines.every((l) => l.user_id === t.userId)) bad.push(`#${String(i)} saw another user's cart_lines`);
      });
      // Bare statement on the pool (any connection): no setting may have survived the commit.
      const after = (await app.query<Record<string, string>>(read)).rows[0] ?? {};
      for (const k of SETTINGS) if (after[k] !== "") bad.push(`#${String(i)} leaked ${k}=${String(after[k])}`);
    };
    await Promise.all(Array.from({ length: 200 }, (_, i) => run(i)));
    expect(bad).toEqual([]);
  });

  it("a rolled-back transaction leaves no setting behind either", async () => {
    const c = sqlClient<"outlet_app">(app);
    await expect(withDbContext(c, { kind: "user", marketId: MARKET, userId: A.userId }, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const after = (await app.query<Record<string, string>>(read)).rows[0] ?? {};
    expect(after["app.current_user_id"]).toBe("");
  });
});
