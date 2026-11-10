import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@outlet/ids";
import { InboxProcessor, OutboxDispatchRelay } from "@outlet/outbox";
import type { OutboxEvent, SqlClient } from "@outlet/outbox";
import { contextClient } from "../src/index.js";
import { ENABLED, pool, sqlClient } from "./helpers.js";

/**
 * F11: leased outbox dispatch (ADR-0016) on real Postgres with real concurrent connections. PGlite serialises transactions, so SKIP LOCKED, lease
 * races and the relay RLS pin can only be proven here. Every test uses its own event type so leftovers from other files cannot interfere.
 */
describe.skipIf(!ENABLED)("real-Postgres outbox dispatch concurrency", () => {
  let admin: pg.Pool;
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  beforeAll(() => {
    admin = pool("DIRECT", 2, "test-admin");
    poolA = pool("WORKER", 4, "outbox.relay.a");
    poolB = pool("WORKER", 4, "outbox.relay.b");
  });
  afterAll(async () => {
    await Promise.all([admin.end(), poolA.end(), poolB.end()]);
  });

  const relayDb = (p: pg.Pool, market: string): SqlClient => contextClient(sqlClient<"outlet_worker">(p), { kind: "worker", marketId: market, job: "outbox.relay" });
  const seed = async (type: string, n: number, market = "EG"): Promise<string[]> => {
    const ids = Array.from({ length: n }, () => uuidv7());
    const agg = randomUUID();
    await admin.query(
      `INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
       SELECT x, $2, 'test', $3, $4, '{}'::jsonb, now() FROM unnest($1::uuid[]) x`,
      [ids, market, agg, type],
    );
    return ids;
  };
  const rowsOf = async (ids: string[]) =>
    (await admin.query<{ id: string; published_at: Date | null; lease_until: Date | null; attempts: number; dead_lettered_at: Date | null }>(
      "SELECT id, published_at, lease_until, attempts, dead_lettered_at FROM outbox_events WHERE id = ANY($1::uuid[])",
      [ids],
    )).rows;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("two concurrent runners over 200 pending events: each handled exactly once, none lost, all acked", async () => {
    const type = `test.f11.once.x${randomUUID().replaceAll("-", "_")}`;
    const ids = await seed(type, 200);
    const calls = new Map<string, number>();
    const byRunner = { a: 0, b: 0 };
    const mk = (p: pg.Pool, who: "a" | "b") =>
      new OutboxDispatchRelay({
        db: relayDb(p, "EG"),
        batchSize: 20,
        dispatch: async (e: OutboxEvent): Promise<void> => {
          await sleep(2);
          calls.set(e.id, (calls.get(e.id) ?? 0) + 1);
          byRunner[who] += 1;
        },
      });
    const drain = async (r: OutboxDispatchRelay): Promise<void> => {
      for (;;) {
        const res = await r.runOnce({ includeTypes: [type] });
        if (res.claimed === 0) return;
      }
    };
    await Promise.all([drain(mk(poolA, "a")), drain(mk(poolB, "b"))]);
    expect([...calls.keys()].sort()).toEqual([...ids].sort());
    expect([...calls.values()].every((c) => c === 1)).toBe(true);
    expect(byRunner.a + byRunner.b).toBe(200);
    // Both runners really took part (otherwise the test proves nothing about contention).
    expect(byRunner.a).toBeGreaterThan(0);
    expect(byRunner.b).toBeGreaterThan(0);
    const rows = await rowsOf(ids);
    expect(rows.every((r) => r.published_at !== null && r.lease_until === null && r.attempts === 1 && r.dead_lettered_at === null)).toBe(true);
  });

  it("a crashed runner's lease expires, the other runner reclaims, and the inbox makes the redelivery a duplicate", async () => {
    const type = `test.f11.lease.x${randomUUID().replaceAll("-", "_")}`;
    const ids = await seed(type, 3);
    const consumer = `f11-${randomUUID()}`;
    const inbox = new InboxProcessor(relayDb(poolB, "EG"));
    const outcomes: string[] = [];
    const handler = async (e: OutboxEvent): Promise<void> => {
      outcomes.push(await inbox.process(consumer, e.id, () => Promise.resolve()));
    };
    // Runner A: handler (and its inbox row) succeed, but the process "dies" before the ack/release writes: every outbox_events UPDATE throws.
    const real = relayDb(poolA, "EG");
    const crashing: SqlClient = {
      query: (sql, params) => (/^\s*UPDATE outbox_events/i.test(sql) && /published_at|lease_until = NULL/.test(sql) ? Promise.reject(new Error("crashed")) : real.query(sql, params)),
      transaction: (fn) => real.transaction(fn),
    };
    const t0 = new Date();
    // claim() is an UPDATE too, so let exactly the claim through: it is the only statement containing "FOR UPDATE SKIP LOCKED".
    const guarded: SqlClient = {
      query: (sql, params) => (sql.includes("SKIP LOCKED") ? real.query(sql, params) : crashing.query(sql, params)),
      transaction: (fn) => real.transaction(fn),
    };
    const a = new OutboxDispatchRelay({ db: guarded, dispatch: handler, batchSize: 10, leaseMs: 1_000, now: () => t0 });
    await expect(a.runOnce({ includeTypes: [type] })).rejects.toThrow("crashed");
    // The first ack throws and aborts the batch: one event was handled (inbox row written), the other two were claimed but never touched.
    expect(outcomes).toEqual(["processed"]);
    let rows = await rowsOf(ids);
    expect(rows.every((r) => r.published_at === null && r.lease_until !== null)).toBe(true);

    // Runner B before expiry (clock = t0): nothing claimable.
    const bEarly = new OutboxDispatchRelay({ db: relayDb(poolB, "EG"), dispatch: handler, batchSize: 10, now: () => t0 });
    expect((await bEarly.runOnce({ includeTypes: [type] })).claimed).toBe(0);
    // After lease_until: reclaimed and redelivered; the inbox says duplicate, and the event is finally acked.
    const bLate = new OutboxDispatchRelay({ db: relayDb(poolB, "EG"), dispatch: handler, batchSize: 10, now: () => new Date(t0.getTime() + 1_500) });
    const res = await bLate.runOnce({ includeTypes: [type] });
    expect(res).toMatchObject({ claimed: 3, dispatched: 3, failed: 0, deadLettered: 0, released: 0 });
    expect(outcomes.slice(1).sort()).toEqual(["duplicate", "processed", "processed"]);
    rows = await rowsOf(ids);
    expect(rows.every((r) => r.published_at !== null && r.lease_until === null)).toBe(true);
    const inboxRows = await admin.query<{ n: number }>("SELECT count(*)::int n FROM inbox_processed WHERE consumer = $1", [consumer]);
    expect(inboxRows.rows[0]?.n).toBe(3); // one row per event: the redelivered one was NOT written twice
  });

  it("market isolation: an EG runner never claims AE events (and vice versa)", async () => {
    const type = `test.f11.market.x${randomUUID().replaceAll("-", "_")}`;
    const eg = await seed(type, 15, "EG");
    const ae = await seed(type, 15, "AE");
    const seenEg: string[] = [];
    const seenAe: string[] = [];
    const mk = (p: pg.Pool, market: string, sink: string[]) => new OutboxDispatchRelay({ db: relayDb(p, market), batchSize: 50, dispatch: (e) => { sink.push(e.id); return Promise.resolve(); } });
    const egRunner = mk(poolA, "EG", seenEg);
    // EG runner drains everything it can; AE rows must stay untouched.
    expect((await egRunner.runOnce({ includeTypes: [type] })).dispatched).toBe(15);
    expect((await egRunner.runOnce({ includeTypes: [type] })).claimed).toBe(0);
    expect(seenEg.sort()).toEqual([...eg].sort());
    expect((await rowsOf(ae)).every((r) => r.published_at === null && r.lease_until === null && r.attempts === 0)).toBe(true);
    // Concurrent AE runner then takes only AE.
    await Promise.all([mk(poolB, "AE", seenAe).runOnce({ includeTypes: [type] }), egRunner.runOnce({ includeTypes: [type] })]);
    expect(seenAe.sort()).toEqual([...ae].sort());
    expect(seenEg).toHaveLength(15);
  });

  it("kill switch mid-batch: skipped rows are released with attempts unchanged and the other runner claims them", async () => {
    const type = `test.f11.skip.x${randomUUID().replaceAll("-", "_")}`;
    const ids = await seed(type, 10);
    const skipSet = new Set<string>();
    const handled: string[] = [];
    const a = new OutboxDispatchRelay({ db: relayDb(poolA, "EG"), batchSize: 10, dispatch: (e) => { handled.push(e.id); return Promise.resolve(); } });
    // The switch flips after the 6th decision: the remaining 4 are skipped.
    let asked = 0;
    const resA = await a.runOnce({
      includeTypes: [type],
      shouldSkip: (e) => {
        asked += 1;
        if (asked > 6) skipSet.add(e.id);
        return asked > 6;
      },
    });
    expect(resA).toMatchObject({ claimed: 10, dispatched: 6, released: 4 });
    const rows = await rowsOf(ids);
    for (const r of rows.filter((x) => skipSet.has(x.id))) expect(r).toMatchObject({ published_at: null, lease_until: null, attempts: 0, dead_lettered_at: null });
    expect(rows.filter((r) => r.published_at !== null)).toHaveLength(6);
    const handledB: string[] = [];
    const b = new OutboxDispatchRelay({ db: relayDb(poolB, "EG"), batchSize: 10, dispatch: (e) => { handledB.push(e.id); return Promise.resolve(); } });
    const resB = await b.runOnce({ includeTypes: [type] });
    expect(resB).toMatchObject({ claimed: 4, dispatched: 4 });
    expect(handledB.sort()).toEqual([...skipSet].sort());
  });

  it("an unknown type stays pending (never claimed, never acked) and unrouted() counts it", async () => {
    const known = `test.f11.known.x${randomUUID().replaceAll("-", "_")}`;
    const unknown = `test.f11.unknown.x${randomUUID().replaceAll("-", "_")}`;
    await seed(known, 5);
    const unk = await seed(unknown, 7);
    const handled: string[] = [];
    const r = new OutboxDispatchRelay({ db: relayDb(poolA, "EG"), batchSize: 50, dispatch: (e) => { handled.push(e.type); return Promise.resolve(); } });
    expect((await r.runOnce({ includeTypes: [known] })).dispatched).toBe(5);
    expect(handled.every((t) => t === known)).toBe(true);
    expect((await rowsOf(unk)).every((x) => x.published_at === null && x.lease_until === null && x.attempts === 0)).toBe(true);
    const unrouted = await r.unrouted([known]);
    expect(unrouted.find((u) => u.type === unknown)?.pending).toBe(7);
    expect(unrouted.find((u) => u.type === known)).toBeUndefined();
  });
});
