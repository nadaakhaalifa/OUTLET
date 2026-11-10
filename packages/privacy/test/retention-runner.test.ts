import { randomUUID } from "node:crypto";
import { createLogger } from "@outlet/logger";
import { roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOT_PURGED, PURGE_SPECS, RETENTION_REQUESTED_EVENT, RetentionConsumer, RetentionRunner, loadRetentionRules } from "../src/index.js";
import type { InventoryRules, RetentionMetricsPort } from "../src/index.js";
import { insertUser, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await env.close();
});

const DAY = 86_400_000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY);
const lines: Record<string, unknown>[] = [];
const log = createLogger({ write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) });

interface Spy extends RetentionMetricsPort {
  readonly purgedBy: Map<string, number>;
  readonly dueBy: Map<string, number>;
  readonly skippedBy: Map<string, string>;
}
const spy = (): Spy => {
  const purgedBy = new Map<string, number>();
  const dueBy = new Map<string, number>();
  const skippedBy = new Map<string, string>();
  return {
    purgedBy, dueBy, skippedBy,
    purged: (t, _m, n) => void purgedBy.set(t, (purgedBy.get(t) ?? 0) + n),
    due: (t, _m, n) => void dueBy.set(t, n),
    skipped: (t, _m, r) => void skippedBy.set(t, r),
  };
};
const runner = (over: Partial<ConstructorParameters<typeof RetentionRunner>[0]> = {}): RetentionRunner =>
  new RetentionRunner({ client: roleClient(env.client, "outlet_worker"), marketId: "EG", dryRun: false, log, ...over });
const count = async (t: string): Promise<number> => Number((await env.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]?.n);

const outbox = (market: string, publishedAgo: number | null): Promise<unknown> =>
  env.client.query(
    "INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, published_at) VALUES ($1,$2,'x',$3,'x.y','{}'::jsonb,$4,$5)",
    [uuidv7(), market, randomUUID(), ago(200), publishedAgo === null ? null : ago(publishedAgo)],
  );
const dlq = (status: string, resolvedAgo: number | null): Promise<unknown> =>
  env.client.query("INSERT INTO dlq_messages (id, consumer, message_id, payload, error, attempts, status, created_at, resolved_at) VALUES ($1,'c',$2,'{}'::jsonb,'e',1,$3,$4,$5)", [
    randomUUID(), randomUUID(), status, ago(300), resolvedAgo === null ? null : ago(resolvedAgo),
  ]);
const inbox = (processedAgo: number): Promise<unknown> => env.client.query("INSERT INTO inbox_processed (consumer, message_id, processed_at) VALUES ('c',$1,$2)", [randomUUID(), ago(processedAgo)]);
const attention = (status: "OPEN" | "RESOLVED", createdAgo: number, market = "EG"): Promise<unknown> =>
  env.client.query(
    `INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id, status, created_at, acked_at, resolved_at, resolution_code)
     VALUES ($1,$2,'refund.attention','refund',$3,$4,$5,$5,$6,$7)`,
    [uuidv7(), market, randomUUID(), status, ago(createdAgo), status === "RESOLVED" ? ago(createdAgo) : null, status === "RESOLVED" ? "FIXED_MANUALLY" : null],
  );
const notif = (userId: string, status: string, createdAgo: number): Promise<unknown> =>
  env.client.query(
    `INSERT INTO notification_log (id, user_id, market_id, template_code, category, channel, dedupe_key, status, created_at)
     VALUES ($1,$2,'EG','t','transactional','in_app',$3,$4,$5)`,
    [uuidv7(), userId, randomUUID(), status, ago(createdAgo)],
  );
const sales = async (marketDaysAgo: number, storeId: string): Promise<void> => {
  const day = ago(marketDaysAgo).toISOString().slice(0, 10);
  await env.client.query("INSERT INTO market_sales_daily (market_id, day, currency, orders_paid, gmv_minor, refunded_minor, refreshed_at) VALUES ('EG',$1,'EGP',1,1,0,now())", [day]);
  await env.client.query(
    "INSERT INTO store_sales_daily (market_id, store_id, day, currency, orders_paid, gmv_minor, store_name_ar, refreshed_at) VALUES ('EG',$1,$2,'EGP',1,1,'م',now())",
    [storeId, day],
  );
};
const makeStore = async (): Promise<string> => {
  const seller = randomUUID();
  const store = randomUUID();
  await env.client.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type, status) VALUES ($1,'EG','EG','company','draft')", [seller]);
  await env.client.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1,$2,'EG','s','متجر','local','EG')", [store, seller]);
  return store;
};
const seed = async (): Promise<void> => {
  await outbox("EG", 90); await outbox("EG", 10); await outbox("EG", null); await outbox("AE", 90);
  await dlq("replayed", 70); await dlq("discarded", 70); await dlq("open", null); await dlq("replayed", 10);
  await inbox(70); await inbox(10);
  await attention("RESOLVED", 800); await attention("OPEN", 800); await attention("RESOLVED", 30); await attention("RESOLVED", 800, "AE");
  const u = await insertUser(env.client);
  await notif(u, "sent", 400); await notif(u, "queued", 400); await notif(u, "sent", 30);
  const store = await makeStore();
  await sales(800, store); await sales(30, store);
  await env.client.query("INSERT INTO admin_dashboard_snapshots (market_id, tile_key, as_of, payload) VALUES ('EG','gmv',$1,'{}'::jsonb)", [ago(900)]);
};

describe("RetentionRunner", () => {
  it("deletes rows older than each cutoff and keeps everything else, table by table", async () => {
    await seed();
    const m = spy();
    const out = await runner({ metrics: m }).run();
    expect(out.every((o) => o.mode === "purged")).toBe(true);
    expect(Object.fromEntries(out.map((o) => [o.table, o.rows]))).toEqual({
      outbox_events: 1, dlq_messages: 2, inbox_processed: 1, attention_items: 1, notification_log: 1, market_sales_daily: 1, store_sales_daily: 1,
    });
    expect(Object.fromEntries(m.purgedBy)).toEqual({ outbox_events: 1, dlq_messages: 2, inbox_processed: 1, attention_items: 1, notification_log: 1, market_sales_daily: 1, store_sales_daily: 1 });
    // outbox: EG old published gone; young published, old unpublished and the AE row stay
    expect(await count("outbox_events")).toBe(3);
    expect((await env.client.query("SELECT 1 FROM outbox_events WHERE published_at IS NULL")).rows).toHaveLength(1);
    expect((await env.client.query("SELECT 1 FROM outbox_events WHERE market_id = 'AE'")).rows).toHaveLength(1);
    expect((await env.client.query<{ status: string }>("SELECT status FROM dlq_messages ORDER BY status")).rows.map((r) => r.status)).toEqual(["open", "replayed"]);
    expect(await count("inbox_processed")).toBe(1);
    // attention: old OPEN, young RESOLVED and the AE resolved row stay
    expect(await count("attention_items")).toBe(3);
    expect((await env.client.query<{ status: string }>("SELECT status FROM notification_log ORDER BY status")).rows.map((r) => r.status)).toEqual(["queued", "sent"]);
    expect(await count("market_sales_daily")).toBe(1);
    expect(await count("store_sales_daily")).toBe(1);
    // the overwritten-in-place tile is never purged
    expect(await count("admin_dashboard_snapshots")).toBe(1);
    expect(NOT_PURGED.map((n) => n.table)).toEqual(["admin_dashboard_snapshots"]);
    expect(PURGE_SPECS.map((s) => s.table)).not.toContain("admin_dashboard_snapshots");
  });

  it("is idempotent: a second run deletes nothing", async () => {
    await seed();
    await runner().run();
    const again = await runner().run();
    expect(again.map((o) => o.rows)).toEqual(again.map(() => 0));
    expect(await count("inbox_processed")).toBe(1);
  });

  it("dry run counts and deletes nothing", async () => {
    await seed();
    const m = spy();
    const before = await Promise.all(["outbox_events", "dlq_messages", "inbox_processed", "attention_items", "notification_log", "market_sales_daily", "store_sales_daily"].map(count));
    const out = await runner({ dryRun: true, metrics: m }).run();
    expect(out.every((o) => o.mode === "dry_run")).toBe(true);
    expect(Object.fromEntries(m.dueBy)).toEqual({ outbox_events: 1, dlq_messages: 2, inbox_processed: 1, attention_items: 1, notification_log: 1, market_sales_daily: 1, store_sales_daily: 1 });
    expect(m.purgedBy.size).toBe(0);
    expect(await Promise.all(["outbox_events", "dlq_messages", "inbox_processed", "attention_items", "notification_log", "market_sales_daily", "store_sales_daily"].map(count))).toEqual(before);
  });

  it("dry run is the default", async () => {
    await inbox(70);
    await new RetentionRunner({ client: roleClient(env.client, "outlet_worker"), marketId: "EG", log }).run();
    expect(await count("inbox_processed")).toBe(1);
  });

  it("deletes in batches of at most the batch size and stops when the time budget is spent", async () => {
    for (let i = 0; i < 5; i++) await inbox(70);
    const m = spy();
    const calls: number[] = [];
    const wrapped: RetentionMetricsPort = { ...m, purged: (t, mk, n) => { if (t === "inbox_processed") calls.push(n); m.purged(t, mk, n); } };
    const out = await runner({ metrics: wrapped, batchRows: 2 }).run();
    expect(calls).toEqual([2, 2, 1]);
    expect(out.find((o) => o.table === "inbox_processed")).toMatchObject({ rows: 5, mode: "purged" });
    expect(await count("inbox_processed")).toBe(0);

    for (let i = 0; i < 5; i++) await inbox(70);
    const slow = await runner({ batchRows: 2, budgetMs: 0 }).run();
    expect(slow.find((o) => o.table === "inbox_processed")).toMatchObject({ rows: 2, partial: true });
    expect(await count("inbox_processed")).toBe(3);
  });

  it("never exceeds 5000 rows per statement even when asked for more", () => {
    const r = new RetentionRunner({ client: roleClient(env.client, "outlet_worker"), marketId: "EG", batchRows: 99_999 });
    expect((r as unknown as { batchRows: number }).batchRows).toBe(5000);
  });

  it("logs counts and table names only", async () => {
    lines.length = 0;
    await seed();
    await runner().run();
    const summary = lines.find((l) => JSON.stringify(l).includes("privacy.retention: run finished"));
    expect(summary).toBeDefined();
    expect(JSON.stringify(lines)).not.toMatch(/@|\+20|payload/);
  });

  describe("fail closed", () => {
    it("an unreadable inventory skips every table and deletes nothing", async () => {
      await seed();
      const m = spy();
      const out = await runner({ metrics: m, loadRules: () => Promise.reject(new Error("ENOENT")) }).run();
      expect(out.every((o) => o.mode === "skipped" && o.reason === "inventory_unreadable")).toBe(true);
      expect([...m.skippedBy.keys()].sort()).toEqual(PURGE_SPECS.map((s) => s.table).sort());
      expect(await count("inbox_processed")).toBe(2);
      expect(await count("outbox_events")).toBe(4);
    });

    it("a missing file path is the same as unreadable", async () => {
      await inbox(70);
      const out = await runner({ inventoryPath: "/nonexistent/data_inventory.yaml" }).run();
      expect(out.every((o) => o.reason === "inventory_unreadable")).toBe(true);
      expect(await count("inbox_processed")).toBe(1);
    });

    it("a table whose rule is missing or changed is skipped, the others still run", async () => {
      await seed();
      const real = await loadRetentionRules();
      const rules = new Map(real.rules);
      rules.delete("ops_attention_24m");
      rules.set("notification_12m", "6 months");
      const inv: InventoryRules = { rules, tables: real.tables };
      const m = spy();
      const out = await runner({ metrics: m, loadRules: () => Promise.resolve(inv) }).run();
      expect(m.skippedBy.get("attention_items")).toBe("rule_missing");
      expect(m.skippedBy.get("notification_log")).toBe("rule_changed");
      expect(out.find((o) => o.table === "outbox_events")).toMatchObject({ mode: "purged", rows: 1 });
      expect(await count("attention_items")).toBe(4);
      expect(await count("notification_log")).toBe(3);
    });

    it("a table missing from the inventory is skipped", async () => {
      const real = await loadRetentionRules();
      const inv: InventoryRules = { rules: real.rules, tables: new Set([...real.tables].filter((t) => t !== "inbox_processed")) };
      const m = spy();
      await runner({ metrics: m, loadRules: () => Promise.resolve(inv) }).run();
      expect(m.skippedBy.get("inbox_processed")).toBe("rule_missing");
    });

    it("a database error on one table is logged and skipped, the others still run", async () => {
      await seed();
      await env.client.query("DROP TABLE notification_log");
      const m = spy();
      const out = await runner({ metrics: m }).run();
      expect(m.skippedBy.get("notification_log")).toBe("error");
      expect(out.find((o) => o.table === "inbox_processed")).toMatchObject({ mode: "purged", rows: 1 });
    });
  });

  it("the real inventory carries every rule and table the specs name, with the period the specs apply", async () => {
    const inv = await loadRetentionRules();
    for (const s of PURGE_SPECS) {
      expect(inv.tables.has(s.table)).toBe(true);
      expect(inv.rules.get(s.rule)).toMatch(s.ruleText);
    }
    expect(inv.rules.get("dashboard_snapshot_overwrite")).toBeDefined();
  });
});

describe("RetentionConsumer", () => {
  const tick = { scope: "retention", window: "retention:2026-11-10:03" };
  const consumer = (dryRun = false): { c: RetentionConsumer; m: Spy } => {
    const m = spy();
    return { c: new RetentionConsumer(roleClient(env.client, "outlet_worker"), "EG", runner({ dryRun, metrics: m }), log), m };
  };

  it("runs the purge once per tick and records the inbox row; a redelivery is a duplicate", async () => {
    await inbox(70);
    const { c, m } = consumer();
    const id = uuidv7();
    expect(await c.handle({ id, type: RETENTION_REQUESTED_EVENT, payload: tick })).toBe("processed");
    expect(m.purgedBy.get("inbox_processed")).toBe(1);
    expect((await env.client.query("SELECT 1 FROM inbox_processed WHERE consumer = 'privacy.retention' AND message_id = $1", [id])).rows).toHaveLength(1);
    await inbox(70);
    expect(await c.handle({ id, type: RETENTION_REQUESTED_EVENT, payload: tick })).toBe("duplicate");
    expect(await count("inbox_processed")).toBe(2); // the new old row was not purged: no second run
  });

  it("parks a malformed payload or a foreign type without running anything", async () => {
    await inbox(70);
    const { c, m } = consumer();
    expect(await c.handle({ id: uuidv7(), type: RETENTION_REQUESTED_EVENT, payload: { scope: "sales" } })).toBe("processed");
    expect(await c.handle({ id: uuidv7(), type: "other.thing", payload: tick })).toBe("processed");
    expect(m.purgedBy.size).toBe(0);
    expect(await count("inbox_processed")).toBe(3);
  });

  it("does not record the inbox row when the run throws, so the tick is redelivered", async () => {
    const bad = { run: () => Promise.reject(new Error("x")) } as unknown as RetentionRunner;
    const c = new RetentionConsumer(roleClient(env.client, "outlet_worker"), "EG", bad, log);
    const id = uuidv7();
    await expect(c.handle({ id, type: RETENTION_REQUESTED_EVENT, payload: tick })).rejects.toThrow("x");
    expect((await env.client.query("SELECT 1 FROM inbox_processed WHERE message_id = $1", [id])).rows).toHaveLength(0);
  });
});
