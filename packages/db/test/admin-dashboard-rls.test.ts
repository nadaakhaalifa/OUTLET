import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDbContext } from "../src/index.js";
import type { DbContext, WorkerJob } from "../src/index.js";
import type { SqlClient } from "../src/sql.js";
import { asRole, createTestClient } from "../src/testing.js";

// Migration 0035: the three rollup tables are readable only through the `admin.dashboard` job (SELECT) and written only by `reporting.rollup`,
// always pinned to the market; outlet_app, outlet_auth and every other job see nothing. The 14 source tables are read by `reporting.rollup` only.

const TABLES = ["market_sales_daily", "store_sales_daily", "admin_dashboard_snapshots"] as const;
const SOURCES = ["order_groups", "seller_orders", "refunds", "payouts", "payout_holds", "return_requests", "disputes", "privacy_requests", "enforcement_actions", "price_claims", "products", "skus", "stores", "reconciliation_exceptions"] as const;
const worker = (job: WorkerJob, marketId = "EG"): DbContext => ({ kind: "worker", marketId, job });

let c: SqlClient;
let close: () => Promise<void>;
const STORE = randomUUID();
const STORE_AE = randomUUID();

const asWorker = <T>(ctx: DbContext, fn: (q: (sql: string, p?: unknown[]) => Promise<number>) => Promise<T>): Promise<T> =>
  asRole(c, "outlet_worker", async (tx) => {
    await applyDbContext(tx, ctx);
    return fn(async (sql, p) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, p)).rows[0]?.n ?? -1);
  });

beforeAll(async () => {
  ({ client: c, close } = await createTestClient());
  const sellers: [string, string][] = [[randomUUID(), "EG"], [randomUUID(), "AE"]];
  for (const [id, m] of sellers) await c.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type, status) VALUES ($1,$2,$2,'company','draft')", [id, m]);
  await c.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1,$2,'EG','eg-store','متجر','local','EG')", [STORE, sellers[0]?.[0]]);
  await c.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1,$2,'AE','ae-store','متجر','local','AE')", [STORE_AE, sellers[1]?.[0]]);
  for (const [m, s] of [["EG", STORE], ["AE", STORE_AE]] as const) {
    await c.query("INSERT INTO market_sales_daily VALUES ($1,'2026-11-09','EGP',3,30000,0,now())", [m]);
    await c.query("INSERT INTO store_sales_daily VALUES ($1,$2,'2026-11-09','EGP',3,30000,'متجر',NULL,now())", [m, s]);
    await c.query("INSERT INTO admin_dashboard_snapshots VALUES ($1,'orders_by_step',now(),'{}'::jsonb,1)", [m]);
  }
});
afterAll(async () => close());

describe("admin dashboard rollup tables (migration 0035)", () => {
  for (const t of TABLES) {
    it(`${t}: admin.dashboard and reporting.rollup read only their own market`, async () => {
      for (const job of ["admin.dashboard", "reporting.rollup"] as const) {
        expect(await asWorker(worker(job), (q) => q(`SELECT 1 FROM ${t}`))).toBe(1);
        expect(await asWorker(worker(job, "AE"), (q) => q(`SELECT 1 FROM ${t}`))).toBe(1);
        expect(await asWorker(worker(job, "ZZ"), (q) => q(`SELECT 1 FROM ${t}`))).toBe(0);
      }
    });
    it(`${t}: any other job and a user context read nothing`, async () => {
      for (const job of ["ops.attention", "finance.reconcile", "notifications.dispatch", "seller.kyc"] as const) {
        expect(await asWorker(worker(job), (q) => q(`SELECT 1 FROM ${t}`))).toBe(0);
      }
      await expect(asRole(c, "outlet_app", async (tx) => {
        await applyDbContext(tx, { kind: "user", marketId: "EG" });
        return tx.query(`SELECT 1 FROM ${t}`);
      })).rejects.toThrow(/permission denied/);
      await expect(asRole(c, "outlet_auth", (tx) => tx.query(`SELECT 1 FROM ${t}`))).rejects.toThrow(/permission denied/);
    });
    it(`${t}: admin.dashboard cannot write, reporting.rollup cannot write another market and cannot delete`, async () => {
      const row: Record<string, string> = {
        market_sales_daily: "UPDATE market_sales_daily SET gmv_minor = 1",
        store_sales_daily: "UPDATE store_sales_daily SET gmv_minor = 1",
        admin_dashboard_snapshots: "UPDATE admin_dashboard_snapshots SET version = version + 1",
      };
      const upd = row[t] ?? "";
      // admin.dashboard: the UPDATE matches no row (no UPDATE policy) and nothing changed.
      await asRole(c, "outlet_worker", async (tx) => {
        await applyDbContext(tx, worker("admin.dashboard"));
        expect((await tx.query(`${upd} RETURNING 1`)).rows).toHaveLength(0);
      });
      await asRole(c, "outlet_worker", async (tx) => {
        await applyDbContext(tx, worker("reporting.rollup"));
        const r = await tx.query(`${upd} RETURNING market_id`);
        expect(r.rows).toEqual([{ market_id: "EG" }]);
      });
      await expect(asRole(c, "outlet_worker", async (tx) => {
        await applyDbContext(tx, worker("reporting.rollup"));
        await tx.query(`DELETE FROM ${t}`);
      })).rejects.toThrow(/permission denied/);
    });
  }

  it("reporting.rollup cannot insert a row for another market (WITH CHECK)", async () => {
    await expect(asRole(c, "outlet_worker", async (tx) => {
      await applyDbContext(tx, worker("reporting.rollup"));
      await tx.query("INSERT INTO admin_dashboard_snapshots VALUES ('AE','kyc_queue',now(),'{}'::jsonb,1)");
    })).rejects.toThrow(/row-level security/);
  });

  it("the payload must be a JSON object and the tile key a slug", async () => {
    await expect(c.query("INSERT INTO admin_dashboard_snapshots VALUES ('EG','x',now(),'[]'::jsonb,1)")).rejects.toThrow(/check/);
    await expect(c.query("INSERT INTO admin_dashboard_snapshots VALUES ('EG','Bad Key',now(),'{}'::jsonb,1)")).rejects.toThrow(/check/);
  });

  for (const t of SOURCES) {
    it(`${t}: reporting.rollup may select (market pinned); the dashboard job and others may not`, async () => {
      expect(await asWorker(worker("reporting.rollup", "ZZ"), (q) => q(`SELECT 1 FROM ${t}`))).toBe(0);
      // The tables are empty in this fixture except stores: the point is the policy exists and answers, not the row count.
      await expect(asWorker(worker("reporting.rollup"), (q) => q(`SELECT 1 FROM ${t} LIMIT 1`))).resolves.toBeGreaterThanOrEqual(0);
      expect(await asWorker(worker("admin.dashboard"), (q) => q(`SELECT 1 FROM ${t}`))).toBe(0);
    });
  }

  it("stores: reporting.rollup sees only its market's store; admin.dashboard sees none", async () => {
    expect(await asWorker(worker("reporting.rollup"), (q) => q("SELECT id FROM stores"))).toBe(1);
    expect(await asWorker(worker("admin.dashboard"), (q) => q("SELECT id FROM stores"))).toBe(0);
  });

  it("breach_records is readable by the worker role only through the narrow column grant (no summary)", async () => {
    await asWorker(worker("reporting.rollup"), (q) => q("SELECT market_id, status, pdpc_deadline_at, pdpc_notified_at, subjects_deadline_at, subjects_notified_at FROM breach_records"));
    await expect(asWorker(worker("reporting.rollup"), (q) => q("SELECT summary FROM breach_records"))).rejects.toThrow(/permission denied/);
  });
});
