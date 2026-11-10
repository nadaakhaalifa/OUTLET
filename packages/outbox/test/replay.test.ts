import { uuidv7 } from "@outlet/ids";
import { withTestDb } from "@outlet/db/testing";
import { describe, expect, it } from "vitest";
import { DlqReplay, OutboxDispatchRelay, OutboxWriter, isMoneyEventType, pgTransactionalWriter } from "../src/index.js";
import type { OutboxEventInput, SqlClient } from "../src/index.js";

const writer = new OutboxWriter(pgTransactionalWriter);
const input = (type: string, marketId = "EG"): OutboxEventInput => ({
  id: uuidv7(), type, aggregateType: "order", aggregateId: "0197c0de-0000-7000-8000-000000000001", marketId, occurredAt: "2026-11-08T10:00:00.000Z", payload: { secret: "+201000000000" },
});
/** One event that fails to the DLQ (maxAttempts 1). */
const deadLetter = async (db: SqlClient, type: string, marketId = "EG"): Promise<string> => {
  const e = await db.transaction((tx) => writer.append(tx, input(type, marketId)));
  const relay = new OutboxDispatchRelay({ db, maxAttempts: 1, dispatch: () => Promise.reject(new Error("boom +201000000000")) });
  await relay.runOnce({ includeTypes: [type] });
  return e.id;
};
const dlqIdOf = async (db: SqlClient, eventId: string): Promise<string> => {
  const r = await db.query<{ id: string }>("SELECT id FROM dlq_messages WHERE message_id = $1", [eventId]);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error("no dlq row");
  return id;
};

describe("DlqReplay", () => {
  it("lists newest first without the payload, with keyset paging", async () => {
    await withTestDb(async (db) => {
      const a = await deadLetter(db, "refund.attention");
      const b = await deadLetter(db, "order.placed");
      const c = await deadLetter(db, "order.placed", "XX");
      const q = new DlqReplay(db);
      const p1 = await q.list("EG", undefined, 1);
      expect(p1.items).toHaveLength(1);
      expect(p1.items[0]).toMatchObject({ messageId: b, eventType: "order.placed", attempts: 1, lastError: "Error" });
      expect(JSON.stringify(p1)).not.toContain("201000000000");
      expect(p1.nextCursor).toBe(p1.items[0]?.id);
      const p2 = await q.list("EG", p1.nextCursor ?? undefined, 1);
      expect(p2.items.map((i) => i.messageId)).toEqual([a]);
      expect(p2.nextCursor).toBeNull();
      expect((await q.list("XX")).items.map((i) => i.messageId)).toEqual([c]);
    });
  });

  it("replay resets the event, marks the dlq row replayed, lets the relay claim it again, and is idempotent", async () => {
    await withTestDb(async (db) => {
      const ev = await deadLetter(db, "order.placed");
      const id = await dlqIdOf(db, ev);
      const q = new DlqReplay(db);
      expect(await q.replay("EG", [id, id])).toEqual([{ id, outcome: "replayed" }]);
      const s = await db.query<{ attempts: number; last_error: string | null; dead_lettered_at: Date | null; published_at: Date | null; lease_until: Date | null }>(
        "SELECT attempts, last_error, dead_lettered_at, published_at, lease_until FROM outbox_events WHERE id = $1", [ev]);
      expect(s.rows[0]).toEqual({ attempts: 0, last_error: null, dead_lettered_at: null, published_at: null, lease_until: null });
      expect((await db.query<{ status: string }>("SELECT status FROM dlq_messages WHERE id = $1", [id])).rows[0]?.status).toBe("replayed");
      expect(await q.replay("EG", [id])).toEqual([{ id, outcome: "not_in_dlq" }]);
      const seen: string[] = [];
      const relay = new OutboxDispatchRelay({ db, dispatch: (e) => (seen.push(e.id), Promise.resolve()) });
      expect(await relay.runOnce({ includeTypes: ["order.placed"] })).toMatchObject({ dispatched: 1 });
      expect(seen).toEqual([ev]);
    });
  });

  it("a replayed event that fails again is dead-lettered again with a fresh dlq row", async () => {
    await withTestDb(async (db) => {
      const ev = await deadLetter(db, "order.placed");
      await new DlqReplay(db).replay("EG", [await dlqIdOf(db, ev)]);
      await new OutboxDispatchRelay({ db, maxAttempts: 1, dispatch: () => Promise.reject(new Error("x")) }).runOnce({ includeTypes: ["order.placed"] });
      expect((await new DlqReplay(db).list("EG")).items.map((i) => i.messageId)).toEqual([ev]);
      expect((await db.query("SELECT 1 FROM dlq_messages WHERE message_id = $1", [ev])).rows).toHaveLength(2);
    });
  });

  it("discard marks the event published with a discarded marker, keeps the trail, and is no longer replayable", async () => {
    await withTestDb(async (db) => {
      const ev = await deadLetter(db, "order.placed");
      const id = await dlqIdOf(db, ev);
      const q = new DlqReplay(db, () => new Date("2026-11-10T10:00:00Z"));
      expect(await q.discard("EG", [id], "obsolete")).toEqual([{ id, outcome: "discarded" }]);
      const s = await db.query<{ published_at: Date | null; last_error: string | null; dead_lettered_at: Date | null }>("SELECT published_at, last_error, dead_lettered_at FROM outbox_events WHERE id = $1", [ev]);
      expect(s.rows[0]?.last_error).toBe("discarded:obsolete");
      expect(s.rows[0]?.published_at).not.toBeNull();
      expect(s.rows[0]?.dead_lettered_at).not.toBeNull();
      expect((await db.query<{ status: string }>("SELECT status FROM dlq_messages WHERE id = $1", [id])).rows[0]?.status).toBe("discarded");
      expect((await q.list("EG")).items).toEqual([]);
      expect(await q.replay("EG", [id])).toEqual([{ id, outcome: "not_in_dlq" }]);
      expect(await q.discard("EG", [id], "obsolete")).toEqual([{ id, outcome: "not_in_dlq" }]);
      expect(await new OutboxDispatchRelay({ db, dispatch: () => Promise.resolve() }).runOnce({ includeTypes: ["order.placed"] })).toMatchObject({ claimed: 0 });
    });
  });

  it("another market's rows are not_in_dlq and untouched", async () => {
    await withTestDb(async (db) => {
      const ev = await deadLetter(db, "order.placed", "XX");
      const id = await dlqIdOf(db, ev);
      const q = new DlqReplay(db);
      expect(await q.replay("EG", [id])).toEqual([{ id, outcome: "not_in_dlq" }]);
      expect(await q.discard("EG", [id], "duplicate")).toEqual([{ id, outcome: "not_in_dlq" }]);
      expect((await q.lookup("EG", [id])).size).toBe(0);
      expect((await q.list("XX")).items).toHaveLength(1);
    });
  });

  it("lookup returns the event type; empty, unknown reasons and oversize batches are rejected or empty", async () => {
    await withTestDb(async (db) => {
      const id = await dlqIdOf(db, await deadLetter(db, "refund.attention"));
      const q = new DlqReplay(db);
      expect([...(await q.lookup("EG", [id])).values()]).toEqual(["refund.attention"]);
      expect(await q.replay("EG", [])).toEqual([]);
      expect(() => q.discard("EG", [id], "nope" as never)).toThrow(RangeError);
      expect(() => q.replay("EG", Array.from({ length: 51 }, () => uuidv7()))).toThrow(RangeError);
    });
  });

  it("classifies money event types", () => {
    for (const t of ["refund.attention", "promotions.settle_requested", "payout.hold_requested", "order_group.late_payment_refund"]) expect(isMoneyEventType(t)).toBe(true);
    for (const t of ["order.placed", "shipment.cancel_required", "reporting.rollup_requested"]) expect(isMoneyEventType(t)).toBe(false);
  });
});
