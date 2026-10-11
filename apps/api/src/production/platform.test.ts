import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyAuditSink, KyselyIdempotencyStore, KyselyExportAudit, uuidFrom } from "./platform-adapters";
import { PRODUCTION_RUNTIME, type ProductionRuntime } from "./compose";
import { createProductionRelay } from "./relay";
import { bootProduction, type ProductionTestApp } from "./test/test-support";

const SCOPE = { actor: "user:abc", key: "0190a000-0000-7000-8000-00000000aaaa" };
const REQ = { scope: SCOPE, route: "POST /v1/checkout", requestHash: "h".repeat(64), claimToken: "t1", nowMs: 1_800_000_000_000, ttlMs: 86_400_000, leaseMs: 30_000 };

describe("production platform adapters over Postgres (PGlite)", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  it("idempotency: acquire, in-flight duplicate, complete, replay, release, lease takeover", async () => {
    const store = new KyselyIdempotencyStore(t.db);
    expect(await store.claim(REQ)).toEqual({ kind: "acquired" });
    const dup = await store.claim({ ...REQ, claimToken: "t2", nowMs: REQ.nowMs + 1000 });
    expect(dup.kind).toBe("existing");
    if (dup.kind === "existing") {
      expect(dup.record.state).toBe("in_flight");
      expect(dup.record.route).toBe("POST /v1/checkout");
      expect(dup.record.requestHash).toBe("h".repeat(64));
    }
    // A foreign token cannot complete or release.
    expect(await store.complete(SCOPE, "other", { status: 200, headers: {}, body: null }, REQ.nowMs)).toBe(false);
    expect(await store.release(SCOPE, "other")).toBe(false);
    const response = { status: 201, headers: { "content-type": "application/json" }, body: { ok: true } };
    expect(await store.complete(SCOPE, "t1", response, REQ.nowMs + 2000)).toBe(true);
    const replay = await store.claim({ ...REQ, claimToken: "t3", nowMs: REQ.nowMs + 3000 });
    expect(replay.kind).toBe("existing");
    if (replay.kind === "existing") expect(replay.record).toMatchObject({ state: "completed", response });
    // Once expired the key is claimable again.
    expect(await store.claim({ ...REQ, claimToken: "t4", nowMs: REQ.nowMs + REQ.ttlMs + 1 })).toEqual({ kind: "acquired" });
    expect(await store.release(SCOPE, "t4")).toBe(true);
    // Lease takeover of a crashed in-flight claim.
    const s2 = { actor: "user:abc", key: "0190a000-0000-7000-8000-00000000bbbb" };
    expect(await store.claim({ ...REQ, scope: s2 })).toEqual({ kind: "acquired" });
    expect(await store.claim({ ...REQ, scope: s2, claimToken: "t9", nowMs: REQ.nowMs + REQ.leaseMs + 1 })).toEqual({ kind: "acquired" });
  });

  it("idempotency scopes do not collide across actors", async () => {
    const store = new KyselyIdempotencyStore(t.db);
    const a = { actor: "user:one", key: "0190a000-0000-7000-8000-00000000cccc" };
    const b = { actor: "user:two", key: "0190a000-0000-7000-8000-00000000cccc" };
    expect(await store.claim({ ...REQ, scope: a })).toEqual({ kind: "acquired" });
    expect(await store.claim({ ...REQ, scope: b })).toEqual({ kind: "acquired" });
    expect(uuidFrom("actor", "user:one")).not.toBe(uuidFrom("actor", "user:two"));
  });

  it("audit sinks append to the hash-chained audit_log and the chain verifies", async () => {
    const sink = new KyselyAuditSink(t.db);
    const base = { effect: "allow" as const, actorId: "0190a000-0000-7000-8000-0000000000a1", resourceType: "order" as never, resourceId: "0190a000-0000-7000-8000-0000000000b1", ruleId: "r1", reason: "allowed" as const, httpStatus: 200 as never, approverIds: [], atMs: 1_800_000_000_000 };
    await sink.record({ ...base, action: "orders.read" as never });
    await sink.record({ ...base, effect: "deny", action: "orders.refund" as never, reason: "role" as never, httpStatus: 403 as never });
    await new KyselyExportAudit(t.db).record({ action: "seller_analytics.export", actorId: "0190a000-0000-7000-8000-0000000000a1", storeId: "0190a000-0000-7000-8000-0000000000c1", report: "sales", rowCount: 3, watermark: "w", fromMs: 1, toMs: 2, atMs: 1_800_000_000_000 });
    const rows = await t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql<{ chain_id: string; seq: string }>`SELECT chain_id, seq::text FROM audit_log WHERE chain_id LIKE 'authz:%' ORDER BY seq`.execute(trx);
      const p = await sql<{ problem: string }>`SELECT problem FROM audit_log_verify()`.execute(trx);
      return { r: r.rows, p: p.rows };
    });
    expect(rows.r.map((x) => x.seq)).toEqual(["1", "2"]);
    expect(rows.r.every((x) => x.chain_id === "authz:2027-01")).toBe(true);
    expect(rows.p).toEqual([]);
  });
});

describe("outbox relay over Postgres (PGlite)", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  const insert = async (id: string, type: string, payload: object): Promise<void> => {
    await t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      await sql`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
        VALUES (${id}::uuid, 'agg', ${id}::uuid, ${type}, ${JSON.stringify(payload)}::jsonb)`.execute(trx);
    });
  };
  const state = async (id: string): Promise<{ published: boolean; attempts: number }> =>
    t.db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql<{ p: boolean; a: number }>`SELECT (published_at IS NOT NULL) AS p, publish_attempts AS a FROM outbox_events WHERE id = ${id}::uuid`.execute(trx);
      return { published: r.rows[0]?.p ?? false, attempts: r.rows[0]?.a ?? -1 };
    });

  it("drains events: unrouted types are acknowledged and counted, malformed payment events retry", async () => {
    const runtime = t.app.get<ProductionRuntime>(PRODUCTION_RUNTIME, { strict: false });
    const relay = createProductionRelay(runtime);
    const a = "0190a000-0000-7000-8000-0000000000e1";
    const b = "0190a000-0000-7000-8000-0000000000e2";
    await insert(a, "catalog.product_created", { id: "p1" });
    await insert(b, "payment.succeeded", { malformed: true });
    const report = await relay.runOnce();
    expect(report).toMatchObject({ published: 1, retryScheduled: 1 });
    expect(await state(a)).toEqual({ published: true, attempts: 0 });
    expect(await state(b)).toEqual({ published: false, attempts: 1 });
    expect(relay.publisher.unroutedCounts().get("catalog.product_created")).toBe(1);
  });
});
