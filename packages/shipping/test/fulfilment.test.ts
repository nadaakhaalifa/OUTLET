import { randomUUID } from "node:crypto";
import { roleClient } from "@outlet/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AddressService, CourierWebhookProcessor, ShipmentService, TrackingStaleScanner, maskPhone } from "../src/index.js";
import { FakeCipher, FakeCourier, FakeLabelStore, FakeWebhook } from "../src/testing.js";
import { buildWorld, errorCode } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World | undefined;
afterEach(async () => { await w?.close(); w = undefined; });

const cipher = new FakeCipher();
const addr = { governorateCode: "CAI", cityCode: "CAI-NASR", street: "Tahrir", building: "5", landmark: "Mosque", pin: { lat: 30, lng: 31 } };
const input = { label: "home", recipientName: "Nada", phone: "+201001234567", address: addr };
const T0 = "2030-06-01T00:00:00.000Z";

const setup = async () => {
  const x = (w = await buildWorld());
  const deps = { client: x.app, marketId: "EG", now: () => x.now.value };
  const addresses = new AddressService(deps, cipher);
  const courier = new FakeCourier();
  const labelStore = new FakeLabelStore();
  const shipments = new ShipmentService({ ...deps, courier, labels: courier, labelStore });
  const delivered: string[] = [];
  const orders = { failing: false, markDelivered: (id: string): Promise<void> => { if (orders.failing) return Promise.reject(new Error("x")); delivered.push(id); return Promise.resolve(); } };
  const tdeps = { client: roleClient(x.raw, "outlet_worker"), marketId: "EG", courierCode: "fake", courier, webhook: new FakeWebhook(), cipher, orders, now: () => x.now.value };
  const proc = new CourierWebhookProcessor(tdeps);
  const stale = new TrackingStaleScanner(tdeps);
  const seedOrder = async (storeId: string, userId: string): Promise<string> => {
    const id = randomUUID();
    await x.raw.query("SET session_replication_role = replica");
    await x.raw.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor)
       VALUES ($1,$2,$3,$4,'EG','EGP','SHIPPED','collect_payout',1000,0,0,0,1000,0,0,0,1000)`, [id, randomUUID(), storeId, userId]);
    await x.raw.query("SET session_replication_role = origin");
    return id;
  };
  const ship = async (so: string, cod = 0n) => shipments.create({ storeId: x.storeA, userId: x.user, sellerOrderIds: [so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 500 }], destination: addr, codMinor: cod });
  const hook = (events: { eventId: string; awb: string; rawStatus: string; occurredAt?: string }[], sig = "valid") =>
    proc.handle(JSON.stringify({ events: events.map((e) => ({ occurredAt: T0, ...e })) }), { "x-signature": sig });
  return { x, addresses, courier, shipments, delivered, orders, proc, stale, seedOrder, ship, hook, labelStore };
};
const q = async (x: World, sql: string, p: unknown[] = []) => (await x.raw.query(sql, p)).rows;

describe("AddressService", () => {
  it("CRUD, default handling, encrypted at rest, COD eligibility", async () => {
    const s = await setup();
    const a = await s.addresses.create(s.x.user, input);
    expect(a).toMatchObject({ isDefault: true, codEligible: true, recipientName: "Nada" });
    const b = await s.addresses.create(s.x.user, { ...input, address: { governorateCode: "CAI", street: "s", building: "1" }, isDefault: true });
    expect(b.codEligible).toBe(false);
    expect(await s.addresses.codEligible(s.x.user, b.id)).toBe(false);
    expect((await s.addresses.list(s.x.user)).map((r) => [r.id, r.isDefault])).toEqual([[b.id, true], [a.id, false]]);
    const raw = await q(s.x, "SELECT address_ct FROM addresses WHERE id = $1", [a.id]);
    expect(raw[0]?.address_ct).toBeInstanceOf(Uint8Array);
    const up = await s.addresses.update(s.x.user, a.id, { ...input, recipientName: "Sara", isDefault: true });
    expect(up).toMatchObject({ recipientName: "Sara", isDefault: true });
    expect((await s.addresses.get(s.x.user, b.id)).isDefault).toBe(false);
    await s.addresses.remove(s.x.user, b.id);
    expect(await errorCode(s.addresses.get(s.x.user, b.id))).toBe("not_found");
    expect(await errorCode(s.addresses.remove(s.x.user, b.id))).toBe("not_found");
    expect(await errorCode(s.addresses.create(s.x.user, { ...input, phone: "abc" }))).toBe("INVALID_ADDRESS");
    expect(await errorCode(s.addresses.create(s.x.user, { ...input, address: { ...addr, governorateCode: "XX" } }))).toBe("INVALID_ADDRESS");
  });

  it("another user cannot read, update or delete it (404)", async () => {
    const s = await setup();
    const a = await s.addresses.create(s.x.user, input);
    const other = randomUUID();
    await s.x.raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',now(),now())", [other]);
    expect(await errorCode(s.addresses.get(other, a.id))).toBe("not_found");
    expect(await errorCode(s.addresses.update(other, a.id, input))).toBe("not_found");
    expect(await errorCode(s.addresses.remove(other, a.id))).toBe("not_found");
    expect(await s.addresses.list(other)).toEqual([]);
  });

  it("district without city is invalid; district resolves", async () => {
    const s = await setup();
    expect(await errorCode(s.addresses.create(s.x.user, { ...input, address: { ...addr, cityCode: undefined, districtCode: "d" } }))).toBe("INVALID_ADDRESS");
    expect(maskPhone("+201001234567")).toBe("+20*******567");
    expect(maskPhone("01001234567")).toBe("********567");
  });
});

describe("delivery snapshots", () => {
  it("freezes masked data, is idempotent, store-scoped and ends at seller_access_until", async () => {
    const s = await setup();
    const a = await s.addresses.create(s.x.user, input);
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.addresses.snapshotForOrder(s.x.user, so, a.id);
    await s.addresses.snapshotForOrder(s.x.user, so, a.id);
    expect((await q(s.x, "SELECT 1 FROM delivery_snapshots")).length).toBe(1);
    const v = await s.addresses.snapshotForSeller(s.x.storeA, so);
    expect(v).toMatchObject({ recipientName: "Nada", phoneMasked: "+20*******567", accessUntil: null });
    expect(await s.addresses.snapshotForSeller(s.x.storeB, so)).toBeUndefined();
    await s.x.raw.query("UPDATE delivery_snapshots SET seller_access_until = now() - interval '1 second'");
    expect(await s.addresses.snapshotForSeller(s.x.storeA, so)).toBeUndefined();
    expect(await errorCode(s.addresses.snapshotForOrder(s.x.user, randomUUID(), a.id))).toBe("not_found");
  });
});

describe("ShipmentService", () => {
  it("is idempotent by seller order, stores the label and emits shipment.created once", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const a = await s.ship(so, 5000n);
    const b = await s.ship(so, 5000n);
    expect(b).toMatchObject({ id: a.id, awb: a.awb, replayed: true });
    expect(s.courier.created.size).toBe(1);
    expect(s.labelStore.objects.has(a.labelObjectKey)).toBe(true);
    expect((await q(s.x, "SELECT 1 FROM outbox_events WHERE event_type = 'shipment.created'")).length).toBe(1);
    expect(await q(s.x, "SELECT status, cod_amount_minor::text AS c FROM shipments")).toEqual([{ status: "LABEL_READY", c: "5000" }]);
  });
  it("a courier failure leaves LABEL_PENDING and the retry reuses the shipment", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    s.courier.failNext = true;
    expect(await errorCode(s.ship(so))).toBe("COURIER_UNAVAILABLE");
    expect((await q(s.x, "SELECT status FROM shipments"))[0]?.status).toBe("LABEL_PENDING");
    const ok = await s.ship(so);
    expect(ok.replayed).toBe(false);
    expect((await q(s.x, "SELECT 1 FROM shipments")).length).toBe(1);
  });
  it("rejects invalid input and a store that does not own the row stays 404", async () => {
    const s = await setup();
    expect(await errorCode(s.shipments.create({ storeId: "x" } as never))).toBe("INVALID_INPUT");
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.ship(so);
    // store B cannot see or take over store A's shipment for the same seller order: RLS hides it, so it is a 404.
    expect(await errorCode(s.shipments.create({ storeId: s.x.storeB, userId: s.x.user, sellerOrderIds: [so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 1 }], destination: addr }))).toBe("not_found");
  });
});

describe("CourierWebhookProcessor", () => {
  const shipped = async (s: Awaited<ReturnType<typeof setup>>, cod = 0n) => {
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const sh = await s.ship(so, cod);
    return { so, awb: sh.awb, id: sh.id };
  };
  it("rejects a bad signature (stored, flagged) and a malformed body", async () => {
    const s = await setup();
    expect((await s.hook([], "bad")).accepted).toBe(false);
    expect(await q(s.x, "SELECT signature_ok, processing_status FROM courier_events_raw")).toEqual([{ signature_ok: false, processing_status: "rejected" }]);
    expect(await errorCode(s.proc.handle("not json", { "x-signature": "valid" }))).toBe("INVALID_INPUT");
  });
  it("normalisation table: applied, duplicate, unknown status, unknown awb, invalid transition", async () => {
    const s = await setup();
    const { awb } = await shipped(s);
    const run = async (eventId: string, rawStatus: string, a = awb) => (await s.hook([{ eventId, awb: a, rawStatus }])).outcomes[0]?.outcome;
    expect(await run("e1", "picked_up")).toBe("applied");
    expect(await run("e1", "picked_up")).toBe("duplicate");
    expect(await run("e2", "weird")).toBe("ignored");
    expect(await run("e3", "picked_up", "NOPE")).toBe("ignored");
    expect(await run("e4", "picked_up")).toBe("ignored"); // same status, new event id
    expect(await run("e5", "delivered")).toBe("ignored"); // PICKED_UP -> DELIVERED invalid
    expect(await run("e6", "in_transit")).toBe("applied");
    expect(await q(s.x, "SELECT processing_status AS s, failure_reason AS r FROM courier_events_raw ORDER BY courier_event_id")).toEqual([
      { s: "processed", r: null }, { s: "ignored", r: "unknown_status" }, { s: "ignored", r: "unknown_awb" }, { s: "ignored", r: "same_status" }, { s: "ignored", r: "invalid_transition" }, { s: "processed", r: null },
    ]);
  });
  it("delivered: markDelivered, event, COD hook, seller access window; replay is a no-op", async () => {
    const s = await setup();
    const a = await s.addresses.create(s.x.user, input);
    const { so, awb, id } = await shipped(s, 7000n);
    await s.addresses.snapshotForOrder(s.x.user, so, a.id);
    const feed = [["d1", "picked_up"], ["d2", "out_for_delivery"], ["d3", "delivered"]] as const;
    for (const [e, r] of feed) await s.hook([{ eventId: e, awb, rawStatus: r }]);
    expect(s.delivered).toEqual([so]);
    const ev = await q(s.x, "SELECT event_type, payload FROM outbox_events WHERE event_type IN ('seller_order.delivered','shipment.cod_collected') ORDER BY event_type");
    expect(ev.map((e) => e.event_type)).toEqual(["seller_order.delivered", "shipment.cod_collected"]);
    expect(ev[0]?.payload).toMatchObject({ seller_order_id: so, store_id: s.x.storeA, market_id: "EG", user_id: s.x.user });
    const snap = await q(s.x, "SELECT seller_access_until FROM delivery_snapshots");
    expect(new Date(snap[0]?.seller_access_until as Date).toISOString()).toBe("2030-07-01T00:00:00.000Z");
    for (const [e, r] of feed) await s.hook([{ eventId: e, awb, rawStatus: r }]);
    expect(s.delivered).toEqual([so]);
    expect((await q(s.x, "SELECT 1 FROM outbox_events WHERE event_type = 'seller_order.delivered'")).length).toBe(1);
    expect((await q(s.x, "SELECT status, delivered_at FROM shipments WHERE id = $1", [id]))[0]?.status).toBe("DELIVERED");
  });
  it("a markDelivered failure leaves the event failed; redelivery finishes it", async () => {
    const s = await setup();
    const { awb } = await shipped(s);
    await s.hook([{ eventId: "f1", awb, rawStatus: "picked_up" }, { eventId: "f2", awb, rawStatus: "out_for_delivery" }]);
    s.orders.failing = true;
    expect((await s.hook([{ eventId: "f3", awb, rawStatus: "delivered" }])).outcomes[0]?.outcome).toBe("failed");
    expect((await q(s.x, "SELECT status FROM shipments"))[0]?.status).toBe("OUT_FOR_DELIVERY");
    s.orders.failing = false;
    expect((await s.hook([{ eventId: "f3", awb, rawStatus: "delivered" }])).outcomes[0]?.outcome).toBe("applied");
    expect((await q(s.x, "SELECT status FROM shipments"))[0]?.status).toBe("DELIVERED");
  });
  it("the third failed attempt moves to RTO and emits shipment.rto", async () => {
    const s = await setup();
    const { awb } = await shipped(s);
    await s.hook([{ eventId: "r0", awb, rawStatus: "picked_up" }]);
    for (let n = 1; n <= 3; n++) {
      await s.hook([{ eventId: `o${String(n)}`, awb, rawStatus: "out_for_delivery" }]);
      await s.hook([{ eventId: `x${String(n)}`, awb, rawStatus: "customer_unavailable" }]);
    }
    expect(await q(s.x, "SELECT status, attempts FROM shipments")).toEqual([{ status: "RTO", attempts: 3 }]);
    expect((await q(s.x, "SELECT 1 FROM outbox_events WHERE event_type = 'shipment.rto'")).length).toBe(1);
  });
  it("stale scanner emits one tracking_stale per silence after 48 h", async () => {
    const s = await setup();
    const { awb, id } = await shipped(s);
    await s.hook([{ eventId: "s1", awb, rawStatus: "picked_up" }]);
    expect(await s.stale.run()).toEqual([]);
    s.x.now.value = new Date("2030-06-03T00:00:01.000Z");
    expect(await s.stale.run()).toEqual([id]);
    expect(await s.stale.run()).toEqual([]);
    expect((await q(s.x, "SELECT 1 FROM outbox_events WHERE event_type = 'shipment.tracking_stale'")).length).toBe(1);
  });
});

describe("optional fields and defaults", () => {
  it("address without label or pin, update without default flag, snapshot without pin, shipment with dims", async () => {
    const s = await setup();
    const bare = { recipientName: "N", phone: "+201001234567", address: { governorateCode: "CAI", street: "s", building: "1" } };
    const a = await s.addresses.create(s.x.user, bare);
    expect(a.label).toBeNull();
    expect((await s.addresses.update(s.x.user, a.id, bare)).isDefault).toBe(true);
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.addresses.snapshotForOrder(s.x.user, so, a.id);
    expect((await s.addresses.snapshotForSeller(s.x.storeA, so))?.address.pin).toBeUndefined();
    const sh = await s.shipments.create({ storeId: s.x.storeA, userId: s.x.user, sellerOrderIds: [so], direction: "return", courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 400, dimsMm: { lengthMm: 100, widthMm: 100, heightMm: 50 } }], destination: bare.address });
    expect(sh.status).toBe("LABEL_READY");
    expect((await q(s.x, "SELECT direction FROM shipments"))[0]?.direction).toBe("return");
  });
  it("uses default clock, id generator and outbox when not injected", async () => {
    const s = await setup();
    const courier = new FakeCourier();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const svc = new ShipmentService({ client: s.x.app, marketId: "EG", courier, labels: courier, labelStore: new FakeLabelStore() });
    expect((await svc.create({ storeId: s.x.storeA, userId: s.x.user, sellerOrderIds: [so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 1 }], destination: addr })).awb).toMatch(/^FAKE/);
    const t = { client: roleClient(s.x.raw, "outlet_worker"), marketId: "EG", courierCode: "fake", courier, webhook: new FakeWebhook(), cipher, orders: s.orders };
    expect(await new TrackingStaleScanner(t).run()).toEqual([]);
    const r = await new CourierWebhookProcessor(t).handle(JSON.stringify({ events: [{ eventId: "z", awb: "none", rawStatus: "picked_up", occurredAt: T0 }] }), { "x-signature": "valid" });
    expect(r.outcomes[0]?.outcome).toBe("ignored");
  });
});

describe("env defaults", () => {
  it("defaults the clock and fails international closed", async () => {
    const { makeEnv } = await import("../src/index.js");
    const e = makeEnv({ client: undefined as never, marketId: "EG" });
    expect(e.now()).toBeInstanceOf(Date);
    expect(await e.isInternationalEnabled()).toBe(false);
    expect(makeEnv({ client: undefined as never, marketId: "EG", now: () => new Date(0), isInternationalEnabled: () => Promise.resolve(true) }).now().getTime()).toBe(0);
  });
});
