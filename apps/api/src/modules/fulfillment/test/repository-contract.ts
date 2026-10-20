import { beforeEach, describe, expect, it } from "vitest";
import { money } from "../domain/bridge";
import type {
  FulfillmentRepository,
  OutboxEvent,
  RemittanceRecord,
  ShipmentEventRecord,
  ShipmentRecord,
} from "../domain/ports";

export interface FulfillmentRepoContext {
  readonly repo: FulfillmentRepository;
  /** Count of outbox events with a type (in-memory list or the outbox_events table). */
  outboxCount(type: string): Promise<number>;
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";
const T0 = 1_800_000_000_000;

export const shipment = (n: number, over: Partial<ShipmentRecord> = {}): ShipmentRecord => ({
  id: U(100 + n),
  storeId: STORE_A,
  sellerOrderId: U(200 + n),
  courierCode: "bosta",
  awb: null,
  state: "LABEL_PENDING",
  attemptsMade: 0,
  codAmount: null,
  codStatus: "NONE",
  labelStatus: "PENDING",
  parcelWeightG: 800,
  pieces: 1,
  pickedUpAtMs: null,
  deliveredAtMs: null,
  version: 0,
  createdAtMs: T0,
  ...over,
});

let outboxSeq = 0;
export const outboxEvent = (type: string, aggregateId: string): OutboxEvent => {
  outboxSeq += 1;
  return { id: U(900_000 + outboxSeq), type, aggregateId, payload: { shipment_id: aggregateId, n: outboxSeq } };
};

let eventSeq = 0;
const trackingEvent = (s: ShipmentRecord, eventId: string, over: Partial<ShipmentEventRecord> = {}): ShipmentEventRecord => ({
  id: U(500_000 + ++eventSeq),
  shipmentId: s.id,
  courierEventId: eventId,
  kind: "picked_up",
  outcome: "APPLIED",
  fromStatus: "LABEL_CREATED",
  toStatus: "PICKED_UP",
  reasonCode: null,
  occurredAtMs: T0 + 1_000,
  recordedAtMs: T0 + 2_000,
  ...over,
});

/** Behaviour every FulfillmentRepository must have. Run against in-memory and Kysely/PGlite. */
export function describeFulfillmentRepositoryContract(name: string, make: () => Promise<FulfillmentRepoContext>): void {
  describe(`FulfillmentRepository contract: ${name}`, () => {
    let c: FulfillmentRepoContext;
    beforeEach(async () => {
      c = await make();
    });

    const create = async (s: ShipmentRecord, due = T0) =>
      c.repo.createShipment(s, { nextAttemptAtMs: due }, [outboxEvent("shipment.created", s.id)]);

    it("creates a shipment with its job and outbox event, and reads it back", async () => {
      const s = shipment(1, { codAmount: money(150_000n), codStatus: "PENDING" });
      expect(await create(s)).toBe("created");
      expect(await c.repo.getShipment(s.id)).toEqual(s);
      expect(await c.repo.getJob(s.id)).toEqual({ status: "PENDING", attempts: 0, nextAttemptAtMs: T0, lastErrorCode: null });
      expect(await c.outboxCount("shipment.created")).toBe(1);
      expect(await c.repo.getShipment(U(999))).toBeNull();
    });

    it("keeps one live shipment per seller order and lets a cancelled one be re-shipped", async () => {
      const a = shipment(1);
      expect(await create(a)).toBe("created");
      expect(await create(shipment(2, { sellerOrderId: a.sellerOrderId }))).toBe("live_shipment_exists");
      expect(await c.outboxCount("shipment.created")).toBe(1);
      expect((await c.repo.findLiveBySellerOrder(a.sellerOrderId))?.id).toBe(a.id);
      await c.repo.recordRaw({ id: U(12), courierCode: "bosta", courierEventId: "evt-c", awb: null, body: "{}", receivedAtMs: T0 });
      const cancelled = trackingEvent(a, "evt-c", { kind: "cancelled", fromStatus: "LABEL_PENDING", toStatus: "CANCELLED" });
      expect(
        await c.repo.applyTracking({
          shipmentId: a.id, expectedVersion: 0, next: { ...a, state: "CANCELLED", version: 1 },
          event: cancelled, courierCode: "bosta", outbox: [],
        }),
      ).toBe("ok");
      expect(await c.repo.findLiveBySellerOrder(a.sellerOrderId)).toBeNull();
      expect(await create(shipment(3, { sellerOrderId: a.sellerOrderId }))).toBe("created");
    });

    it("stores the AWB atomically with the LABEL_CREATED transition and rejects a reused AWB", async () => {
      const a = shipment(1);
      const b = shipment(2);
      await create(a);
      await create(b);
      expect(await c.repo.completeAwb({ shipmentId: a.id, awb: "BST1", nowMs: T0, outbox: [outboxEvent("shipment.label_created", a.id)] })).toBe("ok");
      const after = await c.repo.getShipment(a.id);
      expect(after).toMatchObject({ awb: "BST1", state: "LABEL_CREATED", labelStatus: "READY" });
      expect(await c.repo.getJob(a.id)).toMatchObject({ status: "DONE" });
      expect((await c.repo.findByAwb("bosta", "BST1"))?.id).toBe(a.id);
      expect(await c.repo.completeAwb({ shipmentId: b.id, awb: "BST1", nowMs: T0, outbox: [] })).toBe("awb_conflict");
      expect((await c.repo.getShipment(b.id))?.awb).toBeNull();
      expect(await c.repo.completeAwb({ shipmentId: U(998), awb: "BST9", nowMs: T0, outbox: [] })).toBe("not_found");
    });

    it("runs the job queue: due ordering, backoff bookkeeping, dead letter and requeue", async () => {
      const a = shipment(1);
      const b = shipment(2);
      await create(a, T0 + 5_000);
      await create(b, T0);
      expect((await c.repo.dueJobs(T0, 10)).map((j) => j.shipmentId)).toEqual([b.id]);
      expect((await c.repo.dueJobs(T0 + 5_000, 10)).map((j) => j.shipmentId)).toEqual([b.id, a.id]);
      await c.repo.failAwb({ shipmentId: b.id, attempts: 1, nextAttemptAtMs: T0 + 60_000, errorCode: "courier_unavailable", nowMs: T0, outbox: [] });
      expect(await c.repo.getJob(b.id)).toEqual({ status: "PENDING", attempts: 1, nextAttemptAtMs: T0 + 60_000, lastErrorCode: "courier_unavailable" });
      expect((await c.repo.dueJobs(T0 + 5_000, 10)).map((j) => j.shipmentId)).toEqual([a.id]);
      await c.repo.failAwb({
        shipmentId: b.id, attempts: 8, nextAttemptAtMs: null, errorCode: "courier_unavailable", nowMs: T0,
        outbox: [outboxEvent("courier.awb_dead_lettered", b.id)],
      });
      expect(await c.repo.getJob(b.id)).toMatchObject({ status: "DEAD", attempts: 8 });
      expect(await c.repo.getShipment(b.id)).toMatchObject({ labelStatus: "FAILED" });
      expect(await c.outboxCount("courier.awb_dead_lettered")).toBe(1);
      expect((await c.repo.dueJobs(T0 + 10_000_000, 10)).map((j) => j.shipmentId)).toEqual([a.id]);
      expect(await c.repo.requeueDead(b.id, T0 + 100)).toBe(true);
      expect(await c.repo.requeueDead(b.id, T0 + 100)).toBe(false);
      expect(await c.repo.getJob(b.id)).toMatchObject({ status: "PENDING", attempts: 0, nextAttemptAtMs: T0 + 100 });
      expect(await c.repo.getShipment(b.id)).toMatchObject({ labelStatus: "PENDING" });
    });

    it("dedups raw deliveries and offers a redelivery while processing never finished", async () => {
      const raw = { id: U(1), courierCode: "bosta", courierEventId: "evt-1", awb: "BST1", body: "{}", receivedAtMs: T0 };
      expect(await c.repo.recordRaw(raw)).toBe("new");
      expect(await c.repo.recordRaw({ ...raw, id: U(2) })).toBe("redelivered");
      await c.repo.markRaw("bosta", "evt-1", "PROCESSED", T0);
      expect(await c.repo.recordRaw({ ...raw, id: U(3) })).toBe("duplicate");
      expect(await c.repo.recordRaw({ ...raw, id: U(4), courierCode: "aramex" })).toBe("new");
    });

    it("holds unmatched deliveries per AWB, oldest first", async () => {
      const mk = (id: number, evt: string, at: number) => ({
        id: U(id), courierCode: "bosta", courierEventId: evt, awb: "BSTX", body: `{"e":"${evt}"}`, receivedAtMs: at,
      });
      await c.repo.recordRaw(mk(1, "e2", T0 + 2));
      await c.repo.recordRaw(mk(2, "e1", T0 + 1));
      await c.repo.markRaw("bosta", "e1", "UNMATCHED", T0);
      await c.repo.markRaw("bosta", "e2", "UNMATCHED", T0);
      expect((await c.repo.listUnmatchedRaw("bosta", "BSTX")).map((x) => x.courierEventId)).toEqual(["e1", "e2"]);
      expect(await c.repo.listUnmatchedRaw("bosta", "OTHER")).toEqual([]);
      await c.repo.markRaw("bosta", "e1", "PROCESSED", T0);
      expect((await c.repo.listUnmatchedRaw("bosta", "BSTX")).map((x) => x.courierEventId)).toEqual(["e2"]);
    });

    it("applies tracking compare-and-set, records the event and the outbox once", async () => {
      const s = shipment(1);
      await c.repo.createShipment(s, { nextAttemptAtMs: T0 }, []);
      await c.repo.completeAwb({ shipmentId: s.id, awb: "BST1", nowMs: T0, outbox: [] });
      const cur = await c.repo.getShipment(s.id);
      expect(cur).not.toBeNull();
      if (cur === null) return;
      await c.repo.recordRaw({ id: U(10), courierCode: "bosta", courierEventId: "evt-p", awb: "BST1", body: "{}", receivedAtMs: T0 });
      const next: ShipmentRecord = { ...cur, state: "PICKED_UP", pickedUpAtMs: T0 + 1_000, version: cur.version + 1 };
      const ev = trackingEvent(cur, "evt-p");
      const input = {
        shipmentId: cur.id, expectedVersion: cur.version, next, event: ev, courierCode: "bosta",
        outbox: [outboxEvent("shipment.picked_up", cur.id)],
      };
      expect(await c.repo.applyTracking(input)).toBe("ok");
      expect(await c.repo.getShipment(cur.id)).toEqual(next);
      expect((await c.repo.listEvents(cur.id)).map((e) => e.courierEventId)).toEqual(["evt-p"]);
      expect(await c.outboxCount("shipment.picked_up")).toBe(1);
      // same event again with the stale version: version conflict wins over duplicate detection
      expect(await c.repo.applyTracking(input)).toBe("version_conflict");
      // same event id against the fresh version: duplicate, nothing written twice
      const again = await c.repo.applyTracking({ ...input, expectedVersion: next.version, next });
      expect(again).toBe("duplicate_event");
      expect(await c.outboxCount("shipment.picked_up")).toBe(1);
      expect(await c.repo.listEvents(cur.id)).toHaveLength(1);
    });

    it("records an ignored event without touching the shipment", async () => {
      const s = shipment(1);
      await create(s);
      await c.repo.recordRaw({ id: U(11), courierCode: "bosta", courierEventId: "evt-s", awb: null, body: "{}", receivedAtMs: T0 });
      const ev = trackingEvent(s, "evt-s", { outcome: "IGNORED_STALE", fromStatus: "LABEL_PENDING", toStatus: "LABEL_PENDING", kind: "in_transit" });
      expect(await c.repo.applyTracking({ shipmentId: s.id, expectedVersion: 0, next: s, event: ev, courierCode: "bosta", outbox: [] })).toBe("ok");
      expect(await c.repo.getShipment(s.id)).toEqual(s);
      expect(await c.repo.listEvents(s.id)).toHaveLength(1);
    });

    it("records a COD remittance once, applies shipment updates and rejects stale versions", async () => {
      const s = shipment(1, { codAmount: money(100_000n), codStatus: "COLLECTED" });
      await create(s);
      await c.repo.completeAwb({ shipmentId: s.id, awb: "BSTC", nowMs: T0, outbox: [] });
      const cur = await c.repo.getShipment(s.id);
      if (cur === null) throw new Error("shipment missing");
      const rem: RemittanceRecord = {
        id: U(70), courierCode: "bosta", courierRef: "CR-1", remittanceDate: "2026-10-01",
        total: money(100_000n), status: "MATCHED", receivedAtMs: T0,
        lines: [{ awb: "BSTC", shipmentId: s.id, collected: money(100_000n), fee: money(2_500n), match: "MATCHED" }],
      };
      const update = { shipmentId: s.id, expectedVersion: cur.version, next: { ...cur, codStatus: "REMITTED" as const, version: cur.version + 1 } };
      expect(await c.repo.recordRemittance({ remittance: { ...rem, id: U(71) }, updates: [{ ...update, expectedVersion: 999 }], outbox: [] })).toBe("version_conflict");
      expect(await c.repo.findRemittance("bosta", "CR-1")).toBeNull();
      expect(await c.repo.recordRemittance({ remittance: rem, updates: [update], outbox: [outboxEvent("cod_remittance.matched", rem.id)] })).toBe("recorded");
      expect(await c.repo.recordRemittance({ remittance: { ...rem, id: U(72) }, updates: [], outbox: [outboxEvent("cod_remittance.matched", rem.id)] })).toBe("duplicate");
      expect(await c.outboxCount("cod_remittance.matched")).toBe(1);
      expect(await c.repo.findRemittance("bosta", "CR-1")).toEqual(rem);
      expect((await c.repo.getShipment(s.id))?.codStatus).toBe("REMITTED");
    });
  });
}
