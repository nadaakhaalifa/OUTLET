import { randomUUID } from "node:crypto";
import { brandClient, contextClient } from "@outlet/db";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { KillSwitchName } from "@outlet/flags";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { createWorkerMetrics } from "@outlet/observability";
import type { InboxOutcome } from "@outlet/outbox";
import { CourierCancelError } from "@outlet/shipping";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { leaseMsFor, parseWorkerEnv } from "../src/worker/config.js";
import type { WorkerEnv } from "../src/worker/config.js";
import { RELAY_KILL_SWITCH, UnconfiguredProviderRefunds, UnconfiguredWorkerCourier, assertDisjoint, marketJobs, refundsKill } from "../src/worker/jobs.js";
import type { KillRead, WorkerJobDef } from "../src/worker/jobs.js";
import { startWorker } from "../src/worker/main.js";
import { MarketRunner } from "../src/worker/runner.js";

const metrics = createWorkerMetrics();
const quiet = createLogger({ write: () => undefined });
const M = "EG";

let db: SqlClient;
let close: () => Promise<void>;
let worker: RoleSqlClient<"outlet_worker">;
let app: RoleSqlClient<"outlet_app">;
beforeAll(async () => {
  ({ client: db, close } = await createTestClient());
  worker = roleClient(db, "outlet_worker");
  app = roleClient(db, "outlet_app");
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  for (const t of ["outbox_events", "inbox_processed", "attention_items", "dlq_messages"]) await db.query(`DELETE FROM ${t}`);
});

const killing = (names: readonly KillSwitchName[]): KillRead => ({ isKilled: (n) => Promise.resolve(names.includes(n)) });

/** A refund.attention event as CancellationRefundConsumer parks it (the attention consumer turns it into an ops queue item). */
const seedAttention = async (occurredAt = new Date(Date.now() - 30_000)): Promise<string> => {
  const id = uuidv7();
  const group = randomUUID();
  await db.query(
    "INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ($1, $2, 'order_group', $3, 'refund.attention', $4::jsonb, $5)",
    [id, M, group, JSON.stringify({ order_group_id: group, error: "ReturnsError", source_event_id: uuidv7() }), occurredAt.toISOString()],
  );
  return id;
};
const outbox = async (): Promise<{ id: string; event_type: string; published_at: Date | null; attempts: number; last_error: string | null }[]> =>
  (await db.query<{ id: string; event_type: string; published_at: Date | null; attempts: number; last_error: string | null }>("SELECT id, event_type, published_at, attempts, last_error FROM outbox_events ORDER BY id")).rows;

const runner = (o: { jobs?: readonly WorkerJobDef[]; kill?: KillRead; relayDb?: SqlClient; batchSize?: number; maxAttempts?: number; handlerTimeoutMs?: number; log?: ReturnType<typeof createLogger> } = {}): MarketRunner => {
  const kill = o.kill ?? killing([]);
  return new MarketRunner({
    marketId: M,
    relayDb: o.relayDb ?? contextClient(worker, { kind: "worker", marketId: M, job: "outbox.relay" }),
    jobs: o.jobs ?? marketJobs({ marketId: M, worker, app, kill }),
    kill, metrics, log: o.log ?? quiet,
    pollMs: 10, pollMaxMs: 40, batchSize: o.batchSize ?? 20, maxAttempts: o.maxAttempts ?? 8, leaseMs: 60_000, handlerTimeoutMs: o.handlerTimeoutMs ?? 5_000, lagMs: 1_000,
  });
};

/** One-job table with a controllable handler for refund.attention. */
const customJob = (handler: () => Promise<InboxOutcome>): WorkerJobDef[] => [{ job: "ops.attention", killSwitch: "workers.ops.attention.enabled", handlers: new Map([["refund.attention", handler]]) }];

describe("relay + inbox round trip (ops.attention consumer)", () => {
  it("one event: claimed, handled through the attention consumer (item + inbox row), acked; the follow-up event has no consumer and is acked", async () => {
    const id = await seedAttention();
    const r = runner();
    expect(await r.turn(0)).toBe(10);
    const items = await db.query<{ kind: string; market_id: string; status: string }>("SELECT kind, market_id, status FROM attention_items");
    expect(items.rows).toEqual([{ kind: "refund.attention", market_id: M, status: "OPEN" }]);
    expect((await db.query("SELECT 1 FROM inbox_processed WHERE consumer = 'ops.attention' AND message_id = $1", [id])).rows).toHaveLength(1);
    const after = await outbox();
    expect(after.find((e) => e.id === id)).toMatchObject({ attempts: 1, last_error: null });
    expect(after.find((e) => e.id === id)?.published_at).not.toBeNull();
    expect(after.map((e) => e.event_type)).toEqual(["refund.attention", "ops.attention_opened"]);
    await r.turn(0);
    expect((await outbox()).every((e) => e.published_at !== null)).toBe(true);
    expect(await r.turn(0)).toBe(10); // idle: back off from pollMs ...
    expect(await r.turn(10)).toBe(20); // ... doubling ...
    expect(await r.turn(40)).toBe(40); // ... up to pollMaxMs
    expect(r.status().consumers.map((c) => c.job)).toEqual(["finance.refunds", "checkout.settle", "shipping.tracking", "ops.attention", "reporting.rollup"]);
  });

  it("a disabled kill switch parks the consumer: nothing claimed, no inbox row; health reports it killed with lag; release resumes it", async () => {
    const id = await seedAttention(new Date(Date.now() - 120_000));
    let killed: KillSwitchName[] = ["workers.ops.attention.enabled"];
    const kill: KillRead = { isKilled: (n) => Promise.resolve(killed.includes(n)) };
    const r = runner({ kill });
    await r.turn(0);
    expect((await outbox())[0]).toMatchObject({ id, published_at: null, attempts: 0 });
    expect((await db.query("SELECT 1 FROM inbox_processed")).rows).toHaveLength(0);
    const st = r.status().consumers.find((c) => c.job === "ops.attention");
    expect(st).toMatchObject({ killed: true, pending: 1 });
    expect(st?.lagSeconds).toBeGreaterThanOrEqual(119);
    killed = [];
    await r.turn(0);
    expect((await outbox()).find((e) => e.id === id)?.published_at).not.toBeNull();
  });

  it("a killed relay claims nothing at all", async () => {
    await seedAttention();
    const r = runner({ kill: killing([RELAY_KILL_SWITCH]) });
    expect(await r.turn(0)).toBe(40);
    expect(r.status().relayKilled).toBe(true);
    expect((await outbox())[0]?.published_at).toBeNull();
  });

  it("a full batch polls again at once; a handler timeout is a failure with a code; the last attempt dead-letters", async () => {
    await seedAttention();
    await seedAttention();
    const fast = runner({ jobs: customJob(() => Promise.resolve("processed")), batchSize: 1 });
    expect(await fast.turn(0)).toBe(0);
    await db.query("DELETE FROM outbox_events");
    const lines: string[] = [];
    const slow = runner({ jobs: customJob(() => new Promise<InboxOutcome>(() => undefined)), handlerTimeoutMs: 30, maxAttempts: 1, log: createLogger({ write: (l) => lines.push(l) }) });
    const id = await seedAttention();
    expect(await slow.turn(0)).toBe(10);
    expect((await outbox())[0]).toMatchObject({ id, attempts: 1, last_error: "HandlerTimeout" });
    expect((await db.query("SELECT 1 FROM dlq_messages WHERE message_id = $1", [id])).rows).toHaveLength(1);
    expect(lines.join("\n")).toContain("dead-lettered");
    expect(lines.join("\n")).not.toContain("order_group_id");
  });

  it("a failing database is recorded as a code and backs off to the maximum", async () => {
    const reset = (): Promise<never> => Promise.reject(Object.assign(new Error("x"), { code: "ECONNRESET" }));
    const broken = brandClient<"outlet_worker">({ query: reset, transaction: reset });
    const r = runner({ relayDb: contextClient(broken, { kind: "worker", marketId: M, job: "outbox.relay" }) });
    expect(await r.turn(0)).toBe(40);
    expect(r.status()).toMatchObject({ lastError: "Error:ECONNRESET" });
    expect(r.lastBeat()).not.toBeNull();
  });
});

describe("graceful shutdown", () => {
  it("stop waits for the in-flight handler, acks it and releases the rest of the batch", async () => {
    const first = await seedAttention();
    const second = await seedAttention();
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((r) => (started = r));
    const r = runner({ jobs: customJob(() => { started(); return new Promise<InboxOutcome>((res) => (release = () => { res("processed"); })); }) });
    r.start();
    r.start();
    await running;
    const stopping = r.stop(5_000);
    release();
    expect(await stopping).toBe(true);
    const rows = await outbox();
    expect(rows.find((e) => e.id === first)?.published_at).not.toBeNull();
    expect(rows.find((e) => e.id === second)).toMatchObject({ published_at: null, attempts: 0 });
    expect((await db.query<{ lease_until: Date | null }>("SELECT lease_until FROM outbox_events WHERE id = $1", [second])).rows[0]?.lease_until).toBeNull();
  });

  it("a handler that outlives the drain budget reports not drained (its lease expires and it is redelivered)", async () => {
    await seedAttention();
    let started: () => void = () => undefined;
    const running = new Promise<void>((r) => (started = r));
    const r = runner({ jobs: customJob(() => { started(); return new Promise<InboxOutcome>(() => undefined); }), handlerTimeoutMs: 60_000 });
    r.start();
    await running;
    expect(await r.stop(50)).toBe(false);
    expect(await runner().stop(10)).toBe(true); // never started
  });
});

describe("startWorker (composition, health endpoint, drain)", () => {
  const env = (over: Partial<WorkerEnv> = {}): WorkerEnv => ({
    ...parseWorkerEnv({ DATABASE_URL_WORKER: "postgres://w@localhost/x", DATABASE_URL_APP: "postgres://a@localhost/x" }),
    WORKER_HEALTH_HOST: "127.0.0.1", WORKER_HEALTH_PORT: 0, WORKER_POLL_MS: 60_000, WORKER_POLL_MAX_MS: 60_000, WORKER_SCHEDULER_MS: 60_000,
    ...over,
  });
  const json = async (port: number, path: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const until = async (ok: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  it("serves liveness and per-consumer lag, then drains on stop", async () => {
    await seedAttention(new Date(Date.now() - 60_000));
    const w = await startWorker({ env: env(), worker, app, log: quiet, markets: [{ marketId: M, timezone: "Africa/Cairo" }], kill: killing(["workers.ops.attention.enabled"]) });
    try {
      await until(() => w.health().markets[0]?.lastPollAt != null && w.scheduler.lastBeat() !== null);
      expect(await json(w.healthPort, "/livez")).toEqual({ status: 200, body: { status: "ok", draining: false } });
      const h = await json(w.healthPort, "/healthz");
      expect(h.status).toBe(200);
      const markets = h.body.markets as { market_id: string; consumers: { job: string; killed: boolean; pending: number; lag_seconds: number }[] }[];
      expect(markets[0]?.market_id).toBe(M);
      const att = markets[0]?.consumers.find((c) => c.job === "ops.attention");
      expect(att).toMatchObject({ killed: true, pending: 1 });
      expect(att?.lag_seconds).toBeGreaterThanOrEqual(59);
      expect((await json(w.healthPort, "/nope")).status).toBe(404);
      expect((await json(w.healthPort, "/livez", "POST")).status).toBe(405);
    } finally {
      expect(await w.stop()).toEqual({ drained: true });
    }
    expect(w.health()).toMatchObject({ live: false, draining: true });
    // the scheduler ran once at start: one snapshots and one sales tick for EG
    expect((await outbox()).filter((e) => e.event_type === "reporting.rollup_requested").length).toBeGreaterThanOrEqual(2);
  });

  it("liveness fails when a loop stops beating; an unreadable flag store kills the money jobs (fail closed) and leaves the others running", async () => {
    let t = Date.now();
    const lines: string[] = [];
    const brokenApp = brandClient<"outlet_app">({ query: () => Promise.reject(new Error("flags down")), transaction: () => Promise.reject(new Error("flags down")) });
    const w = await startWorker({ env: env(), worker, app: brokenApp, log: createLogger({ write: (l) => lines.push(l) }), markets: [{ marketId: M, timezone: "Africa/Cairo" }], now: () => new Date(t), livenessMs: 1_000 });
    try {
      await until(() => w.health().markets[0]?.lastPollAt != null);
      const consumers = w.health().markets[0]?.consumers ?? [];
      expect(consumers.filter((c) => c.killed).map((c) => c.job).sort()).toEqual(["checkout.settle", "finance.refunds"]);
      expect(w.health().markets[0]?.relayKilled).toBe(false);
      expect(lines.join("\n")).toContain("flag store read failed");
      t += 10_000;
      expect((await json(w.healthPort, "/livez")).status).toBe(503);
      expect((await json(w.healthPort, "/healthz")).body.status).toBe("unhealthy");
    } finally {
      await w.stop();
    }
  });

  it("defaults: every configured market and the default metrics", async () => {
    const w = await startWorker({ env: env(), worker, app, log: quiet, kill: killing([]) });
    try {
      expect(w.runners.map((r) => r.status().marketId)).toContain("EG");
    } finally {
      await w.stop();
    }
  });
});

describe("worker composition pieces", () => {
  it("parseWorkerEnv requires both pools and never echoes values; lease covers a full batch", () => {
    expect(() => parseWorkerEnv({ DATABASE_URL_APP: "postgres://secret@h/x" })).toThrow(/DATABASE_URL_WORKER/);
    expect(() => parseWorkerEnv({ DATABASE_URL_WORKER: "postgres://secret@h/x" })).toThrow(/^(?!.*secret).*DATABASE_URL_APP/);
    expect(() => parseWorkerEnv({ DATABASE_URL_WORKER: "postgres://h/x", DATABASE_URL_APP: "postgres://h/x", WORKER_DRAIN_MS: "60000" })).toThrow(/WORKER_DRAIN_MS/);
    expect(leaseMsFor({ WORKER_BATCH_SIZE: 20, WORKER_HANDLER_TIMEOUT_MS: 20_000 })).toBe(460_000);
  });

  it("registers every dispatch table once and refuses a type claimed by two jobs", () => {
    const jobs = marketJobs({ marketId: M, worker, app, kill: killing([]) });
    expect(jobs.flatMap((j) => [...j.handlers.keys()]).sort()).toEqual(
      ["promotions.settle_attention", "promotions.settle_requested", "refund.attention", "reporting.rollup_requested", "seller_order.cancelled", "seller_order.rejected", "shipment.cancel_attention", "shipment.cancel_required"],
    );
    const h = new Map([["a.b", () => Promise.resolve<InboxOutcome>("processed")]]);
    expect(() => { assertDisjoint([{ job: "ops.attention", killSwitch: "workers.ops.attention.enabled", handlers: h }, { job: "reporting.rollup", killSwitch: "workers.reporting.rollup.enabled", handlers: h }]); }).toThrow(/a\.b/);
  });

  it("unconfigured providers fail closed: refunds rejected, courier cancellation parked as not_cancellable", async () => {
    const p = new UnconfiguredProviderRefunds();
    expect(p.canReverse()).toBe(false);
    expect(await p.refund()).toEqual({ outcome: "rejected", code: "provider_unconfigured" });
    const err: unknown = await new UnconfiguredWorkerCourier().cancelShipment().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CourierCancelError);
    expect((err as CourierCancelError).code).toBe("not_cancellable");
  });

  it("refundsKill reads refunds.enabled and engages any other key", async () => {
    const asked: string[] = [];
    const k = refundsKill({ isKilled: (n, c) => (asked.push(`${n}:${c.marketId}`), Promise.resolve(false)) }, M);
    expect(await k.isEngaged("refunds.enabled")).toBe(false);
    expect(await k.isEngaged("other")).toBe(true);
    expect(asked).toEqual(["refunds.enabled:EG"]);
  });
});
