import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FULFILLMENT_TRACKING_KINDS, money } from "../domain/bridge";
import { BostaStyleWebhookAdapter, signBostaWebhook } from "../adapters/bosta/bosta-adapter";
import { InMemoryFulfillmentMetrics, InMemoryFulfillmentRepository, StaticCourierSecrets } from "../adapters/in-memory";
import { IngestCourierWebhook } from "../application/webhooks";
import { FakeBostaCourier } from "../adapters/bosta/fake-bosta";
import type { ShipmentRecord } from "../domain/ports";
import { START_MS, TestClock, remittanceBody, trackingBody } from "./harness";
import { createIdGenerator, nodeCsprng } from "../../../platform";

/** Courier vocabulary (assumed Bosta-style) for each normalized kind. */
const RAW_STATE: Record<(typeof FULFILLMENT_TRACKING_KINDS)[number], string> = {
  label_created: "Created",
  picked_up: "Picked up",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  customer_refused: "Customer refused",
  rto_initiated: "Returning to seller",
  rto_delivered: "Returned to seller",
  cancelled: "Cancelled",
  lost: "Lost",
};

const SECRET = "whsec_property_test_0123456789";
const AWB = "BSTPROP0001";

async function world(cod: boolean) {
  const clock = new TestClock();
  const repo = new InMemoryFulfillmentRepository();
  const ids = createIdGenerator(clock, nodeCsprng);
  const ingest = new IngestCourierWebhook({
    repo,
    couriers: new Map([["bosta", { port: new FakeBostaCourier(), webhook: new BostaStyleWebhookAdapter() }]]),
    secrets: new StaticCourierSecrets({ bosta: [SECRET] }),
    metrics: new InMemoryFulfillmentMetrics(),
    clock,
    ids,
  });
  const s: ShipmentRecord = {
    id: "0192f3a4-5b6c-7d8e-9f01-000000000001",
    storeId: "0192f3a4-5b6c-7d8e-9f01-000000009001",
    sellerOrderId: "0192f3a4-5b6c-7d8e-9f01-000000003001",
    courierCode: "bosta",
    awb: null,
    state: "LABEL_PENDING",
    attemptsMade: 0,
    codAmount: cod ? money(50_000n) : null,
    codStatus: cod ? "PENDING" : "NONE",
    labelStatus: "PENDING",
    parcelWeightG: 500,
    pieces: 1,
    pickedUpAtMs: null,
    deliveredAtMs: null,
    version: 0,
    createdAtMs: START_MS,
  };
  await repo.createShipment(s, { nextAttemptAtMs: START_MS }, []);
  await repo.completeAwb({ shipmentId: s.id, awb: AWB, nowMs: START_MS, outbox: [] });
  const deliver = (body: object) => {
    const raw = JSON.stringify(body);
    const ts = Math.floor(clock.nowMs() / 1000);
    return ingest.execute({
      courier: "bosta",
      rawBody: raw,
      headers: { "x-signature": signBostaWebhook(SECRET, ts, raw), "x-timestamp": String(ts) },
    });
  };
  return { repo, shipmentId: s.id, deliver };
}

const specArb = fc.array(
  fc.record({
    kind: fc.constantFrom(...FULFILLMENT_TRACKING_KINDS),
    atS: fc.integer({ min: 1, max: 100_000 }),
    reason: fc.constantFrom(null, "no answer", "wrong address"),
  }),
  { maxLength: 25 },
);

const snapshot = async (w: Awaited<ReturnType<typeof world>>) => ({
  shipment: await w.repo.getShipment(w.shipmentId),
  events: await w.repo.listEvents(w.shipmentId),
  outbox: w.repo.outbox.map((e) => ({ type: e.type, payload: e.payload })),
});

describe("replaying all courier webhooks twice (acceptance, spec 21)", () => {
  it("yields identical shipment state, events and outbox for any sequence", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.boolean(), async (specs, cod) => {
        const w = await world(cod);
        const bodies = specs.map((s, i) =>
          trackingBody(`p-${i}`, AWB, RAW_STATE[s.kind], START_MS + s.atS * 1000, s.reason),
        );
        for (const b of bodies) {
          const r = await w.deliver(b);
          expect(r.kind).toBe("ok");
        }
        const once = await snapshot(w);
        for (const b of bodies) {
          const r = await w.deliver(b);
          expect(r).toEqual({ kind: "ok", duplicate: true });
        }
        expect(await snapshot(w)).toEqual(once);
      }),
      { numRuns: 120 },
    );
  });

  it("is also stable when duplicates are interleaved with first deliveries", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, async (specs) => {
        const bodies = specs.map((s, i) => trackingBody(`q-${i}`, AWB, RAW_STATE[s.kind], START_MS + s.atS * 1000, s.reason));
        const clean = await world(false);
        for (const b of bodies) await clean.deliver(b);
        const noisy = await world(false);
        for (const b of bodies) {
          await noisy.deliver(b);
          await noisy.deliver(b);
        }
        const a = await snapshot(clean);
        const b = await snapshot(noisy);
        expect(b.shipment).toEqual(a.shipment);
        expect(b.events.map((e) => [e.courierEventId, e.outcome, e.toStatus])).toEqual(
          a.events.map((e) => [e.courierEventId, e.outcome, e.toStatus]),
        );
      }),
      { numRuns: 80 },
    );
  });

  it("replaying a COD remittance batch twice records it once", async () => {
    const w = await world(true);
    await w.deliver(trackingBody("c-1", AWB, "Delivered", START_MS + 1000));
    const batch = remittanceBody("c-rem-1", "CR-P1", [{ awb: AWB, collected: 50_000 }]);
    expect(await w.deliver(batch)).toEqual({ kind: "ok", duplicate: false });
    const once = await snapshot(w);
    expect(await w.deliver(batch)).toEqual({ kind: "ok", duplicate: true });
    expect(await snapshot(w)).toEqual(once);
    expect(once.shipment).toMatchObject({ state: "COD_REMITTED", codStatus: "REMITTED" });
  });
});
