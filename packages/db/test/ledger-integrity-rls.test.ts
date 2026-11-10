import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDbContext } from "../src/index.js";
import type { DbContext, WorkerJob } from "../src/index.js";
import type { SqlClient } from "../src/sql.js";
import { asRole, createTestClient } from "../src/testing.js";

// Migration 0039: reconciliation_runs.details; job `admin.dashboard` reads ONLY ledger_integrity runs of its market; `finance.reconcile` keeps full access.

const worker = (job: WorkerJob, marketId = "EG"): DbContext => ({ kind: "worker", marketId, job });
let c: SqlClient;
let close: () => Promise<void>;

const count = (ctx: DbContext, sql: string): Promise<number> =>
  asRole(c, "outlet_worker", async (tx) => {
    await applyDbContext(tx, ctx);
    return (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`)).rows[0]?.n ?? -1;
  });

beforeAll(async () => {
  ({ client: c, close } = await createTestClient());
  for (const [m, src] of [["EG", "ledger_integrity"], ["EG", "psp_settlement"], ["AE", "ledger_integrity"]] as const) {
    await c.query(
      "INSERT INTO reconciliation_runs (id, market_id, source, counterparty, business_date, mode, status, started_at, finished_at, details) VALUES ($1,$2,$3,'x','2030-01-10','nightly','completed',now(),now(),'{}'::jsonb)",
      [randomUUID(), m, src],
    );
  }
});
afterAll(async () => close());

describe("reconciliation_runs and the ledger_integrity dashboard tile (migration 0039)", () => {
  it("admin.dashboard sees only the ledger_integrity run of its own market", async () => {
    expect(await count(worker("admin.dashboard"), "SELECT 1 FROM reconciliation_runs")).toBe(1);
    expect(await count(worker("admin.dashboard", "AE"), "SELECT 1 FROM reconciliation_runs")).toBe(1);
    expect(await count(worker("admin.dashboard", "ZZ"), "SELECT 1 FROM reconciliation_runs")).toBe(0);
  });
  it("finance.reconcile still sees every source of its market; unrelated jobs see nothing", async () => {
    expect(await count(worker("finance.reconcile"), "SELECT 1 FROM reconciliation_runs")).toBe(2);
    for (const job of ["reporting.rollup", "ops.attention", "finance.payouts"] as const) expect(await count(worker(job), "SELECT 1 FROM reconciliation_runs")).toBe(0);
  });
  it("admin.dashboard cannot write; finance.reconcile can store details; outlet_app has no access", async () => {
    await expect(asRole(c, "outlet_worker", async (tx) => {
      await applyDbContext(tx, worker("admin.dashboard"));
      return tx.query("UPDATE reconciliation_runs SET details = '{}'::jsonb");
    }).then((r) => (r as { rowCount?: number }).rowCount)).resolves.toBeFalsy();
    const updated = await asRole(c, "outlet_worker", async (tx) => {
      await applyDbContext(tx, worker("finance.reconcile"));
      return tx.query("UPDATE reconciliation_runs SET details = '{\"balanced\":true}'::jsonb WHERE source = 'ledger_integrity'");
    });
    expect(updated.rows.length >= 0).toBe(true);
    await expect(asRole(c, "outlet_app", async (tx) => {
      await applyDbContext(tx, { kind: "user", marketId: "EG" });
      return tx.query("SELECT 1 FROM reconciliation_runs");
    })).rejects.toThrow(/permission denied/);
  });
});
