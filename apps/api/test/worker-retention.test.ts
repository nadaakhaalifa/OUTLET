import { randomUUID } from "node:crypto";
import { brandClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { FlagService } from "@outlet/flags";
import type { FlagStore } from "@outlet/flags";
import { uuidV7Schema } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { createWorkerMetrics } from "@outlet/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RETENTION_KILL_SWITCH } from "../src/worker/jobs.js";
import type { KillRead } from "../src/worker/jobs.js";
import { marketJobs } from "../src/worker/jobs.js";
import { RETENTION_FIRST_HOUR, RollupScheduler, windowsAt } from "../src/worker/scheduler.js";
import { parseWorkerEnv } from "../src/worker/config.js";
import { retentionHandlers } from "../src/worker-consumers.js";

const quiet = createLogger({ write: () => undefined });
const EG = { marketId: "EG", timezone: "Africa/Cairo" };
const allow: KillRead = { isKilled: () => Promise.resolve(false) };
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
  await db.query("DELETE FROM inbox_processed");
});

const retentionTicks = async (): Promise<{ id: string; payload: { scope: string; window: string }; aggregate_type: string }[]> =>
  (await db.query<{ id: string; payload: { scope: string; window: string }; aggregate_type: string }>("SELECT id, payload, aggregate_type FROM outbox_events WHERE event_type = 'privacy.retention_requested' ORDER BY id")).rows;
const scheduler = (now: () => Date, kill: KillRead = allow): RollupScheduler =>
  new RollupScheduler({ markets: [EG], worker: roleClient(db, "outlet_worker"), kill, metrics: createWorkerMetrics(), log: quiet, now });
const inboxCount = async (): Promise<number> => Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM inbox_processed WHERE consumer = 'c'")).rows[0]?.n);

describe("retention scheduler scope", () => {
  it("opens hourly between 03:00 and 06:00 local, never earlier or later", () => {
    const scopes = (iso: string): string[] => windowsAt(new Date(iso), "Africa/Cairo").map((w) => w.scope);
    expect(RETENTION_FIRST_HOUR).toBe(3);
    expect(scopes("2026-11-10T00:30:00Z")).not.toContain("retention"); // 02:30 Cairo
    expect(scopes("2026-11-10T01:00:00Z")).toContain("retention"); // 03:00
    expect(scopes("2026-11-10T03:59:00Z")).toContain("retention"); // 05:59
    expect(scopes("2026-11-10T04:00:00Z")).not.toContain("retention"); // 06:00
    expect(scopes("2026-11-10T13:00:00Z")).not.toContain("retention"); // a restart at 15:00 never starts one
    const keys = [1, 2, 3].map((h) => windowsAt(new Date(`2026-11-10T0${String(h)}:10:00Z`), "Africa/Cairo").find((w) => w.scope === "retention")?.key);
    expect(keys).toEqual(["retention:2026-11-10:03", "retention:2026-11-10:04", "retention:2026-11-10:05"]);
  });

  it("DST: the 03:00-06:00 window stays three local hours across the Cairo changes (30 Apr 2026 +03 starts, 29 Oct 2026 +02 returns)", () => {
    const hours = (iso: string): string[] => windowsAt(new Date(iso), "Africa/Cairo").filter((w) => w.scope === "retention").map((w) => w.key);
    // 2026-04-23/24: Cairo moves from +02 to +03 at 00:00 local on Friday 24 Apr; 03:30 local is then 00:30Z
    expect(hours("2026-04-24T00:30:00Z")).toEqual(["retention:2026-04-24:03"]);
    expect(hours("2026-04-24T02:59:00Z")).toEqual(["retention:2026-04-24:05"]);
    expect(hours("2026-04-24T03:00:00Z")).toEqual([]);
    // 2026-10-30: back to +02 at 24:00 local on Thursday 29 Oct; 03:30 local is 01:30Z
    expect(hours("2026-10-30T01:30:00Z")).toEqual(["retention:2026-10-30:03"]);
    expect(hours("2026-10-30T03:59:00Z")).toEqual(["retention:2026-10-30:05"]);
    expect(hours("2026-10-30T04:00:00Z")).toEqual([]);
  });

  it("two replicas emit exactly one privacy.retention_requested per window; the next hour is a new tick", async () => {
    let t = new Date("2026-11-10T01:10:00Z"); // 03:10 Cairo
    const a = scheduler(() => t);
    const b = scheduler(() => t);
    await Promise.all([a.tickOnce(), b.tickOnce()]);
    let rows = await retentionTicks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payload: { scope: "retention", window: "retention:2026-11-10:03" }, aggregate_type: "privacy_retention" });
    expect(uuidV7Schema.safeParse(rows[0]?.id).success).toBe(true);
    t = new Date("2026-11-10T02:10:00Z");
    await Promise.all([a.tickOnce(), b.tickOnce()]);
    rows = await retentionTicks();
    expect(rows.map((r) => r.payload.window)).toEqual(["retention:2026-11-10:03", "retention:2026-11-10:04"]);
  });

  it("the retention kill switch gates only its own scope: killed emits nothing for retention while the rollup scopes still run", async () => {
    const t = new Date("2026-11-10T01:10:00Z");
    const s = scheduler(() => t, { isKilled: (n) => Promise.resolve(n === RETENTION_KILL_SWITCH) });
    const out = await s.tickOnce();
    expect(out.find((r) => r.scope === "retention")?.outcome).toBe("killed");
    expect(out.find((r) => r.scope === "sales")?.outcome).toBe("emitted");
    expect(await retentionTicks()).toEqual([]);
  });

  it("fails CLOSED: an unreadable flag store kills the retention switch (and only deletes-class switches), a ui worker switch stays open", async () => {
    const down: FlagStore = { get: () => Promise.reject(new Error("flags down")), list: () => Promise.reject(new Error("flags down")) } as unknown as FlagStore;
    const svc = new FlagService({ store: down, audit: { record: () => Promise.resolve() }, onError: () => undefined });
    await expect(svc.isKilled(RETENTION_KILL_SWITCH, { marketId: "EG" })).resolves.toBe(true);
    await expect(svc.isKilled("workers.search.sync.enabled", { marketId: "EG" })).resolves.toBe(false);
    const s = scheduler(() => new Date("2026-11-10T01:10:00Z"), svc);
    expect((await s.tickOnce()).find((r) => r.scope === "retention")?.outcome).toBe("killed");
    expect(await retentionTicks()).toEqual([]);
  });
});

describe("privacy.retention job", () => {
  const worker = (): RoleSqlClient<"outlet_worker"> => roleClient(db, "outlet_worker");
  const old = async (): Promise<void> => {
    await db.query("INSERT INTO inbox_processed (consumer, message_id, processed_at) VALUES ('c',$1, now() - interval '90 days')", [randomUUID()]);
  };
  const tick = (): { id: string; type: string; payload: Record<string, unknown> } => ({ id: randomUUID(), type: "privacy.retention_requested", payload: { scope: "retention", window: "retention:2026-11-10:03" } });

  it("is composed in marketJobs with its fail-closed kill switch and owns only the tick event", () => {
    const jobs = marketJobs({ marketId: "EG", worker: worker(), app: brandClient<"outlet_app">(db), kill: allow });
    const j = jobs.find((x) => x.name === "privacy.retention");
    expect(j?.killSwitch).toBe("workers.privacy.retention.enabled");
    expect([...(j?.handlers.keys() ?? [])]).toEqual(["privacy.retention_requested"]);
  });

  it("dry run is the default: the tick is consumed, nothing is deleted", async () => {
    await old();
    const h = retentionHandlers(worker(), "EG", { log: quiet });
    expect(await h.get("privacy.retention_requested")?.(tick())).toBe("processed");
    expect(await inboxCount()).toBe(1);
  });

  it("WORKER_RETENTION_DRY_RUN=false deletes; unset or anything else keeps counting only (parsed from the env)", async () => {
    const base = { DATABASE_URL_WORKER: "postgres://w@localhost/x", DATABASE_URL_APP: "postgres://a@localhost/x" };
    expect(parseWorkerEnv(base).WORKER_RETENTION_DRY_RUN).toBe(true);
    expect(parseWorkerEnv({ ...base, WORKER_RETENTION_DRY_RUN: "false" }).WORKER_RETENTION_DRY_RUN).toBe(false);
    expect(() => parseWorkerEnv({ ...base, WORKER_RETENTION_DRY_RUN: "0" })).toThrow(/WORKER_RETENTION_DRY_RUN/);
    expect(parseWorkerEnv(base).WORKER_RETENTION_BUDGET_MS).toBe(8000);
    expect(() => parseWorkerEnv({ ...base, WORKER_RETENTION_BUDGET_MS: "30000" })).toThrow(/WORKER_RETENTION_BUDGET_MS/);
    await old();
    const h = retentionHandlers(worker(), "EG", { dryRun: false, log: quiet });
    await h.get("privacy.retention_requested")?.(tick());
    expect(await inboxCount()).toBe(0);
  });
});
