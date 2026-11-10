import { randomUUID } from "node:crypto";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { SqlClient } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import { createWorkerMetrics } from "@outlet/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KillRead } from "../src/worker/jobs.js";
import { boundedClient } from "../src/worker/bounded.js";
import { parseWorkerEnv } from "../src/worker/config.js";
import { marketJobs, LEDGER_INTEGRITY_KILL_SWITCH } from "../src/worker/jobs.js";
import { RollupScheduler, windowsAt } from "../src/worker/scheduler.js";
import { brandClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { IntegrityJob } from "@outlet/payouts";

const quiet = createLogger({ write: () => undefined });
const EG = { marketId: "EG", timezone: "Africa/Cairo" };
const allow: KillRead = { isKilled: () => Promise.resolve(false) };
let db: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => { ({ client: db, close } = await createTestClient()); });
afterAll(async () => { await close(); });
beforeEach(async () => { await db.query("DELETE FROM outbox_events"); await db.query("DELETE FROM reconciliation_runs"); await db.query("DELETE FROM inbox_processed WHERE consumer = 'finance.integrity'"); });

const events = async (): Promise<{ id: string; event_type: string; aggregate_type: string; payload: { scope: string; window: string } }[]> =>
  (await db.query<{ id: string; event_type: string; aggregate_type: string; payload: { scope: string; window: string } }>("SELECT id, event_type, aggregate_type, payload FROM outbox_events WHERE event_type = 'ledger.integrity_requested'")).rows;
const sched = (now: () => Date, kill: KillRead = allow): RollupScheduler => new RollupScheduler({ markets: [EG], worker: roleClient(db, "outlet_worker"), kill, metrics: createWorkerMetrics(), log: quiet, now });

describe("ledger_integrity scheduler scope", () => {
  it("emits one ledger.integrity_requested per Cairo-local date, only from 01:00 to 06:00, across replicas and restarts", async () => {
    const early = new Date("2026-11-09T22:30:00Z"); // 00:30 Cairo: window not open yet
    await sched(() => early).tickOnce();
    expect(await events()).toHaveLength(0);
    let t = new Date("2026-11-09T23:10:00Z"); // 01:10 Cairo, 10 Nov
    const a = sched(() => t);
    await Promise.all([a.tickOnce(), sched(() => t).tickOnce()]);
    t = new Date("2026-11-10T02:00:00Z"); // 04:00 Cairo, same local date
    await a.tickOnce();
    await sched(() => t).tickOnce();
    t = new Date("2026-11-10T13:00:00Z"); // 15:00 Cairo
    await sched(() => t).tickOnce();
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ aggregate_type: "ledger_integrity", payload: { scope: "ledger_integrity", window: "ledger_integrity:2026-11-10" } });
  });

  it("its own money switch gates it: killed emits nothing (rollup ticks continue), released retries the window", async () => {
    const t = new Date("2026-11-10T02:00:00Z");
    let integrityKilled = true;
    const s = sched(() => t, { isKilled: (name) => Promise.resolve(name === LEDGER_INTEGRITY_KILL_SWITCH && integrityKilled) });
    const out = await s.tickOnce();
    expect(out.find((r) => r.scope === "ledger_integrity")?.outcome).toBe("killed");
    expect(out.find((r) => r.scope === "nightly")?.outcome).toBe("emitted");
    expect(await events()).toHaveLength(0);
    integrityKilled = false;
    expect((await s.tickOnce()).find((r) => r.scope === "ledger_integrity")?.outcome).toBe("emitted");
    expect(await events()).toHaveLength(1);
  });
});

describe("finance.integrity consumer composed in marketJobs", () => {
  it("is registered with the money kill switch and consumes the tick into one stored run, idempotently", async () => {
    const worker = roleClient(db, "outlet_worker");
    const jobs = marketJobs({ marketId: "EG", worker, app: roleClient(db, "outlet_app"), kill: allow, now: () => new Date("2026-11-10T02:05:00Z") });
    const job = jobs.find((j) => j.name === "finance.integrity");
    expect(job?.killSwitch).toBe("workers.ledger.integrity.enabled");
    const handler = job?.handlers.get("ledger.integrity_requested");
    if (handler === undefined) throw new Error("handler missing");
    const ev = { id: randomUUID(), type: "ledger.integrity_requested", payload: { scope: "ledger_integrity", window: "ledger_integrity:2026-11-10" } };
    expect(await handler(ev)).toBe("processed");
    expect(await handler(ev)).toBe("duplicate");
    const runs = (await db.query<{ business_date: string; status: string }>("SELECT business_date::text AS business_date, status FROM reconciliation_runs WHERE source = 'ledger_integrity'")).rows;
    expect(runs).toEqual([{ business_date: "2026-11-10", status: "completed" }]);
  });
});

describe("weekly full chain re-verify scope (ledger_integrity_full)", () => {
  it("Friday (Cairo) 01:00-06:00 emits ONE ledger_integrity_full per week across replicas and restarts, instead of that night's incremental tick", async () => {
    // 2026-11-13 is a Friday. 22:30Z Thursday = 00:30 Cairo Friday: window not open yet.
    await sched(() => new Date("2026-11-12T22:30:00Z")).tickOnce();
    expect((await events()).filter((e) => e.payload.scope.startsWith("ledger_integrity"))).toHaveLength(0);
    let t = new Date("2026-11-12T23:10:00Z"); // 01:10 Cairo Friday
    const a = sched(() => t);
    await Promise.all([a.tickOnce(), sched(() => t).tickOnce()]);
    t = new Date("2026-11-13T02:00:00Z");
    await a.tickOnce();
    await sched(() => t).tickOnce();
    t = new Date("2026-11-13T13:00:00Z"); // 15:00: window closed
    await sched(() => t).tickOnce();
    let ev = await events();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ aggregate_type: "ledger_integrity", payload: { scope: "ledger_integrity_full", window: "ledger_integrity_full:2026-11-13" } });
    // Saturday: back to the incremental scope. Next Friday: another full tick.
    t = new Date("2026-11-14T02:00:00Z");
    await sched(() => t).tickOnce();
    t = new Date("2026-11-20T02:00:00Z");
    await sched(() => t).tickOnce();
    ev = await events();
    expect(ev.map((e) => e.payload.window).sort()).toEqual(["ledger_integrity:2026-11-14", "ledger_integrity_full:2026-11-13", "ledger_integrity_full:2026-11-20"]);
  });

  it("windowsAt: Friday swaps the scope, other days keep ledger_integrity; the money kill switch also gates the full scope", async () => {
    expect(windowsAt(new Date("2026-11-13T03:59:00Z"), "Africa/Cairo").map((w) => w.scope)).toEqual(["snapshots", "sales", "nightly", "ledger_integrity_full", "retention"]);
    expect(windowsAt(new Date("2026-11-12T03:59:00Z"), "Africa/Cairo").map((w) => w.scope)).toContain("ledger_integrity");
    const s = sched(() => new Date("2026-11-13T02:00:00Z"), { isKilled: (n) => Promise.resolve(n === LEDGER_INTEGRITY_KILL_SWITCH) });
    expect((await s.tickOnce()).find((r) => r.scope === "ledger_integrity_full")?.outcome).toBe("killed");
    expect(await events()).toHaveLength(0);
  });
});

describe("integrity budget and statement timeout", () => {
  const base = { DATABASE_URL_WORKER: "postgres://w@h/db", DATABASE_URL_APP: "postgres://a@h/db" };
  it("WORKER_INTEGRITY_BUDGET_MS defaults to 8000, parses, and must stay below the handler timeout", () => {
    expect(parseWorkerEnv(base).WORKER_INTEGRITY_BUDGET_MS).toBe(8000);
    expect(parseWorkerEnv({ ...base, WORKER_INTEGRITY_BUDGET_MS: "3000" }).WORKER_INTEGRITY_BUDGET_MS).toBe(3000);
    expect(() => parseWorkerEnv({ ...base, WORKER_INTEGRITY_BUDGET_MS: "30000" })).toThrow(/WORKER_INTEGRITY_BUDGET_MS/);
    expect(() => parseWorkerEnv({ ...base, WORKER_INTEGRITY_BUDGET_MS: "100" })).toThrow(/WORKER_INTEGRITY_BUDGET_MS/);
    expect(() => parseWorkerEnv({ ...base, WORKER_INTEGRITY_BUDGET_MS: "abc" })).toThrow(/WORKER_INTEGRITY_BUDGET_MS/);
  });

  it("every verification page runs in its own transaction under the bounded client's statement_timeout", async () => {
    const seen: string[] = [];
    const bounded = boundedClient(roleClient(db, "outlet_worker"), 7_654);
    const spy: RoleSqlClient<"outlet_worker"> = brandClient<"outlet_worker">({
      query: (sql, params) => bounded.query(sql, params),
      transaction: (fn) => bounded.transaction(async (tx) => {
        const r = await fn(tx);
        seen.push((await tx.query<{ s: string }>("SELECT current_setting('statement_timeout') AS s")).rows[0]?.s ?? "");
        return r;
      }),
    });
    const job = new IntegrityJob({ client: spy, currency: "EGP", now: () => new Date("2026-11-10T02:00:00Z"), budgetMs: 60_000, pageSize: 10 });
    await job.run("EG");
    // load cursor + >= 1 page + final transaction: all separate transactions, all bounded.
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen)).toEqual(new Set(["7654ms"]));
  });
});
