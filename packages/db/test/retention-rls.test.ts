import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDbContext } from "../src/index.js";
import type { DbContext, WorkerJob } from "../src/index.js";
import type { SqlClient } from "../src/sql.js";
import { asRole, createTestClient } from "../src/testing.js";

// Migration 0040: only the `privacy.retention` worker job may DELETE from the purgeable tables, only rows past the cutoff of their rule, market-pinned
// where the table has a market_id. Every other job and role is refused; inbox_processed (RLS enabled by 0040) stays readable and insertable by every job.

const worker = (job: WorkerJob, marketId = "EG"): DbContext => ({ kind: "worker", marketId, job });
let c: SqlClient;
let close: () => Promise<void>;
const DAY = 86_400_000;
const ago = (d: number): Date => new Date(Date.now() - d * DAY);

interface Target {
  readonly table: string;
  readonly old: () => Promise<void>;
  readonly young: () => Promise<void>;
}
const user = randomUUID();
const store = randomUUID();
const targets: Target[] = [
  {
    table: "outbox_events",
    old: async () => {
      await c.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, published_at) VALUES ($1,'EG','x',$2,'x.y','{}',$3,$3)", [randomUUID(), randomUUID(), ago(90)]);
    },
    young: async () => {
      await c.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, published_at) VALUES ($1,'EG','x',$2,'x.y','{}',$3,$3)", [randomUUID(), randomUUID(), ago(5)]);
    },
  },
  {
    table: "dlq_messages",
    old: async () => {
      await c.query("INSERT INTO dlq_messages (id, consumer, message_id, payload, error, attempts, status, resolved_at) VALUES ($1,'c',$2,'{}','e',1,'discarded',$3)", [randomUUID(), randomUUID(), ago(90)]);
    },
    young: async () => {
      await c.query("INSERT INTO dlq_messages (id, consumer, message_id, payload, error, attempts, status, resolved_at) VALUES ($1,'c',$2,'{}','e',1,'discarded',$3)", [randomUUID(), randomUUID(), ago(5)]);
    },
  },
  {
    table: "inbox_processed",
    old: async () => {
      await c.query("INSERT INTO inbox_processed (consumer, message_id, processed_at) VALUES ('c',$1,$2)", [randomUUID(), ago(90)]);
    },
    young: async () => {
      await c.query("INSERT INTO inbox_processed (consumer, message_id, processed_at) VALUES ('c',$1,$2)", [randomUUID(), ago(5)]);
    },
  },
  {
    table: "attention_items",
    old: async () => {
      await c.query("INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id, status, created_at, resolved_at, resolution_code) VALUES ($1,'EG','refund.attention','refund',$2,'RESOLVED',$3,$3,'DUPLICATE')", [randomUUID(), randomUUID(), ago(800)]);
    },
    young: async () => {
      await c.query("INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id, status, created_at, resolved_at, resolution_code) VALUES ($1,'EG','refund.attention','refund',$2,'RESOLVED',$3,$3,'DUPLICATE')", [randomUUID(), randomUUID(), ago(5)]);
    },
  },
  {
    table: "notification_log",
    old: async () => {
      await c.query("INSERT INTO notification_log (id, user_id, market_id, template_code, category, channel, dedupe_key, status, created_at) VALUES ($1,$2,'EG','t','transactional','in_app',$3,'sent',$4)", [randomUUID(), user, randomUUID(), ago(400)]);
    },
    young: async () => {
      await c.query("INSERT INTO notification_log (id, user_id, market_id, template_code, category, channel, dedupe_key, status, created_at) VALUES ($1,$2,'EG','t','transactional','in_app',$3,'sent',$4)", [randomUUID(), user, randomUUID(), ago(5)]);
    },
  },
  {
    table: "market_sales_daily",
    old: async () => {
      await c.query("INSERT INTO market_sales_daily (market_id, day, currency, orders_paid, gmv_minor, refunded_minor, refreshed_at) VALUES ('EG',$1,'EGP',1,1,0,now())", [ago(800).toISOString().slice(0, 10)]);
    },
    young: async () => {
      await c.query("INSERT INTO market_sales_daily (market_id, day, currency, orders_paid, gmv_minor, refunded_minor, refreshed_at) VALUES ('EG',$1,'EGP',1,1,0,now())", [ago(5).toISOString().slice(0, 10)]);
    },
  },
  {
    table: "store_sales_daily",
    old: async () => {
      await c.query("INSERT INTO store_sales_daily (market_id, store_id, day, currency, orders_paid, gmv_minor, store_name_ar, refreshed_at) VALUES ('EG',$1,$2,'EGP',1,1,'م',now())", [store, ago(800).toISOString().slice(0, 10)]);
    },
    young: async () => {
      await c.query("INSERT INTO store_sales_daily (market_id, store_id, day, currency, orders_paid, gmv_minor, store_name_ar, refreshed_at) VALUES ('EG',$1,$2,'EGP',1,1,'م',now())", [store, ago(5).toISOString().slice(0, 10)]);
    },
  },
];

const del = (table: string, ctx: DbContext, role: "outlet_worker" | "outlet_app" = "outlet_worker"): Promise<number> =>
  asRole(c, role, async (tx) => {
    await applyDbContext(tx, ctx);
    return (await tx.query(`DELETE FROM ${table} RETURNING 1`)).rows.length;
  });
const total = async (table: string): Promise<number> => Number((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n);

beforeAll(async () => {
  ({ client: c, close } = await createTestClient());
  const seller = randomUUID();
  await c.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',now(),now())", [user]);
  await c.query("INSERT INTO sellers (id, home_market_id, market_id, legal_type, status) VALUES ($1,'EG','EG','company','draft')", [seller]);
  await c.query("INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country) VALUES ($1,$2,'EG','s','متجر','local','EG')", [store, seller]);
});
afterAll(async () => close());

describe("retention deletes (migration 0040)", () => {
  const others: WorkerJob[] = ["outbox.relay", "ops.attention", "reporting.rollup", "admin.dashboard", "notifications.dispatch", "auth.purge", "privacy.deletion", "finance.reconcile", "search.sync"];

  for (const t of targets) {
    it(`${t.table}: only privacy.retention deletes, only past-cutoff rows, only its market`, async () => {
      await t.old();
      await t.young();
      const before = await total(t.table);
      // every other job: a delete is refused (no policy) or removes nothing
      for (const job of others) {
        const n = await del(t.table, worker(job)).catch((e: unknown) => (/permission denied|row-level security/.test(String(e)) ? 0 : Promise.reject(e instanceof Error ? e : new Error(String(e)))));
        expect(n).toBe(0);
      }
      expect(await total(t.table)).toBe(before);
      // another market sees nothing (market-pinned tables)
      // (dlq_messages and inbox_processed have no market_id: the cutoff is their only bound)
      if (!["dlq_messages", "inbox_processed"].includes(t.table)) expect(await del(t.table, worker("privacy.retention", "AE"))).toBe(0);
      // the retention job removes exactly the rows past the cutoff
      const removed = await del(t.table, worker("privacy.retention"));
      expect(removed).toBeGreaterThanOrEqual(1);
      const left = await total(t.table);
      expect(left).toBeGreaterThanOrEqual(1);
      expect(before - left).toBe(removed);
      // the young row is still there on a second pass
      expect(await del(t.table, worker("privacy.retention"))).toBe(0);
    });
  }

  it("the app role deletes nothing (no grant, or RLS default-deny: inbox_processed has no app policy)", async () => {
    for (const t of ["outbox_events", "dlq_messages", "inbox_processed", "attention_items", "notification_log", "market_sales_daily", "store_sales_daily"]) {
      const before = await total(t);
      const n = await del(t, { kind: "user", marketId: "EG", userId: user }, "outlet_app").catch((e: unknown) => (/permission denied|row-level security/.test(String(e)) ? 0 : Promise.reject(e instanceof Error ? e : new Error(String(e)))));
      expect(n).toBe(0);
      expect(await total(t)).toBe(before);
    }
  });

  it("unpublished or unresolved rows are never deleted, however old", async () => {
    await c.query("INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ($1,'EG','x',$2,'x.y','{}',$3)", [randomUUID(), randomUUID(), ago(400)]);
    await c.query("INSERT INTO dlq_messages (id, consumer, message_id, payload, error, attempts, status, created_at) VALUES ($1,'c',$2,'{}','e',1,'open',$3)", [randomUUID(), randomUUID(), ago(400)]);
    await c.query("INSERT INTO attention_items (id, market_id, kind, ref_type, ref_id, status, created_at) VALUES ($1,'EG','refund.attention','refund',$2,'OPEN',$3)", [randomUUID(), randomUUID(), ago(900)]);
    await c.query("INSERT INTO notification_log (id, user_id, market_id, template_code, category, channel, dedupe_key, status, created_at) VALUES ($1,$2,'EG','t','transactional','in_app',$3,'queued',$4)", [randomUUID(), user, randomUUID(), ago(900)]);
    for (const t of ["outbox_events", "dlq_messages", "attention_items", "notification_log"]) {
      const before = await total(t);
      await del(t, worker("privacy.retention"));
      expect(await total(t)).toBeGreaterThanOrEqual(1);
      expect((await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE ${t === "outbox_events" ? "published_at IS NULL" : t === "dlq_messages" ? "status = 'open'" : t === "attention_items" ? "status = 'OPEN'" : "status = 'queued'"}`)).rows[0]?.n).toBe(1);
      expect(before).toBeGreaterThanOrEqual(1);
    }
  });

  it("outlet_app may record only the two inventory release consumers, in a store context (and read them back), nothing else", async () => {
    const store = randomUUID();
    const ins = (consumer: string, ctx: DbContext): Promise<number> =>
      asRole(c, "outlet_app", async (tx) => {
        await applyDbContext(tx, ctx);
        return (await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1,$2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [consumer, randomUUID()])).rows.length;
      });
    const storeCtx: DbContext = { kind: "store", marketId: "EG", storeId: store };
    expect(await ins("inventory.release_required", storeCtx)).toBe(1);
    expect(await ins("inventory.release_required.seller_order", storeCtx)).toBe(1);
    await expect(ins("some.other_consumer", storeCtx)).rejects.toThrow(/row-level security/);
    await expect(ins("inventory.release_required", { kind: "user", marketId: "EG", userId: randomUUID() })).rejects.toThrow(/row-level security/);
    const id = randomUUID();
    await asRole(c, "outlet_app", async (tx) => {
      await applyDbContext(tx, storeCtx);
      await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ('inventory.release_required',$1)", [id]);
      expect((await tx.query("SELECT 1 FROM inbox_processed WHERE message_id = $1", [id])).rows).toHaveLength(1);
      expect((await tx.query("DELETE FROM inbox_processed RETURNING 1")).rows).toHaveLength(0);
    });
  });

  it("inbox_processed stays readable and insertable by every worker job (RLS enabled, no job locked out)", async () => {
    for (const job of ["outbox.relay", "ops.attention", "privacy.retention", "reporting.rollup"] as const) {
      await asRole(c, "outlet_worker", async (tx) => {
        await applyDbContext(tx, worker(job));
        const id = randomUUID();
        await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ('x',$1)", [id]);
        expect((await tx.query("SELECT 1 FROM inbox_processed WHERE message_id = $1", [id])).rows).toHaveLength(1);
      });
    }
  });
});
