import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdempotencyStore, requestHash } from "@outlet/idempotency";
import { InventoryService, ReservationService } from "@outlet/inventory";
import type { InventoryDeps } from "@outlet/inventory";
import { Ledger, accountCode } from "@outlet/ledger";
import { money } from "@outlet/money";
import { OutboxRelay } from "@outlet/outbox";
import type { OutboxEvent } from "@outlet/outbox";
import type { Principal } from "@outlet/policy";
import { contextClient, withDbContext } from "../src/index.js";
import { ENABLED, MARKET, pool, seedTenant, sqlClient } from "./helpers.js";
import type { Tenant } from "./helpers.js";

describe.skipIf(!ENABLED)("real-Postgres concurrency", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  let A: Tenant;
  beforeAll(async () => {
    admin = pool("DIRECT", 2, "test-admin");
    app = pool("APP", 50, "checkout.reserve");
    worker = pool("WORKER", 4, "test-worker");
    A = await seedTenant(admin, "conc");
  });
  afterAll(async () => {
    await Promise.all([admin.end(), app.end(), worker.end()]);
  });

  const staff: Principal = { kind: "seller_staff", userId: randomUUID(), marketId: MARKET, storeIds: [], roles: ["owner"], scopes: [] };
  const makeSku = async (onHand: number): Promise<string> => {
    const skuId = randomUUID();
    await admin.query(`INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, price_minor, currency) VALUES ($1,$2,$3,'EG',$4,10000,'EGP')`, [skuId, A.productIds[1], A.storeId, `S-${skuId}`]);
    const deps: InventoryDeps = { client: sqlClient<"outlet_app">(app), marketId: MARKET };
    await new InventoryService(deps).adjustOnHand({ ...staff, storeIds: [A.storeId] }, { skuId, locationId: A.locationId, storeId: A.storeId, delta: onHand, idempotencyKey: `seed-${skuId}`, source: "seller_edit" });
    return skuId;
  };
  const counts = async (sku: string) =>
    (await admin.query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM inventory_units WHERE sku_id = $1 GROUP BY state", [sku])).rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.state]: r.n }), {});

  it("500 concurrent reserves on 100 units (statement_timeout 2 s): exactly 100 reserved, 0 oversold, no errors or deadlocks", async () => {
    const sku = await makeSku(100);
    const res = new ReservationService({ client: sqlClient<"outlet_app">(app), marketId: MARKET });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 500 }, (_, i) => res.reserve({ orderGroupRef: `og-${sku}-${String(i)}`, userId: randomUUID(), items: [{ skuId: sku, locationId: A.locationId, storeId: A.storeId, qty: 1 }] })),
    );
    const errors = outcomes.filter((o) => o.status === "rejected").map((o) => String((o).reason));
    expect(errors).toEqual([]);
    const ok = outcomes.filter((o) => o.status === "fulfilled" && o.value.ok).length;
    expect(ok).toBe(100);
    const c = await counts(sku);
    expect(c.reserved).toBe(100);
    expect(c.available ?? 0).toBe(0);
    const lvl = (await admin.query<{ on_hand: number; committed: number }>("SELECT on_hand, committed FROM inventory_levels WHERE sku_id = $1", [sku])).rows[0];
    expect(lvl?.on_hand).toBe(100);
    expect(lvl?.committed ?? 0).toBeLessThanOrEqual(100);
  });

  it("50 concurrent reserve+release cycles keep the pool invariants", async () => {
    const sku = await makeSku(10);
    const res = new ReservationService({ client: sqlClient<"outlet_app">(app), marketId: MARKET });
    const cycle = async (i: number): Promise<void> => {
      const userId = randomUUID();
      const r = await res.reserve({ orderGroupRef: `cyc-${sku}-${String(i)}`, userId, items: [{ skuId: sku, locationId: A.locationId, storeId: A.storeId, qty: 1 }] });
      if (r.ok) await res.release(userId, r.reservationId);
    };
    const out = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => cycle(i)));
    expect(out.filter((o) => o.status === "rejected").map((o) => String((o).reason))).toEqual([]);
    const c = await counts(sku);
    expect(c.reserved ?? 0).toBe(0);
    expect(c.available).toBe(10);
  });

  it("two concurrent Ledger.post on one market serialize through the advisory lock; the chain has no gaps and verifies", async () => {
    const market = "EG";
    const draft = (key: string) => ({
      kind: "store_credit_granted",
      idempotencyKey: key,
      marketId: market,
      occurredAt: new Date("2026-11-08T10:00:00.000Z"),
      ref: { type: "test", id: key },
      postings: [
        { accountCode: accountCode({ type: "goodwill_expense", market, currency: "EGP" }), amount: money(5n, "EGP") },
        { accountCode: accountCode({ type: "store_credit", market, currency: "EGP", owner: "usr_pg", sub: "goodwill" }), amount: money(-5n, "EGP") },
      ],
    });
    const c = sqlClient<"outlet_app">(app);
    const tag = randomUUID();
    const before = (await admin.query<{ n: string }>("SELECT count(*)::text n FROM journal_entries WHERE market_id = $1", [market])).rows[0]?.n ?? "0";
    const results = await Promise.all(
      Array.from({ length: 2 }, (_, i) => withDbContext(c, { kind: "user", marketId: market, userId: A.userId }, (tx) => Ledger.post(tx, draft(`pg-${tag}-${String(i)}`)))),
    );
    expect(new Set(results.map((r) => r.entryId)).size).toBe(2);
    // 20 more in parallel to give the lock real contention.
    await Promise.all(Array.from({ length: 20 }, (_, i) => withDbContext(c, { kind: "user", marketId: market, userId: A.userId }, (tx) => Ledger.post(tx, draft(`pg-${tag}-m${String(i)}`)))));
    const seq = (await admin.query<{ chain_seq: string }>("SELECT chain_seq::text FROM journal_entries WHERE market_id = $1 ORDER BY journal_entries.chain_seq", [market])).rows.map((r) => Number(r.chain_seq));
    expect(seq.length).toBe(Number(before) + 22);
    expect(seq).toEqual(seq.map((_, i) => i + 1));
    const verified = await withDbContext(c, { kind: "user", marketId: market, userId: A.userId }, (tx) => Ledger.verifyChain(tx, market));
    expect(verified.ok).toBe(true);
  });

  it("20 concurrent IdempotencyStore.begin with the same key: exactly one fresh", async () => {
    const store = new IdempotencyStore(sqlClient<"outlet_app">(app));
    const input = { key: randomUUID(), route: "POST /v1/checkout", actorId: A.userId, requestHash: requestHash({ a: 1 }) };
    const r = await Promise.all(Array.from({ length: 20 }, () => store.begin(input)));
    expect(r.filter((x) => x.kind === "fresh").length).toBe(1);
    expect(r.filter((x) => x.kind === "in_progress").length).toBe(19);
  });

  it("two outbox relays on real connections never publish the same event twice (SKIP LOCKED)", async () => {
    const ids: string[] = [];
    const agg = randomUUID();
    for (let i = 0; i < 60; i += 1) {
      const id = `0190${String(i).padStart(4, "0")}-0000-7000-8000-${randomUUID().slice(24)}`;
      ids.push(id);
      await admin.query(
        `INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ($1,'EG','test',$2,'test.pg_relay','{}'::jsonb, now())`,
        [id, agg],
      );
    }
    const mine = new Set(ids);
    const published: string[] = [];
    const publisher = { publish: async (e: OutboxEvent): Promise<void> => { await new Promise((r) => setTimeout(r, 5)); if (mine.has(e.id)) published.push(e.id); } };
    const wc = sqlClient<"outlet_worker">(worker);
    const relay = () => new OutboxRelay({ db: contextClient(wc, { kind: "worker", marketId: MARKET, job: "outbox.relay" }), publisher, batchSize: 10 });
    const a = relay();
    const b = relay();
    const loop = async (r: OutboxRelay): Promise<void> => {
      for (let i = 0; i < 8; i += 1) await r.runOnce();
    };
    await Promise.all([loop(a), loop(b)]);
    expect(published.length).toBe(60);
    expect(new Set(published).size).toBe(60);
  });
});
