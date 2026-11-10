import { randomUUID } from "node:crypto";
import { contextClient } from "@outlet/db";
import type { RoleSqlClient, SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import type { KillSwitchName } from "@outlet/flags";
import { uuidv7 } from "@outlet/ids";
import { createLogger } from "@outlet/logger";
import { NOTIFYING_EVENT_TYPES } from "@outlet/notifications";
import { createWorkerMetrics } from "@outlet/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { marketJobs } from "../src/worker/jobs.js";
import type { KillRead } from "../src/worker/jobs.js";
import { MarketRunner } from "../src/worker/runner.js";
import { notificationHandlers } from "../src/worker-consumers.js";

const M = "EG";
const logs: string[] = [];
const log = createLogger({ write: (l) => logs.push(l), level: "debug" });
const metrics = createWorkerMetrics();
// 12:00 Cairo: outside quiet hours.
const NOON = new Date(Date.UTC(2026, 10, 8, 10, 0, 0));

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
  logs.length = 0;
  for (const t of ["notification_log", "outbox_events", "inbox_processed", "store_members", "dlq_messages"]) await db.query(`DELETE FROM ${t}`);
});

const killing = (names: readonly KillSwitchName[]): KillRead => ({ isKilled: (n) => Promise.resolve(names.includes(n)) });
const user = async (locale = "ar-EG"): Promise<string> => {
  const id = uuidv7();
  await db.query("INSERT INTO users (id, market_id, locale, created_at, updated_at) VALUES ($1,'EG',$2,now(),now())", [id, locale]);
  return id;
};
const handlers = (kill: KillRead = killing([])) => notificationHandlers(worker, M, { isChannelKilled: (c) => kill.isKilled(`notifications.${c}.enabled` as KillSwitchName, { marketId: M }), log, now: () => NOON });
const send = (h: ReturnType<typeof handlers>, type: string, payload: Record<string, unknown>, id = uuidv7()) => {
  const fn = h.get(type);
  if (fn === undefined) throw new Error(`no handler ${type}`);
  return fn({ id, type, payload });
};
const rows = async (userId: string) => (await db.query<{ channel: string; status: string; provider: string | null; template_code: string; category: string; vars: Record<string, string> }>(
  "SELECT channel, status, provider, template_code, category, vars FROM notification_log WHERE user_id = $1 ORDER BY channel", [userId])).rows;

const PAYLOADS: Record<string, (u: string) => Record<string, unknown>> = {
  "order_group.placed": (u) => ({ user_id: u, total_minor: "150000", currency: "EGP" }),
  "order_group.paid": (u) => ({ user_id: u, total_minor: "150000", currency: "EGP" }),
  "order_group.cancelled": (u) => ({ user_id: u }),
  "seller_order.shipped": (u) => ({ user_id: u }),
  "seller_order.delivered": (u) => ({ user_id: u }),
  "refund.completed": (u) => ({ user_id: u, amount_minor: "5000", currency: "EGP" }),
  "return.received": (u) => ({ user_id: u }),
  "seller_order.rejected": (u) => ({ user_id: u }),
};

describe("notifications.dispatch composed in the worker", () => {
  it("is registered for every NOTIFYING_EVENT_TYPE behind workers.notifications.dispatch.enabled", () => {
    const job = marketJobs({ marketId: M, worker, app, kill: killing([]) }).find((j) => j.name === "notifications.dispatch");
    expect([...(job?.handlers.keys() ?? [])].sort()).toEqual([...NOTIFYING_EVENT_TYPES].sort());
    expect(job?.killSwitch).toBe("workers.notifications.dispatch.enabled");
  });

  for (const [type, payload] of Object.entries(PAYLOADS)) {
    it(`${type}: plans an Arabic in-app row and one outbound row, both pending (queued, no provider, never sent)`, async () => {
      const u = await user();
      expect(await send(handlers(), type, payload(u))).toBe("processed");
      const r = await rows(u);
      expect(r.map((x) => x.channel)).toEqual(["in_app", "push"]);
      expect(r.every((x) => x.status === "queued" && x.provider === null && x.category === "transactional")).toBe(true);
      const ar = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM notification_templates WHERE code = $1 AND locale = 'ar-EG'", [r[0]?.template_code]);
      expect(Number(ar.rows[0]?.n)).toBeGreaterThan(0);
    });
  }

  it("replay of the same event id is a duplicate and plans nothing more", async () => {
    const u = await user();
    const h = handlers();
    const id = uuidv7();
    expect(await send(h, "order_group.paid", PAYLOADS["order_group.paid"]?.(u) ?? {}, id)).toBe("processed");
    expect(await send(h, "order_group.paid", PAYLOADS["order_group.paid"]?.(u) ?? {}, id)).toBe("duplicate");
    expect(await rows(u)).toHaveLength(2);
  });

  it("a bad payload is parked: inbox row, error log, no rows, replay is a duplicate, nothing throws", async () => {
    const h = handlers();
    const id = uuidv7();
    expect(await send(h, "order_group.paid", { user_id: "not-a-uuid" }, id)).toBe("processed");
    expect(logs.some((l) => l.includes("parked") && l.includes("invalid_payload"))).toBe(true);
    expect((await db.query("SELECT 1 FROM notification_log")).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM inbox_processed WHERE consumer = 'notifications.dispatch' AND message_id = $1", [id])).rows).toHaveLength(1);
    expect(await send(h, "order_group.paid", {}, id)).toBe("duplicate");
  });

  it("store-member fan-out: the shopper-side cancellation reaches every active owner/manager/warehouse member, once each", async () => {
    const seller = uuidv7();
    const store = uuidv7();
    await db.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type) VALUES ($1,'EG','EG','company')", [seller]);
    await db.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG',$3,'متجر','local','EG','ACTIVE')", [store, seller, `s-${store.slice(-12)}`]);
    const a = await user();
    const b = await user();
    const gone = await user();
    for (const [uid, role, st] of [[a, "owner", "active"], [b, "manager", "active"], [gone, "manager", "removed"]] as const) {
      await db.query("INSERT INTO store_members (id, store_id, market_id, user_id, role_code, status, accepted_at) VALUES ($1,$2,'EG',$3,$4,$5, now())", [uuidv7(), store, uid, role, st]);
    }
    const id = uuidv7();
    const h = handlers();
    expect(await send(h, "seller_order.cancelled", { store_id: store, seller_order_id: randomUUID(), initiator: "shopper" }, id)).toBe("processed");
    expect((await rows(a)).length).toBeGreaterThan(0);
    expect((await rows(b)).length).toBeGreaterThan(0);
    expect(await rows(gone)).toHaveLength(0);
    expect(await send(h, "seller_order.cancelled", { store_id: store, seller_order_id: randomUUID(), initiator: "shopper" }, id)).toBe("duplicate");
    expect((await db.query("SELECT 1 FROM notification_log")).rows.length).toBe((await rows(a)).length + (await rows(b)).length);
  });

  it("a seller-initiated cancellation maps to no notice and is acked without rows", async () => {
    expect(await send(handlers(), "seller_order.cancelled", { store_id: randomUUID(), initiator: "seller" })).toBe("processed");
    expect((await db.query("SELECT 1 FROM notification_log")).rows).toHaveLength(0);
  });

  it("a killed channel suppresses its row (reason killed); the in-app copy is still planned", async () => {
    const u = await user();
    await send(handlers(killing(["notifications.push.enabled", "notifications.whatsapp.enabled", "notifications.sms.enabled", "notifications.email.enabled"])), "order_group.cancelled", { user_id: u });
    const r = await rows(u);
    expect(r.find((x) => x.channel === "in_app")?.status).toBe("queued");
    expect(r.filter((x) => x.channel !== "in_app").every((x) => x.status === "suppressed")).toBe(true);
  });

  it("through the relay: with workers.notifications.dispatch.enabled killed the event stays unpublished; enabled, it is acked and rows exist", async () => {
    const u = await user();
    const id = uuidv7();
    await db.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ($1,'EG','order_group',$2,'order_group.paid',$3::jsonb,$4)", [id, randomUUID(), JSON.stringify(PAYLOADS["order_group.paid"]?.(u)), new Date(Date.now() - 10_000).toISOString()]);
    const run = (kill: KillRead): MarketRunner =>
      new MarketRunner({
        marketId: M, relayDb: contextClient(worker, { kind: "worker", marketId: M, job: "outbox.relay" }), jobs: marketJobs({ marketId: M, worker, app, kill }), kill, metrics, log,
        pollMs: 10, pollMaxMs: 40, batchSize: 50, maxAttempts: 8, leaseMs: 60_000, handlerTimeoutMs: 5_000, lagMs: 1_000,
      });
    await run(killing(["workers.notifications.dispatch.enabled"])).turn(0);
    expect((await db.query<{ p: Date | null }>("SELECT published_at AS p FROM outbox_events WHERE id = $1", [id])).rows[0]?.p).toBeNull();
    expect(await rows(u)).toHaveLength(0);
    await run(killing([])).turn(0);
    expect((await db.query<{ p: Date | null }>("SELECT published_at AS p FROM outbox_events WHERE id = $1", [id])).rows[0]?.p).not.toBeNull();
    expect((await rows(u)).length).toBe(2);
  });
});
