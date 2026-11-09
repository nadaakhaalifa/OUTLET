import { uuidv7 } from "@outlet/ids";
import { withTestDb } from "@outlet/db/testing";
import { describe, expect, it } from "vitest";
import { OutboxDispatchRelay, OutboxWriter, defaultBackoffMs, errorCode, pgTransactionalWriter } from "../src/index.js";
import type { OutboxEvent, OutboxEventInput, SqlClient } from "../src/index.js";

const input = (over: Partial<OutboxEventInput> = {}): OutboxEventInput => ({
  id: uuidv7(),
  type: "order.placed",
  aggregateType: "order",
  aggregateId: "0197c0de-0000-7000-8000-000000000001",
  marketId: "EG",
  occurredAt: "2026-11-08T10:00:00.000Z",
  payload: { n: 1 },
  ...over,
});
const writer = new OutboxWriter(pgTransactionalWriter);
const append = (db: SqlClient, e: OutboxEventInput): Promise<OutboxEvent> => db.transaction((tx) => writer.append(tx, e));
interface State { published_at: Date | null; attempts: number; last_error: string | null; lease_until: Date | null; dead_lettered_at: Date | null }
const state = async (db: SqlClient, id: string): Promise<State | undefined> =>
  (await db.query<State>("SELECT published_at, attempts, last_error, lease_until, dead_lettered_at FROM outbox_events WHERE id = $1", [id])).rows[0];

class Clock {
  constructor(public t = new Date("2026-11-10T10:00:00Z").getTime()) {}
  readonly now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

describe("OutboxDispatchRelay", () => {
  it("dispatches in id order and acks (published, lease cleared, attempts counted)", async () => {
    await withTestDb(async (db) => {
      const a = await append(db, input());
      const b = await append(db, input());
      const seen: string[] = [];
      const relay = new OutboxDispatchRelay({ db, dispatch: (e) => (seen.push(e.id), Promise.resolve()) });
      expect(await relay.runOnce()).toEqual({ claimed: 2, dispatched: 2, failed: 0, deadLettered: 0, released: 0 });
      expect(seen).toEqual([a.id, b.id]);
      expect(await state(db, a.id)).toMatchObject({ attempts: 1, lease_until: null, last_error: null });
      expect((await state(db, a.id))?.published_at).not.toBeNull();
      expect(await relay.runOnce()).toMatchObject({ claimed: 0 });
    });
  });

  it("a failure records a code (never the message), backs off by lease, then retries after the backoff", async () => {
    await withTestDb(async (db) => {
      const clock = new Clock();
      const e = await append(db, input());
      let fail = true;
      const relay = new OutboxDispatchRelay({
        db, now: clock.now,
        dispatch: () => (fail ? Promise.reject(Object.assign(new Error("shopper +201000000000 failed"), { code: "E_DOWN" })) : Promise.resolve()),
      });
      expect(await relay.runOnce()).toMatchObject({ claimed: 1, failed: 1 });
      const s = await state(db, e.id);
      expect(s).toMatchObject({ attempts: 1, last_error: "Error:E_DOWN", published_at: null });
      expect(new Date(s?.lease_until ?? 0).getTime()).toBe(clock.t + 2_000);
      clock.advance(1_000);
      expect(await relay.runOnce()).toMatchObject({ claimed: 0 });
      clock.advance(1_000);
      fail = false;
      expect(await relay.runOnce()).toMatchObject({ claimed: 1, dispatched: 1 });
      expect(await state(db, e.id)).toMatchObject({ attempts: 2, last_error: null });
    });
  });

  it("dead-letters at maxAttempts with a payload-free dlq row", async () => {
    await withTestDb(async (db) => {
      const clock = new Clock();
      const e = await append(db, input({ type: "refund.attention", payload: { phone: "secret" } }));
      const relay = new OutboxDispatchRelay({ db, now: clock.now, maxAttempts: 2, backoffMs: () => 0, dispatch: () => Promise.reject(new Error("boom")) });
      expect(await relay.runOnce()).toMatchObject({ failed: 1, deadLettered: 0 });
      expect(await relay.runOnce()).toMatchObject({ failed: 0, deadLettered: 1 });
      expect((await state(db, e.id))?.dead_lettered_at).not.toBeNull();
      const dlq = await db.query<{ consumer: string; payload: unknown; error: string; attempts: number }>("SELECT consumer, payload, error, attempts FROM dlq_messages WHERE message_id = $1", [e.id]);
      expect(dlq.rows).toEqual([{ consumer: "outbox-dispatch", payload: { event_type: "refund.attention" }, error: "Error", attempts: 2 }]);
      expect(await relay.runOnce()).toMatchObject({ claimed: 0 });
    });
  });

  it("excluded types are not claimed and keep no lease; other types pass", async () => {
    await withTestDb(async (db) => {
      const killed = await append(db, input({ type: "refund.attention" }));
      const ok = await append(db, input());
      const seen: string[] = [];
      const relay = new OutboxDispatchRelay({ db, dispatch: (e) => (seen.push(e.id), Promise.resolve()) });
      expect(await relay.runOnce({ excludeTypes: ["refund.attention"] })).toMatchObject({ claimed: 1, dispatched: 1 });
      expect(seen).toEqual([ok.id]);
      expect(await state(db, killed.id)).toMatchObject({ attempts: 0, lease_until: null, published_at: null });
      expect(await relay.pending(["refund.attention", "order.placed"])).toEqual([{ type: "refund.attention", pending: 1, oldestOccurredAt: new Date("2026-11-08T10:00:00.000Z") }]);
      expect(await relay.pending([])).toEqual([]);
    });
  });

  it("a live lease hides a row from a second relay; an expired lease is reclaimed (crash before ack = redelivery)", async () => {
    await withTestDb(async (db) => {
      const clock = new Clock();
      const e = await append(db, input());
      // relay A claims, then "crashes" before acking: simulated by a dispatch that never settles within the test.
      const relayA = new OutboxDispatchRelay({ db, now: clock.now, leaseMs: 60_000, dispatch: () => new Promise<void>(() => undefined) });
      void relayA.runOnce();
      await new Promise((r) => setTimeout(r, 50));
      const seen: string[] = [];
      const relayB = new OutboxDispatchRelay({ db, now: clock.now, leaseMs: 60_000, dispatch: (x) => (seen.push(x.id), Promise.resolve()) });
      expect(await relayB.runOnce()).toMatchObject({ claimed: 0 });
      clock.advance(60_000);
      expect(await relayB.runOnce()).toMatchObject({ claimed: 1, dispatched: 1 });
      expect(seen).toEqual([e.id]);
    });
  });

  it("shouldStop releases the rest of the batch (lease cleared) for the next poll", async () => {
    await withTestDb(async (db) => {
      const a = await append(db, input());
      const b = await append(db, input());
      let stop = false;
      const relay = new OutboxDispatchRelay({ db, dispatch: () => ((stop = true), Promise.resolve()) });
      expect(await relay.runOnce({ shouldStop: () => stop })).toEqual({ claimed: 2, dispatched: 1, failed: 0, deadLettered: 0, released: 1 });
      expect((await state(db, a.id))?.published_at).not.toBeNull();
      expect(await state(db, b.id)).toMatchObject({ lease_until: null, published_at: null, attempts: 0 });
    });
  });

  it("an unparseable row counts as a failed dispatch", async () => {
    await withTestDb(async (db) => {
      await db.query(
        "INSERT INTO outbox_events (id, market_id, aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ('0197c0de-0000-4000-8000-000000000009', 'EG', 'x', '0197c0de-0000-7000-8000-000000000001', 'a.b', '{}', now())",
      );
      const relay = new OutboxDispatchRelay({ db, dispatch: () => Promise.resolve() });
      expect(await relay.runOnce()).toMatchObject({ claimed: 1, failed: 1 });
      expect((await state(db, "0197c0de-0000-4000-8000-000000000009"))?.last_error).toBe("ZodError");
    });
  });

  it("validates options and helpers", () => {
    const db = { query: () => Promise.resolve({ rows: [] }), transaction: () => Promise.reject(new Error("x")) };
    const dispatch = (): Promise<void> => Promise.resolve();
    expect(() => new OutboxDispatchRelay({ db, dispatch, batchSize: 0 })).toThrow(RangeError);
    expect(() => new OutboxDispatchRelay({ db, dispatch, maxAttempts: 0 })).toThrow(RangeError);
    expect(() => new OutboxDispatchRelay({ db, dispatch, leaseMs: 10 })).toThrow(RangeError);
    expect(defaultBackoffMs(1)).toBe(2_000);
    expect(defaultBackoffMs(20)).toBe(300_000);
    expect(errorCode("x")).toBe("non_error_thrown");
    expect(errorCode(Object.assign(new TypeError("t"), { code: 7 }))).toBe("TypeError");
    expect(errorCode(Object.assign(new Error("t"), { name: "Bad Name!", code: "c d" }))).toBe("Bad_Name_:c_d");
  });
});
