import { uuidv7 } from "@outlet/ids";
import { withTestDb } from "@outlet/db/testing";
import { describe, expect, it } from "vitest";
import { InboxProcessor, OutboxRelay, OutboxWriter, pgTransactionalWriter } from "../src/index.js";
import type { OutboxEvent, OutboxEventInput, Publisher, SqlClient } from "../src/index.js";

const input = (over: Partial<OutboxEventInput> = {}): OutboxEventInput => ({
  id: uuidv7(),
  type: "order.placed",
  aggregateType: "order",
  aggregateId: "0197c0de-0000-7000-8000-000000000001",
  marketId: "EG",
  occurredAt: "2026-11-08T10:00:00.000Z",
  payload: { total: "12500", items: [1, 2] },
  ...over,
});

const writer = new OutboxWriter(pgTransactionalWriter);
const append = (db: SqlClient, e: OutboxEventInput): Promise<OutboxEvent> => db.transaction((tx) => writer.append(tx, e));

class Recorder implements Publisher {
  readonly seen: string[] = [];
  failFor = new Set<string>();
  publish(e: OutboxEvent): Promise<void> {
    if (this.failFor.has(e.id)) return Promise.reject(new Error("bus down"));
    this.seen.push(e.id);
    return Promise.resolve();
  }
}

describe("OutboxWriter", () => {
  it("validates the envelope", async () => {
    await withTestDb(async (db) => {
      await expect(append(db, input({ id: "not-a-uuid" }))).rejects.toThrow();
      await expect(append(db, input({ type: "BAD" }))).rejects.toThrow();
      await expect(append(db, input({ marketId: "" }))).rejects.toThrow();
    });
  });

  it("is atomic with the caller's transaction (rollback leaves no event)", async () => {
    await withTestDb(async (db) => {
      await expect(
        db.transaction(async (tx) => {
          await writer.append(tx, input());
          throw new Error("business failure");
        }),
      ).rejects.toThrow("business failure");
      expect((await db.query("SELECT 1 FROM outbox_events")).rows).toHaveLength(0);
    });
  });

  it("stores defaults and optional trace id", async () => {
    await withTestDb(async (db) => {
      const e = await append(db, input({ traceId: "abc" }));
      const r = await db.query<{ visibility: string; trace_id: string; attempts: number }>("SELECT visibility, trace_id, attempts FROM outbox_events WHERE id=$1", [e.id]);
      expect(r.rows[0]).toEqual({ visibility: "internal", trace_id: "abc", attempts: 0 });
    });
  });
});

describe("OutboxRelay", () => {
  it("publishes in order and marks published; second run is empty", async () => {
    await withTestDb(async (db) => {
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await append(db, input())).id);
      const pub = new Recorder();
      const relay = new OutboxRelay({ db, publisher: pub });
      expect(await relay.runOnce()).toEqual({ published: 3, failed: 0, deadLettered: 0 });
      expect(pub.seen).toEqual(ids);
      expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, deadLettered: 0 });
    });
  });

  it("retries a failing event (at-least-once) and eventually publishes it", async () => {
    await withTestDb(async (db) => {
      const e = await append(db, input());
      const pub = new Recorder();
      pub.failFor.add(e.id);
      const relay = new OutboxRelay({ db, publisher: pub, maxAttempts: 3 });
      expect((await relay.runOnce()).failed).toBe(1);
      pub.failFor.clear();
      expect((await relay.runOnce()).published).toBe(1);
      const r = await db.query<{ attempts: number; last_error: string | null }>("SELECT attempts, last_error FROM outbox_events WHERE id=$1", [e.id]);
      expect(r.rows[0]).toEqual({ attempts: 2, last_error: null });
    });
  });

  it("dead-letters after N attempts and stops retrying", async () => {
    await withTestDb(async (db) => {
      const bad = await append(db, input());
      const good = await append(db, input());
      const pub = new Recorder();
      pub.failFor.add(bad.id);
      const relay = new OutboxRelay({ db, publisher: pub, maxAttempts: 3 });
      expect(await relay.runOnce()).toEqual({ published: 1, failed: 1, deadLettered: 0 });
      expect((await relay.runOnce()).failed).toBe(1);
      expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, deadLettered: 1 });
      expect(await relay.runOnce()).toEqual({ published: 0, failed: 0, deadLettered: 0 });
      expect(pub.seen).toEqual([good.id]);
      const dlq = await db.query<{ message_id: string; attempts: number; error: string; status: string }>("SELECT message_id, attempts, error, status FROM dlq_messages");
      // F9: the error is a code (name + code), never the message; the dlq payload is {event_type} only (no P2).
      expect(dlq.rows).toEqual([{ message_id: bad.id, attempts: 3, error: "Error", status: "open" }]);
      expect((await db.query<{ payload: unknown }>("SELECT payload FROM dlq_messages")).rows).toEqual([{ payload: { event_type: "order.placed" } }]);
    });
  });

  it("two relays running concurrently never double-publish", async () => {
    await withTestDb(async (db) => {
      for (let i = 0; i < 20; i++) await append(db, input());
      const pub = new Recorder();
      const a = new OutboxRelay({ db, publisher: pub, batchSize: 7 });
      const b = new OutboxRelay({ db, publisher: pub, batchSize: 7 });
      for (let round = 0; round < 3; round++) await Promise.all([a.runOnce(), b.runOnce()]);
      expect(pub.seen).toHaveLength(20);
      expect(new Set(pub.seen).size).toBe(20);
    });
  });

  it("rolls back marks if the transaction fails after publishing (redelivery, at-least-once)", async () => {
    await withTestDb(async (db) => {
      const e = await append(db, input());
      const pub = new Recorder();
      const flaky: SqlClient = {
        query: (s, p) => db.query(s, p),
        transaction: (fn) =>
          db.transaction(async (tx) => {
            await fn(tx);
            throw new Error("commit failed");
          }),
      };
      await expect(new OutboxRelay({ db: flaky, publisher: pub }).runOnce()).rejects.toThrow("commit failed");
      expect(pub.seen).toEqual([e.id]);
      await new OutboxRelay({ db, publisher: pub }).runOnce();
      expect(pub.seen).toEqual([e.id, e.id]); // delivered twice: consumers must dedupe
    });
  });

  it("round-trips the envelope including trace id and public visibility", async () => {
    await withTestDb(async (db) => {
      const e = await append(db, input({ traceId: "t-1", visibility: "public" }));
      let got: OutboxEvent | undefined;
      await new OutboxRelay({ db, publisher: { publish: (x) => ((got = x), Promise.resolve()) }, now: () => new Date("2026-11-08T11:00:00Z") }).runOnce();
      expect(got).toEqual(e);
    });
  });

  it("rejects invalid options", () => {
    const db = {} as SqlClient;
    const publisher = new Recorder();
    expect(() => new OutboxRelay({ db, publisher, batchSize: 0 })).toThrow(RangeError);
    expect(() => new OutboxRelay({ db, publisher, maxAttempts: 0 })).toThrow(RangeError);
  });
});

describe("InboxProcessor", () => {
  const setup = async (db: SqlClient): Promise<void> => {
    await db.query("CREATE TABLE effects (n int)");
  };

  it("duplicate delivery runs the handler once", async () => {
    await withTestDb(async (db) => {
      await setup(db);
      const inbox = new InboxProcessor(db);
      const id = uuidv7();
      const handler = async (tx: { query: SqlClient["query"] }): Promise<void> => {
        await tx.query("INSERT INTO effects VALUES (1)");
      };
      expect(await inbox.process("c1", id, handler)).toBe("processed");
      expect(await inbox.process("c1", id, handler)).toBe("duplicate");
      expect((await db.query("SELECT * FROM effects")).rows).toHaveLength(1);
      expect(await inbox.process("c2", id, handler)).toBe("processed"); // per-consumer
    });
  });

  it("handler failure rolls back the inbox row so redelivery succeeds", async () => {
    await withTestDb(async (db) => {
      await setup(db);
      const inbox = new InboxProcessor(db);
      const id = uuidv7();
      await expect(
        inbox.process("c1", id, async (tx) => {
          await tx.query("INSERT INTO effects VALUES (1)");
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect((await db.query("SELECT * FROM effects")).rows).toHaveLength(0);
      expect(await inbox.process("c1", id, () => Promise.resolve())).toBe("processed");
    });
  });

  it("end to end: relay delivers twice, consumer applies once", async () => {
    await withTestDb(async (db) => {
      await setup(db);
      const e = await append(db, input());
      const inbox = new InboxProcessor(db);
      // The relay's transaction holds the only PGlite connection, so deliveries are applied after it.
      const delivered: string[] = [];
      const publisher: Publisher = { publish: (ev) => (delivered.push(ev.id), Promise.resolve()) };
      await new OutboxRelay({ db, publisher }).runOnce();
      delivered.push(e.id); // simulated redelivery
      for (const id of delivered) {
        await inbox.process("proj", id, async (tx) => {
          await tx.query("INSERT INTO effects VALUES (1)");
        });
      }
      expect((await db.query("SELECT * FROM effects")).rows).toHaveLength(1);
    });
  });
});
