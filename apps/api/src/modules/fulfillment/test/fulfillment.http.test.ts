import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PRINCIPALS,
  STORE_A,
  bearer,
  codOrder,
  createFulfillmentHarness,
  idemKey,
  remittanceBody,
  sellerOrder,
  trackingBody,
  type FulfillmentHarness,
} from "./harness";

let h: FulfillmentHarness;
let n = 0;

beforeAll(async () => {
  h = await createFulfillmentHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.courier.mode = "up";
  h.courier.timeoutAfterCreate = false;
});

const owner = bearer(PRINCIPALS.ownerA);

async function ship(order = sellerOrder(++n, STORE_A)) {
  h.orders.add(order);
  const res = await h
    .http()
    .post("/v1/seller/shipments")
    .set(owner)
    .set("Idempotency-Key", idemKey())
    .send({ seller_order_ids: [order.id] });
  return { order, res };
}

const T = (s: number): number => 1_800_000_000_000 + s * 1000;
let evt = 0;
const send = (awb: string, state: string, atS: number, reason: string | null = null) =>
  h.webhook(trackingBody(`evt-${++evt}`, awb, state, T(atS), reason));

describe("POST /v1/seller/shipments", () => {
  it("creates a shipment, gets the AWB synchronously and exposes no recipient data", async () => {
    const { order, res } = await ship();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      seller_order_ids: [order.id],
      courier: "bosta",
      status: "label_ready",
      label_status: "ready",
      cod_amount: null,
      attempts: 0,
      delivered_at: null,
    });
    expect(res.body.awb).toMatch(/^BST[0-9A-F]{10}$/);
    expect(JSON.stringify(res.body)).not.toContain("Test Consignee");
    expect(JSON.stringify(res.body)).not.toContain("01001234567");
    const types = h.repo.outbox.filter((e) => e.aggregateId === res.body.id).map((e) => e.type);
    expect(types).toEqual(["shipment.created", "shipment.label_created"]);
    for (const e of h.repo.outbox) expect(JSON.stringify(e.payload)).not.toContain("Consignee");
  });

  it("replays the same Idempotency-Key without a second courier call", async () => {
    const order = sellerOrder(++n, STORE_A);
    h.orders.add(order);
    const key = idemKey();
    const before = h.courier.createCalls;
    const a = await h.http().post("/v1/seller/shipments").set(owner).set("Idempotency-Key", key).send({ seller_order_ids: [order.id] });
    const b = await h.http().post("/v1/seller/shipments").set(owner).set("Idempotency-Key", key).send({ seller_order_ids: [order.id] });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(h.courier.createCalls - before).toBe(1);
  });

  it("answers 409 for a second live shipment of the same order under another key", async () => {
    const first = await ship();
    const res = await h
      .http()
      .post("/v1/seller/shipments")
      .set(owner)
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [first.order.id] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("shipment_exists");
  });

  it("requires an Idempotency-Key and validates the body strictly", async () => {
    const order = sellerOrder(++n, STORE_A);
    h.orders.add(order);
    const noKey = await h.http().post("/v1/seller/shipments").set(owner).send({ seller_order_ids: [order.id] });
    expect(noKey.status).toBe(400);
    const two = await h
      .http()
      .post("/v1/seller/shipments")
      .set(owner)
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [order.id, order.id] });
    expect(two.status).toBe(400);
    const extra = await h
      .http()
      .post("/v1/seller/shipments")
      .set(owner)
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [order.id], store_id: STORE_A });
    expect(extra.status).toBe(400);
  });

  it("rejects an order that is not shippable and an unknown courier", async () => {
    const pending = sellerOrder(++n, STORE_A, { status: "PENDING_PAYMENT" });
    h.orders.add(pending);
    const r1 = await h.http().post("/v1/seller/shipments").set(owner).set("Idempotency-Key", idemKey()).send({ seller_order_ids: [pending.id] });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe("order_not_shippable");
    const ok = sellerOrder(++n, STORE_A);
    h.orders.add(ok);
    const r2 = await h
      .http()
      .post("/v1/seller/shipments")
      .set(owner)
      .set("Idempotency-Key", idemKey())
      .send({ seller_order_ids: [ok.id], courier: "pigeon" });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe("courier_unsupported");
  });

  it("fixes the COD amount at dispatch", async () => {
    const { res } = await ship(codOrder(++n, STORE_A, 150_000n));
    expect(res.body.cod_amount).toEqual({ amount: "150000", currency: "EGP" });
  });
});

describe("AWB queue", () => {
  it("returns label_pending when the courier is down and recovers through the worker with backoff", async () => {
    h.courier.mode = "down";
    const { res } = await ship();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "label_pending", label_status: "pending", awb: null });
    const id = res.body.id as string;
    expect(await h.repo.getJob(id)).toMatchObject({ status: "PENDING", attempts: 1 });
    // not due yet: backoff holds the retry back
    expect(await h.worker.runDue()).toMatchObject({ attempted: 0 });
    h.clock.advance(31_000);
    h.courier.mode = "up";
    expect(await h.worker.runDue()).toMatchObject({ attempted: 1, created: 1 });
    const got = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(got.body).toMatchObject({ status: "label_ready", label_status: "ready" });
    expect(got.body.awb).toMatch(/^BST/);
  });

  it("dead-letters after 8 failed attempts, counts the DLQ metric and can be requeued", async () => {
    h.courier.mode = "down";
    const { res } = await ship();
    const id = res.body.id as string;
    const before = h.metrics.get("fulfillment_awb_dlq_total", { courier: "bosta" });
    for (let i = 0; i < 12; i += 1) {
      h.clock.advance(16 * 60_000);
      await h.worker.runDue();
    }
    expect(await h.repo.getJob(id)).toMatchObject({ status: "DEAD", attempts: 8, lastErrorCode: "courier_unavailable" });
    expect(h.metrics.get("fulfillment_awb_dlq_total", { courier: "bosta" })).toBe(before + 1);
    expect(h.repo.outbox.filter((e) => e.aggregateId === id && e.type === "courier.awb_dead_lettered")).toHaveLength(1);
    const got = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(got.body).toMatchObject({ status: "label_pending", label_status: "failed" });
    // a dead job is never retried on its own
    const calls = h.courier.createCalls;
    h.clock.advance(60 * 60_000);
    await h.worker.runDue();
    expect(h.courier.createCalls).toBe(calls);
    h.courier.mode = "up";
    expect(await h.worker.requeue(id)).toBe(true);
    expect(await h.worker.runDue()).toMatchObject({ created: 1 });
  });

  it("reuses the courier's AWB when a response was lost after the delivery was created", async () => {
    h.courier.timeoutAfterCreate = true;
    const { res } = await ship();
    expect(res.body.status).toBe("label_pending");
    const id = res.body.id as string;
    expect(h.courier.created.size).toBeGreaterThan(0);
    const calls = h.courier.createCalls;
    h.clock.advance(31_000);
    await h.worker.runDue();
    expect(h.courier.createCalls).toBe(calls + 1);
    const got = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(got.body.awb).toBe(h.courier.created.get(id));
  });

  it("dead-letters immediately on a permanent courier rejection", async () => {
    h.courier.mode = "reject";
    const { res } = await ship();
    const id = res.body.id as string;
    expect(await h.repo.getJob(id)).toMatchObject({ status: "DEAD", attempts: 1, lastErrorCode: "bosta_1043" });
    expect(res.body.label_status).toBe("failed");
  });
});

describe("label", () => {
  it("serves the A6 PDF and answers 409 while the label is pending", async () => {
    const { res } = await ship();
    const pdf = await h.http().get(`/v1/seller/shipments/${res.body.id}/label`).set(owner).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 4).toString("latin1")).toBe("%PDF");

    h.courier.mode = "down";
    const pending = await ship();
    const r = await h.http().get(`/v1/seller/shipments/${pending.res.body.id}/label`).set(owner);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("label_not_ready");
  });
});

describe("courier webhooks", () => {
  it("walks a shipment to delivered, stamps delivered_at from the courier event and emits it once", async () => {
    const { res } = await ship();
    const id = res.body.id as string;
    const awb = res.body.awb as string;
    expect((await send(awb, "Picked up", 10)).status).toBe(200);
    expect((await send(awb, "In transit", 20)).status).toBe(200);
    expect((await send(awb, "Out for delivery", 30)).status).toBe(200);
    const delivered = await send(awb, "Delivered", 40);
    expect(delivered.body).toEqual({ received: true, duplicate: false });
    const got = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(got.body.status).toBe("delivered");
    expect(got.body.delivered_at).toBe(new Date(T(40)).toISOString());
    expect(got.body.events.map((e: { status: string }) => e.status)).toEqual([
      "picked_up", "in_transit", "out_for_delivery", "delivered",
    ]);
    const ev = h.repo.outbox.filter((e) => e.aggregateId === id && e.type === "shipment.delivered");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ delivered_at: new Date(T(40)).toISOString(), seller_order_id: res.body.seller_order_ids[0] });
    // a later delivered with another time changes nothing
    await send(awb, "Delivered", 90);
    const again = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(again.body.delivered_at).toBe(new Date(T(40)).toISOString());
  });

  it("replaying every webhook twice yields identical state and no extra events", async () => {
    const { res } = await ship();
    const id = res.body.id as string;
    const awb = res.body.awb as string;
    const bodies = [
      trackingBody("r-1", awb, "Picked up", T(1)),
      trackingBody("r-2", awb, "Out for delivery", T(2)),
      trackingBody("r-3", awb, "Delivery failed", T(3), "no answer"),
      trackingBody("r-4", awb, "Out for delivery", T(4)),
      trackingBody("r-5", awb, "Delivered", T(5)),
    ];
    for (const b of bodies) expect((await h.webhook(b)).status).toBe(200);
    const once = (await h.http().get(`/v1/seller/shipments/${id}`).set(owner)).body;
    const outboxOnce = h.repo.outbox.length;
    for (const b of bodies) {
      const r = await h.webhook(b);
      expect(r.status).toBe(200);
      expect(r.body.duplicate).toBe(true);
    }
    const twice = (await h.http().get(`/v1/seller/shipments/${id}`).set(owner)).body;
    expect(twice).toEqual(once);
    expect(h.repo.outbox.length).toBe(outboxOnce);
    expect(once.attempts).toBe(1);
  });

  it("initiates RTO after the third failed attempt", async () => {
    const { res } = await ship();
    const awb = res.body.awb as string;
    for (let a = 1; a <= 3; a += 1) {
      await send(awb, "Out for delivery", a * 10);
      await send(awb, "Delivery failed", a * 10 + 1, "no answer");
    }
    const got = await h.http().get(`/v1/seller/shipments/${res.body.id}`).set(owner);
    expect(got.body).toMatchObject({ status: "rto", attempts: 3 });
    expect(h.repo.outbox.some((e) => e.aggregateId === res.body.id && e.type === "shipment.rto_initiated")).toBe(true);
    await send(awb, "Returned to seller", 100);
    const done = await h.http().get(`/v1/seller/shipments/${res.body.id}`).set(owner);
    expect(done.body.status).toBe("returned_to_seller");
  });

  it("rejects bad signatures, tampered bodies, stale timestamps and unknown couriers, storing nothing", async () => {
    const { res } = await ship();
    const awb = res.body.awb as string;
    const body = trackingBody("bad-1", awb, "Delivered", T(5));
    const wrongSecret = await h.webhook(body, { secret: "not-the-secret-at-all-0000" });
    expect(wrongSecret.status).toBe(401);
    const tampered = await h.webhook(body, { raw: JSON.stringify({ ...body, trackingNumber: "BST0000000000" }) });
    expect(tampered.status).toBe(401);
    const stale = await h.webhook(body, { timestampSeconds: Math.floor(h.clock.nowMs() / 1000) - 301 });
    expect(stale.status).toBe(401);
    const missing = await h.http().post("/v1/webhooks/couriers/bosta").set("content-type", "application/json").send(JSON.stringify(body));
    expect(missing.status).toBe(401);
    const unknown = await h.webhook(body, { courier: "nope" });
    expect(unknown.status).toBe(404);
    expect(h.repo.rawStatusForTest("bosta", "bad-1")).toBeNull();
    const got = await h.http().get(`/v1/seller/shipments/${res.body.id}`).set(owner);
    expect(got.body.status).toBe("label_ready");
  });

  it("accepts the previous secret during rotation", async () => {
    const { res } = await ship();
    const r = await h.webhook(trackingBody("rot-1", res.body.awb, "Picked up", T(1)), { secret: "whsec_test_previous_9876543210" });
    expect(r.status).toBe(200);
  });

  it("acknowledges an unknown status without changing state and counts it", async () => {
    const { res } = await ship();
    const before = h.metrics.get("fulfillment_webhook_total", { courier: "bosta", outcome: "unknown_status" });
    const r = await send(res.body.awb as string, "Teleported", 5);
    expect(r.status).toBe(200);
    expect(h.metrics.get("fulfillment_webhook_total", { courier: "bosta", outcome: "unknown_status" })).toBe(before + 1);
    const got = await h.http().get(`/v1/seller/shipments/${res.body.id}`).set(owner);
    expect(got.body.status).toBe("label_ready");
  });

  it("answers 400 for a signed but malformed payload", async () => {
    const r = await h.webhook({ hello: "world" });
    expect(r.status).toBe(400);
  });

  it("holds a webhook that beats the AWB write and applies it once the AWB is stored", async () => {
    h.courier.mode = "down";
    const { res } = await ship();
    const id = res.body.id as string;
    expect(res.body.awb).toBeNull();
    const futureAwb = h.courier.awbFor(id);
    const r = await send(futureAwb, "Picked up", 7);
    expect(r.status).toBe(200);
    expect(h.repo.rawStatusForTest("bosta", `evt-${evt}`)).toBe("UNMATCHED");
    h.courier.mode = "up";
    h.clock.advance(31_000);
    await h.worker.runDue();
    const got = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(got.body.awb).toBe(futureAwb);
    expect(got.body.status).toBe("picked_up");
  });
});

describe("COD remittance records", () => {
  it("matches a remittance to a delivered COD shipment and records it without posting money", async () => {
    const { res } = await ship(codOrder(++n, STORE_A, 150_000n));
    const id = res.body.id as string;
    const awb = res.body.awb as string;
    await send(awb, "Out for delivery", 10);
    await send(awb, "Delivered", 20);
    expect((await h.repo.getShipment(id))?.codStatus).toBe("COLLECTED");
    expect(h.repo.outbox.some((e) => e.aggregateId === id && e.type === "cod.collected")).toBe(true);
    const r = await h.webhook(remittanceBody("rem-evt-1", "CR-100", [{ awb, collected: 150_000, fee: 2_500 }]));
    expect(r.status).toBe(200);
    const s = await h.repo.getShipment(id);
    expect(s).toMatchObject({ state: "COD_REMITTED", codStatus: "REMITTED" });
    const rem = await h.repo.findRemittance("bosta", "CR-100");
    expect(rem).toMatchObject({ status: "MATCHED", total: { amount: 150_000n } });
    expect(rem?.lines[0]).toMatchObject({ match: "MATCHED", fee: { amount: 2_500n } });
    expect(h.repo.outbox.some((e) => e.type === "cod_remittance.matched")).toBe(true);
    // the same batch under another event id is a duplicate
    const dup = await h.webhook(remittanceBody("rem-evt-2", "CR-100", [{ awb, collected: 150_000 }]));
    expect(dup.body.duplicate).toBe(true);
    const wire = await h.http().get(`/v1/seller/shipments/${id}`).set(owner);
    expect(wire.body.status).toBe("delivered");
  });

  it("flags an amount mismatch and keeps the shipment where it is", async () => {
    const { res } = await ship(codOrder(++n, STORE_A, 99_900n));
    const id = res.body.id as string;
    const awb = res.body.awb as string;
    await send(awb, "Delivered", 20);
    await h.webhook(remittanceBody("rem-evt-3", "CR-101", [{ awb, collected: 90_000 }, { awb: "BSTUNKNOWN0", collected: 1_000 }]));
    expect(await h.repo.getShipment(id)).toMatchObject({ state: "DELIVERED", codStatus: "MISMATCH" });
    const rem = await h.repo.findRemittance("bosta", "CR-101");
    expect(rem?.status).toBe("MISMATCH");
    expect(rem?.lines.map((l) => l.match).sort()).toEqual(["AMOUNT_DIFF", "UNKNOWN_AWB"]);
    expect(h.repo.outbox.some((e) => e.type === "cod_remittance.mismatch")).toBe(true);
  });

  it("rejects a remittance that lists the same AWB twice", async () => {
    const r = await h.webhook(remittanceBody("rem-evt-4", "CR-102", [{ awb: "BSTDUP0001", collected: 1 }, { awb: "BSTDUP0001", collected: 2 }]));
    expect(r.status).toBe(400);
  });
});

describe("delivered_at consumed by returns", () => {
  it("exposes the courier-confirmed time through the read port", async () => {
    const { res, order } = await ship();
    const { RepositoryDeliveredAtReader } = await import("../application/shipments");
    const reader = new RepositoryDeliveredAtReader(h.repo);
    expect(await reader.deliveredAtMs(order.id)).toBeNull();
    await send(res.body.awb as string, "Delivered", 55);
    expect(await reader.deliveredAtMs(order.id)).toBe(T(55));
  });
});
