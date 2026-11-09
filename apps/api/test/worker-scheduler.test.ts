import { brandClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { SqlClient } from "@outlet/db";
import { uuidV7Schema } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { createWorkerMetrics } from "@outlet/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KillRead } from "../src/worker/jobs.js";
import { tryLeaderTx } from "../src/worker/leader.js";
import { RollupScheduler, tickId, windowsAt } from "../src/worker/scheduler.js";

const quiet = createLogger({ write: () => undefined });
const metrics = createWorkerMetrics();
const allow: KillRead = { isKilled: () => Promise.resolve(false) };
const EG = { marketId: "EG", timezone: "Africa/Cairo" };

let db: SqlClient;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ client: db, close } = await createTestClient());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await db.query("DELETE FROM outbox_events");
});

const ticks = async (): Promise<{ id: string; payload: { scope: string }; market_id: string }[]> =>
  (await db.query<{ id: string; payload: { scope: string }; market_id: string }>("SELECT id, payload, market_id FROM outbox_events WHERE event_type = 'reporting.rollup_requested' ORDER BY id")).rows;

const scheduler = (now: () => Date, kill: KillRead = allow): RollupScheduler => new RollupScheduler({ markets: [EG], worker: roleClient(db, "outlet_worker"), kill, metrics, log: quiet, now });

describe("RollupScheduler", () => {
  it("two competing replicas emit exactly one tick per cadence window (snapshots 60 s, sales 5 min)", async () => {
    let t = new Date("2026-11-10T10:00:10Z"); // 12:00 Cairo: no nightly window
    const a = scheduler(() => t);
    const b = scheduler(() => t);
    const [ra, rb] = await Promise.all([a.tickOnce(), b.tickOnce()]);
    expect([...ra, ...rb].filter((r) => r.outcome === "emitted").map((r) => r.scope).sort()).toEqual(["sales", "snapshots"]);
    expect([...ra, ...rb].filter((r) => r.outcome === "exists")).toHaveLength(2);
    expect((await ticks()).map((r) => r.payload.scope).sort()).toEqual(["sales", "snapshots"]);
    // same windows again: remembered in memory, no write attempted
    expect(await a.tickOnce()).toEqual([]);
    t = new Date("2026-11-10T10:01:05Z"); // next snapshot window, same sales window
    await Promise.all([a.tickOnce(), b.tickOnce()]);
    expect((await ticks()).map((r) => r.payload.scope).sort()).toEqual(["sales", "snapshots", "snapshots"]);
    t = new Date("2026-11-10T10:05:00Z"); // next sales window
    await Promise.all([b.tickOnce(), a.tickOnce()]);
    const rows = await ticks();
    expect(rows.filter((r) => r.payload.scope === "sales")).toHaveLength(2);
    expect(rows.every((r) => r.market_id === "EG" && uuidV7Schema.safeParse(r.id).success)).toBe(true);
    expect(a.lastBeat()).toEqual(t);
  });

  it("nightly is emitted once per Cairo-local date, only in the 00:00-06:00 local window", async () => {
    let t = new Date("2026-11-09T22:30:00Z"); // 00:30 Cairo (UTC+2), 10 Nov
    const s = scheduler(() => t);
    await s.tickOnce();
    t = new Date("2026-11-10T02:00:00Z"); // 04:00 Cairo, same local date
    await s.tickOnce();
    await scheduler(() => t).tickOnce(); // a fresh replica in the same window: the id makes it a no-op
    t = new Date("2026-11-10T13:00:00Z"); // 15:00 Cairo: a restart does not start a 90-day re-run
    await scheduler(() => t).tickOnce();
    const nightly = (await ticks()).filter((r) => r.payload.scope === "nightly");
    expect(nightly).toHaveLength(1);
    expect(nightly[0]?.payload).toEqual({ scope: "nightly", window: "nightly:2026-11-10" });
  });

  it("a killed rollup job emits nothing and retries the window once released", async () => {
    const t = new Date("2026-11-10T10:00:10Z");
    let killed = true;
    const s = scheduler(() => t, { isKilled: () => Promise.resolve(killed) });
    expect((await s.tickOnce()).map((r) => r.outcome)).toEqual(["killed", "killed"]);
    expect(await ticks()).toEqual([]);
    killed = false;
    expect((await s.tickOnce()).map((r) => r.outcome)).toEqual(["emitted", "emitted"]);
  });

  it("start runs a tick at once and stop waits for it", async () => {
    const s = scheduler(() => new Date("2026-11-10T10:00:10Z"));
    s.start(60_000);
    s.start(60_000); // idempotent
    await s.stop();
    await s.stop();
    expect(await ticks()).toHaveLength(2);
  });

  it("a replica that loses the advisory lock skips (not_leader) and retries next turn; a failing database is logged and retried", async () => {
    const lost = brandClient<"outlet_worker">({
      query: () => Promise.reject(new Error("unused")),
      transaction: <T>(fn: (tx: { query: () => Promise<{ rows: { ok: boolean }[] }> }) => Promise<T>) => fn({ query: () => Promise.resolve({ rows: [{ ok: false }] }) }),
    } as never);
    const t = new Date("2026-11-10T10:00:10Z");
    const s = new RollupScheduler({ markets: [EG], worker: lost, kill: allow, metrics, log: quiet, now: () => t });
    expect((await s.tickOnce()).map((r) => r.outcome)).toEqual(["not_leader", "not_leader"]);
    expect((await s.tickOnce()).map((r) => r.outcome)).toEqual(["not_leader", "not_leader"]);
    const lines: string[] = [];
    const broken = brandClient<"outlet_worker">({ query: () => Promise.reject(new Error("db down")), transaction: () => Promise.reject(Object.assign(new Error("db down"), { code: "ECONNREFUSED" })) });
    const f = new RollupScheduler({ markets: [EG], worker: broken, kill: allow, metrics, log: createLogger({ write: (l) => lines.push(l) }), now: () => t });
    expect((await f.tickOnce()).map((r) => r.outcome)).toEqual(["failed", "failed"]);
    expect(lines.join("\n")).toContain("Error:ECONNREFUSED");
  });
});

describe("tick ids and windows", () => {
  it("tick ids are valid UUIDv7, stable per window and distinct across markets and scopes", () => {
    const [snap, sales] = windowsAt(new Date("2026-11-10T10:00:10Z"), "Africa/Cairo");
    if (snap === undefined || sales === undefined) throw new Error("windows");
    const id = tickId("EG", snap);
    expect(uuidV7Schema.safeParse(id).success).toBe(true);
    expect(tickId("EG", snap)).toBe(id);
    expect(tickId("SA", snap)).not.toBe(id);
    expect(tickId("EG", sales)).not.toBe(id);
    expect(id.startsWith(snap.startMs.toString(16).padStart(12, "0").slice(0, 8))).toBe(true);
  });

  it("windows: nightly only before 06:00 local", () => {
    expect(windowsAt(new Date("2026-11-10T03:59:00Z"), "Africa/Cairo").map((w) => w.scope)).toEqual(["snapshots", "sales", "nightly"]);
    expect(windowsAt(new Date("2026-11-10T04:00:00Z"), "Africa/Cairo").map((w) => w.scope)).toEqual(["snapshots", "sales"]);
  });

  it("tryLeaderTx holds the lock for the transaction (re-entrant inside it)", async () => {
    await db.transaction(async (tx) => {
      expect(await tryLeaderTx(tx, "k")).toBe(true);
      expect(await tryLeaderTx(tx, "k")).toBe(true);
    });
    expect(await tryLeaderTx({ query: () => Promise.resolve({ rows: [] }) }, "k")).toBe(false);
  });
});
