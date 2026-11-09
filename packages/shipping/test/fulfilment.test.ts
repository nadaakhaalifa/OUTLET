import { createHash, randomUUID } from "node:crypto";
import { brandClient, withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { roleClient } from "@outlet/db/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AddressService, CourierWebhookProcessor, CourierCancelError, MAX_WEBHOOK_BYTES, SELLER_ACCESS_INITIAL_DAYS, SHIPMENT_CANCELLED_EVENT, SHIPMENT_CANCEL_ATTENTION_EVENT, SHIPMENT_CANCEL_REQUIRED_EVENT, ShipmentCancelConsumer, ShipmentService, SnapshotRetention, TrackingStaleScanner, maskPhone } from "../src/index.js";
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
  const worker = roleClient(x.raw, "outlet_worker");
  const shipments = new ShipmentService({ ...deps, courier, labels: courier, labelStore, cipher, worker });
  const delivered: string[] = [];
  const orders = { failing: false, markDelivered: (id: string): Promise<void> => { if (orders.failing) return Promise.reject(new Error("x")); delivered.push(id); return Promise.resolve(); } };
  const tdeps = { client: worker, marketId: "EG", courierCode: "fake", courier, webhook: new FakeWebhook(), cipher, orders, now: () => x.now.value };
  const proc = new CourierWebhookProcessor(tdeps);
  const stale = new TrackingStaleScanner(tdeps);
  const retention = new SnapshotRetention(tdeps);
  const seedOrder = async (storeId: string, userId: string, status = "PACKED"): Promise<string> => {
    const id = randomUUID();
    await x.raw.query("SET session_replication_role = replica");
    await x.raw.query(
      `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor)
       VALUES ($1,$2,$3,$4,'EG','EGP',$5,'collect_payout',1000,0,0,0,1000,0,0,0,1000)`, [id, randomUUID(), storeId, userId, status]);
    await x.raw.query("SET session_replication_role = origin");
    return id;
  };
  /** Gives the seller order a delivery snapshot (the shopper's checkout step) unless it has one. */
  const snap = async (so: string, user = x.user, over: typeof input = input): Promise<void> => {
    const a = (await addresses.list(user))[0] ?? (await addresses.create(user, over));
    await addresses.snapshotForOrder(user, so, a.id);
  };
  const ship = async (so: string, cod = 0n) => { await snap(so); return shipments.create({ storeId: x.storeA, sellerOrderIds: [so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 500 }], codMinor: cod }); };
  const hook = (events: { eventId: string; awb: string; rawStatus: string; occurredAt?: string }[], sig = "valid") =>
    proc.handle(JSON.stringify({ events: events.map((e) => ({ occurredAt: T0, ...e })) }), { "x-signature": sig, "x-timestamp": x.now.value.toISOString() });
  return { x, addresses, courier, shipments, delivered, orders, proc, stale, retention, worker, seedOrder, snap, ship, hook, labelStore };
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

  it("finding 8: the content version ignores make-default and updated_at, changes on a street edit and is gone after delete", async () => {
    const s = await setup();
    const a = await s.addresses.create(s.x.user, input);
    const b = await s.addresses.create(s.x.user, { ...input, label: "work" });
    const va = await s.addresses.versionOf(s.x.user, a.id);
    const vb = await s.addresses.versionOf(s.x.user, b.id);
    expect(va).toMatch(/^[0-9a-f]{64}$/);
    s.x.now.value = new Date(s.x.now.value.getTime() + 60_000);
    await s.addresses.setDefault(s.x.user, b.id);
    expect(await s.addresses.versionOf(s.x.user, a.id)).toBe(va);
    expect(await s.addresses.versionOf(s.x.user, b.id)).toBe(vb);
    await s.addresses.update(s.x.user, b.id, { ...input, address: { ...addr, street: "Abbas El Akkad" } });
    const vb2 = await s.addresses.versionOf(s.x.user, b.id);
    expect(vb2).toMatch(/^[0-9a-f]{64}$/);
    expect(vb2).not.toBe(vb);
    expect(await s.addresses.versionOf(randomUUID(), b.id)).toBeNull();
    await s.addresses.remove(s.x.user, b.id);
    expect(await s.addresses.versionOf(s.x.user, b.id)).toBeNull();
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
    expect(v).toMatchObject({ recipientName: "Nada", phoneMasked: "+20*******567", accessUntil: new Date("2030-07-31T00:00:00.000Z") });
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
    expect(await errorCode(s.shipments.create({ storeId: s.x.storeB, sellerOrderIds: [so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 1 }] }))).toBe("not_found");
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
    expect(await errorCode(s.proc.handle("not json", { "x-signature": "valid", "x-timestamp": T0 }))).toBe("INVALID_INPUT");
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
    await s.x.raw.query("UPDATE seller_orders SET status = 'DELIVERED' WHERE id = $1", [so]);
    const sh = await s.shipments.create({ storeId: s.x.storeA, sellerOrderIds: [so], direction: "return", courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 400, dimsMm: { lengthMm: 100, widthMm: 100, heightMm: 50 } }] });
    expect(sh.status).toBe("LABEL_READY");
    expect((await q(s.x, "SELECT direction FROM shipments"))[0]?.direction).toBe("return");
  });
  it("uses default clock, id generator and outbox when not injected", async () => {
    const s = await setup();
    const courier = new FakeCourier();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(so);
    const svc = new ShipmentService({ client: s.x.app, marketId: "EG", courier, labels: courier, labelStore: new FakeLabelStore(), cipher, worker: s.worker });
    expect((await svc.create({ storeId: s.x.storeA, sellerOrderIds: [so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 1 }] })).awb).toMatch(/^FAKE/);
    const t = { client: roleClient(s.x.raw, "outlet_worker"), marketId: "EG", courierCode: "fake", courier, webhook: new FakeWebhook(), cipher, orders: s.orders };
    expect(await new TrackingStaleScanner(t).run()).toEqual([]);
    const r = await new CourierWebhookProcessor(t).handle(JSON.stringify({ events: [{ eventId: "z", awb: "none", rawStatus: "picked_up", occurredAt: T0 }] }), { "x-signature": "valid", "x-timestamp": new Date().toISOString() });
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

const MIN = 60_000;
const otherUser = async (x: World): Promise<string> => {
  const id = randomUUID();
  await x.raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',now(),now())", [id]);
  return id;
};
const asStore = <T,>(s: Awaited<ReturnType<typeof setup>>, storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> => withDbContext(s.x.app, { kind: "store", marketId: "EG", storeId }, fn);
const create = (s: Awaited<ReturnType<typeof setup>>, so: readonly string[], over: Record<string, unknown> = {}) =>
  s.shipments.create({ storeId: s.x.storeA, sellerOrderIds: [...so], courier: "fake", serviceLevel: "standard", parcels: [{ weightG: 500 }], ...over });

describe("C1: the shipment is derived from the DB, not from the seller", () => {
  it("a foreign or unknown seller order is not_found", async () => {
    const s = await setup();
    const foreign = await s.seedOrder(s.x.storeB, s.x.user);
    await s.snap(foreign);
    expect(await errorCode(create(s, [foreign]))).toBe("not_found");
    expect(await errorCode(create(s, [randomUUID()]))).toBe("not_found");
    const mine = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(mine);
    expect(await errorCode(create(s, [mine, foreign]))).toBe("not_found");
    expect(await q(s.x, "SELECT 1 FROM shipments")).toEqual([]);
  });
  it("an order that is not PACKED is invalid_state (outbound) and not DELIVERED (return)", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user, "ACCEPTED");
    await s.snap(so);
    expect(await errorCode(create(s, [so]))).toBe("invalid_state");
    expect(await errorCode(create(s, [so], { direction: "return" }))).toBe("invalid_state");
    expect(await q(s.x, "SELECT 1 FROM shipments")).toEqual([]);
  });
  it("the destination, recipient and owner cannot be overridden by the caller", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(so);
    const evil = { governorateCode: "CAI", street: "Attacker St", building: "666" };
    const attacker = await otherUser(s.x);
    await create(s, [so], { destination: evil, userId: attacker, recipient: { name: "X", phone: "+201999999999" } });
    const sent = s.courier.requests[0];
    expect(sent?.destination).toEqual(addr);
    expect(sent?.recipient).toEqual({ name: "Nada", phone: "+201001234567" });
    expect((await q(s.x, "SELECT user_id FROM shipments"))[0]?.user_id).toBe(s.x.user);
  });
  it("requires a snapshot, one shopper and one destination; a replay survives the order moving to SHIPPED", async () => {
    const s = await setup();
    const bare = await s.seedOrder(s.x.storeA, s.x.user);
    expect(await errorCode(create(s, [bare]))).toBe("invalid_state");
    const u2 = await otherUser(s.x);
    const o1 = await s.seedOrder(s.x.storeA, s.x.user);
    const o2 = await s.seedOrder(s.x.storeA, u2);
    await s.snap(o1);
    await s.snap(o2, u2);
    expect(await errorCode(create(s, [o1, o2]))).toBe("invalid_state");
    const o3 = await s.seedOrder(s.x.storeA, s.x.user);
    const other = await s.addresses.create(s.x.user, { ...input, address: { ...addr, street: "Other" } });
    await s.addresses.snapshotForOrder(s.x.user, o3, other.id);
    expect(await errorCode(create(s, [o1, o3]))).toBe("invalid_state");
    const first = await create(s, [o1]);
    await s.x.raw.query("UPDATE seller_orders SET status = 'SHIPPED' WHERE id = $1", [o1]);
    expect(await create(s, [o1])).toMatchObject({ id: first.id, replayed: true });
  });
  it("COD is outbound only (C8): service refuses it for a return and the CHECK holds below the service", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user, "DELIVERED");
    await s.snap(so);
    expect(await errorCode(create(s, [so], { direction: "return", codMinor: 5n }))).toBe("INVALID_INPUT");
    const o2 = await s.seedOrder(s.x.storeA, s.x.user);
    await s.ship(o2);
    await expect(s.x.raw.query("UPDATE shipments SET direction = 'return', cod_amount_minor = 5")).rejects.toThrow(/shipments_cod_outbound_only/);
    await s.x.raw.query("UPDATE shipments SET direction = 'return', cod_amount_minor = 0");
  });
});

describe("C2: the real phone", () => {
  it("reaches the courier but is unreadable by outlet_app and never shown to the seller", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.ship(so);
    expect(s.courier.requests[0]?.recipient.phone).toBe("+201001234567");
    const seller = await s.addresses.snapshotForSeller(s.x.storeA, so);
    expect(seller?.phoneMasked).toBe("+20*******567");
    expect(JSON.stringify(seller)).not.toContain("1001234567");
    await expect(asStore(s, s.x.storeA, (tx) => tx.query("SELECT phone_ct FROM delivery_snapshots"))).rejects.toThrow(/permission denied/);
    await expect(asStore(s, s.x.storeA, (tx) => tx.query("SELECT * FROM delivery_snapshots"))).rejects.toThrow(/permission denied/);
    await expect(withDbContext(s.x.app, { kind: "user", marketId: "EG", userId: s.x.user }, (tx) => tx.query("SELECT phone_ct FROM delivery_snapshots"))).rejects.toThrow(/permission denied/);
    const own = await asStore(s, s.x.storeA, (tx) => tx.query("SELECT seller_order_id, phone_masked_ct FROM delivery_snapshots"));
    expect(own.rows.length).toBe(1);
    const w = await withDbContext(s.worker, { kind: "worker", marketId: "EG", job: "shipping.tracking" }, (tx) => tx.query("SELECT phone_ct FROM delivery_snapshots"));
    expect(w.rows.length).toBe(1);
  });
  it("a pseudonymised snapshot no longer ships (invalid_state)", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(so);
    await s.x.raw.query("UPDATE delivery_snapshots SET phone_ct = NULL");
    expect(await errorCode(create(s, [so]))).toBe("invalid_state");
  });
});

describe("C3: seller access window and pseudonymisation", () => {
  const until = async (x: World): Promise<string> => new Date((await q(x, "SELECT seller_access_until AS u FROM delivery_snapshots"))[0]?.u as Date).toISOString();
  it("defaults to checkout + 60 days", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(so);
    expect(SELLER_ACCESS_INITIAL_DAYS).toBe(60);
    expect(await until(s.x)).toBe("2030-07-31T00:00:00.000Z");
  });
  it.each<[string, readonly string[]]>([["delivered", ["picked_up", "out_for_delivery", "delivered"]], ["return_to_origin", ["picked_up", "return_to_origin"]], ["cancelled", ["cancelled"]], ["returned_to_seller", ["picked_up", "return_to_origin", "returned_to_seller"]]])(
    "is shortened to 30 days after %s",
    async (_n, feed) => {
      const s = await setup();
      const so = await s.seedOrder(s.x.storeA, s.x.user);
      const { awb } = await s.ship(so);
      let at = Date.parse("2030-06-10T00:00:00.000Z");
      for (const [k, r] of feed.entries()) await s.hook([{ eventId: `${r}${String(k)}`, awb, rawStatus: r, occurredAt: new Date(at + k * MIN).toISOString() }]);
      at += (feed.length - 1) * MIN;
      const expected = feed.includes("returned_to_seller") ? Date.parse("2030-06-10T00:01:00.000Z") + 30 * 86_400_000 : at + 30 * 86_400_000;
      expect(Date.parse(await until(s.x))).toBe(expected);
    },
  );
  it("purgeExpiredSnapshots nulls the ciphertexts after the window, once, and the seller then sees nothing", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(so);
    expect(await s.retention.purgeExpiredSnapshots(new Date("2030-07-30T23:59:59.000Z"))).toBe(0);
    expect(await s.retention.purgeExpiredSnapshots(new Date("2030-07-31T00:00:00.000Z"))).toBe(1);
    expect(await s.retention.purgeExpiredSnapshots(new Date("2030-08-31T00:00:00.000Z"))).toBe(0);
    expect(await q(s.x, "SELECT recipient_name_ct, phone_ct, phone_masked_ct, address_ct, pin_ct, pseudonymised_at FROM delivery_snapshots")).toEqual([
      { recipient_name_ct: null, phone_ct: null, phone_masked_ct: null, address_ct: null, pin_ct: null, pseudonymised_at: new Date("2030-07-31T00:00:00.000Z") },
    ]);
    s.x.now.value = new Date("2030-07-30T00:00:00.000Z");
    expect(await s.addresses.snapshotForSeller(s.x.storeA, so)).toBeUndefined();
    const defaultClock = new SnapshotRetention({ client: s.worker, marketId: "EG", courierCode: "fake", courier: s.courier, webhook: new FakeWebhook(), cipher, orders: s.orders });
    expect(await defaultClock.purgeExpiredSnapshots()).toBe(0);
  });
});

describe("C4: out-of-order tracking", () => {
  it("an older delivery_failed after a newer event is stored as stale_order and cannot cause RTO", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const { awb, id } = await s.ship(so);
    const ev = (eventId: string, rawStatus: string, h: number) => s.hook([{ eventId, awb, rawStatus, occurredAt: new Date(Date.parse(T0) + h * 3_600_000).toISOString() }]);
    await ev("a", "picked_up", 1);
    await ev("b", "out_for_delivery", 5);
    for (const [n, h] of [["c1", 2], ["c2", 3], ["c3", 4]] as const) expect((await ev(n, "customer_unavailable", h)).outcomes[0]?.outcome).toBe("ignored");
    expect(await q(s.x, "SELECT status, attempts FROM shipments WHERE id = $1", [id])).toEqual([{ status: "OUT_FOR_DELIVERY", attempts: 0 }]);
    expect(await q(s.x, "SELECT failure_reason FROM courier_events_raw WHERE courier_event_id = 'c1'")).toEqual([{ failure_reason: "stale_order" }]);
    expect((await ev("d", "delivered", 5)).outcomes[0]?.outcome).toBe("applied"); // equal timestamp is not stale
  });
  it("a stale event that races past the first check is caught under the row lock", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const { awb, id } = await s.ship(so);
    await s.hook([{ eventId: "a", awb, rawStatus: "picked_up", occurredAt: "2030-06-01T05:00:00.000Z" }]);
    // The processor peeks without a lock; last_event_at moves forward (a concurrent webhook) just before the locked re-read.
    let first = true;
    const bump = async (tx: Queryable, sql: string): Promise<void> => {
      if (first && sql.includes("FOR UPDATE")) { first = false; await tx.query("UPDATE shipments SET last_event_at = '2030-06-01T09:00:00.000Z' WHERE id = $1", [id]); }
    };
    const spy = brandClient<"outlet_worker">({
      query: (sql, params) => s.worker.query(sql, params),
      transaction: (fn) => s.worker.transaction((tx: Queryable) => fn({ query: async (sql, params) => { await bump(tx, sql); return tx.query(sql, params); } })),
    });
    const proc = new CourierWebhookProcessor({ client: spy, marketId: "EG", courierCode: "fake", courier: s.courier, webhook: new FakeWebhook(), cipher, orders: s.orders, now: () => s.x.now.value });
    const r = await proc.handle(JSON.stringify({ events: [{ eventId: "late", awb, rawStatus: "in_transit", occurredAt: "2030-06-01T06:00:00.000Z" }] }), { "x-signature": "valid", "x-timestamp": T0 });
    expect(r.outcomes[0]?.outcome).toBe("ignored");
    expect((await q(s.x, "SELECT status FROM shipments WHERE id = $1", [id]))[0]?.status).toBe("PICKED_UP");
    expect((await q(s.x, "SELECT failure_reason FROM courier_events_raw WHERE courier_event_id = 'late'"))[0]?.failure_reason).toBe("stale_order");
  });
});

describe("C5: untrusted webhook bodies", () => {
  it("a rejected signature stores only the sha256 and size, once per distinct body", async () => {
    const s = await setup();
    const body = JSON.stringify({ events: [], secret: "attacker-controlled" });
    for (let n = 0; n < 2; n++) expect((await s.proc.handle(body, { "x-signature": "bad", "x-timestamp": T0 })).accepted).toBe(false);
    const rows = await q(s.x, "SELECT body_ct, body_sha256, body_bytes, processing_status, signature_ok FROM courier_events_raw");
    expect(rows).toEqual([{ body_ct: null, body_sha256: createHash("sha256").update(body).digest("hex"), body_bytes: Buffer.byteLength(body), processing_status: "rejected", signature_ok: false }]);
    expect(JSON.stringify(rows)).not.toContain("attacker");
  });
  it("requires a timestamp within +-5 minutes", async () => {
    const s = await setup();
    const call = async (ts: string | undefined) => (await s.proc.handle(JSON.stringify({ events: [] }), ts === undefined ? { "x-signature": "valid" } : { "x-signature": "valid", "x-timestamp": ts })).accepted;
    const base = s.x.now.value.getTime();
    expect(await call(new Date(base - 5 * MIN).toISOString())).toBe(true);
    expect(await call(new Date(base + 5 * MIN).toISOString())).toBe(true);
    expect(await call(new Date(base - 5 * MIN - 1000).toISOString())).toBe(false);
    expect(await call(new Date(base + 5 * MIN + 1000).toISOString())).toBe(false);
    expect(await call("garbage")).toBe(false);
    expect(await call(undefined)).toBe(false);
  });
  it("caps the body at 256 KB", async () => {
    const s = await setup();
    const pad = (n: number) => `{"events":[]}${" ".repeat(n - 13)}`;
    expect(MAX_WEBHOOK_BYTES).toBe(262_144);
    expect((await s.proc.handle(pad(MAX_WEBHOOK_BYTES), { "x-signature": "valid", "x-timestamp": T0 })).accepted).toBe(true);
    expect(await errorCode(s.proc.handle(pad(MAX_WEBHOOK_BYTES + 1), { "x-signature": "valid", "x-timestamp": T0 }))).toBe("INVALID_INPUT");
    expect(await q(s.x, "SELECT 1 FROM courier_events_raw")).toEqual([]);
  });
  it("accepted events seal the body with the row id in the AAD", async () => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const { awb } = await s.ship(so);
    await s.hook([{ eventId: "p1", awb, rawStatus: "picked_up" }]);
    const row = (await q(s.x, "SELECT id, body_ct FROM courier_events_raw"))[0] as { id: string; body_ct: Uint8Array };
    expect(await cipher.decrypt(row.body_ct, `courier_events_raw.body_ct:${row.id}`)).toContain("p1");
    await expect(cipher.decrypt(row.body_ct, "courier_events_raw.body_ct")).rejects.toThrow();
  });
});

describe("C6 and C7: AAD binds the row; default-address race", () => {
  it("a ciphertext moved to another address row fails to decrypt", async () => {
    const s = await setup();
    const a = await s.addresses.create(s.x.user, input);
    const b = await s.addresses.create(s.x.user, { ...input, recipientName: "Other" });
    await s.x.raw.query("UPDATE addresses SET address_ct = (SELECT address_ct FROM addresses WHERE id = $1) WHERE id = $2", [a.id, b.id]);
    await expect(s.addresses.get(s.x.user, b.id)).rejects.toThrow(/aad mismatch/);
    expect((await s.addresses.get(s.x.user, a.id)).recipientName).toBe("Nada");
  });
  it("a snapshot ciphertext moved to another seller order fails to decrypt", async () => {
    const s = await setup();
    const o1 = await s.seedOrder(s.x.storeA, s.x.user);
    const o2 = await s.seedOrder(s.x.storeA, s.x.user);
    await s.snap(o1);
    await s.snap(o2);
    await s.x.raw.query("UPDATE delivery_snapshots SET address_ct = (SELECT address_ct FROM delivery_snapshots WHERE seller_order_id = $1) WHERE seller_order_id = $2", [o1, o2]);
    await expect(s.addresses.snapshotForSeller(s.x.storeA, o2)).rejects.toThrow(/aad mismatch/);
    await expect(create(s, [o2])).rejects.toThrow(/aad mismatch/);
  });
  it("default handling takes the per-user advisory lock and concurrent defaults leave exactly one", async () => {
    const s = await setup();
    const seen: string[] = [];
    const rec = (sql: string): void => { seen.push(sql); };
    const spy = brandClient<"outlet_app">({
      query: (sql, params) => { rec(sql); return s.x.app.query(sql, params); },
      transaction: (fn) => s.x.app.transaction((tx: Queryable) => fn({ query: (sql, params) => { rec(sql); return tx.query(sql, params); } })),
    });
    const svc = new AddressService({ client: spy, marketId: "EG", now: () => s.x.now.value }, cipher);
    const made = await Promise.all([1, 2, 3, 4].map((n) => svc.create(s.x.user, { ...input, label: `l${String(n)}`, isDefault: true })));
    expect((await q(s.x, "SELECT 1 FROM addresses WHERE is_default AND user_id = $1", [s.x.user])).length).toBe(1);
    const first = made[0];
    if (first === undefined) throw new Error("no address");
    await Promise.all(made.map((m) => svc.update(s.x.user, m.id, { ...input, isDefault: true })));
    expect((await q(s.x, "SELECT 1 FROM addresses WHERE is_default AND user_id = $1", [s.x.user])).length).toBe(1);
    expect(seen.filter((x) => x.includes("pg_advisory_xact_lock")).length).toBe(8);
  });
});

describe("ShipmentCancelConsumer (M4)", () => {
  const evt = (shipmentId: string, so: string, id = randomUUID()) => ({ id, payload: { shipment_id: shipmentId, seller_order_id: so } });
  const make = async (over: { cancelShipment?: (awb: string) => Promise<void> } = {}) => {
    const s = await setup();
    const so = await s.seedOrder(s.x.storeA, s.x.user);
    const shipment = await s.ship(so);
    const calls: string[] = [];
    const courier = { cancelShipment: (awb: string): Promise<void> => { calls.push(awb); return over.cancelShipment?.(awb) ?? s.courier.cancelShipment(awb); } };
    const consumer = new ShipmentCancelConsumer({ client: s.worker, marketId: "EG", courier, now: () => s.x.now.value });
    const status = async (): Promise<string | undefined> => (await q(s.x, "SELECT status FROM shipments WHERE id = $1", [shipment.id]))[0]?.status as string | undefined;
    const emitted = async (type: string): Promise<number> => (await q(s.x, "SELECT 1 FROM outbox_events WHERE event_type = $1", [type])).length;
    return { s, so, shipment, calls, consumer, status, emitted };
  };

  it("cancels the AWB and the shipment once; a replay of the same event is a duplicate", async () => {
    const m = await make();
    const e = evt(m.shipment.id, m.so);
    expect(await m.consumer.handle(e)).toBe("processed");
    expect(await m.status()).toBe("CANCELLED");
    expect(m.s.courier.cancelled.has(m.shipment.awb)).toBe(true);
    expect(await m.emitted(SHIPMENT_CANCELLED_EVENT)).toBe(1);
    expect(await m.consumer.handle(e)).toBe("duplicate");
    expect(m.calls).toHaveLength(1);
    // a second event for the same shipment (another delivery id) finds CANCELLED: success, no courier call, no second event
    expect(await m.consumer.handle(evt(m.shipment.id, m.so))).toBe("processed");
    expect(m.calls).toHaveLength(1);
    expect(await m.emitted(SHIPMENT_CANCELLED_EVENT)).toBe(1);
    expect(await m.emitted(SHIPMENT_CANCEL_ATTENTION_EVENT)).toBe(0);
  });
  it("treats courier not_found / already_cancelled as success", async () => {
    for (const code of ["not_found", "already_cancelled"] as const) {
      const m = await make({ cancelShipment: () => Promise.reject(new CourierCancelError(code)) });
      expect(await m.consumer.handle(evt(m.shipment.id, m.so))).toBe("processed");
      expect(await m.status()).toBe("CANCELLED");
      await w?.close(); w = undefined;
    }
  });
  it("retries on any other courier failure: no inbox row, no state change; the redelivery succeeds", async () => {
    let fail = true;
    const m = await make({ cancelShipment: () => (fail ? Promise.reject(new Error("503")) : Promise.resolve()) });
    const e = evt(m.shipment.id, m.so);
    await expect(m.consumer.handle(e)).rejects.toThrow("503");
    expect(await m.status()).toBe("LABEL_READY");
    expect(await q(m.s.x, "SELECT 1 FROM inbox_processed WHERE message_id = $1", [e.id])).toHaveLength(0);
    fail = false;
    expect(await m.consumer.handle(e)).toBe("processed");
    expect(await m.status()).toBe("CANCELLED");
  });
  it("parks a courier not_cancellable refusal, a parcel already with the courier, an unknown shipment and a bad payload as attention events", async () => {
    const m = await make({ cancelShipment: () => Promise.reject(new CourierCancelError("not_cancellable")) });
    expect(await m.consumer.handle(evt(m.shipment.id, m.so))).toBe("processed");
    expect(await m.status()).toBe("LABEL_READY");
    await m.s.x.raw.query("UPDATE shipments SET status = 'IN_TRANSIT' WHERE id = $1", [m.shipment.id]);
    expect(await m.consumer.handle(evt(m.shipment.id, m.so))).toBe("processed");
    expect(await m.status()).toBe("IN_TRANSIT");
    expect(await m.consumer.handle(evt(randomUUID(), m.so))).toBe("processed");
    expect(await m.consumer.handle({ id: randomUUID(), payload: { nope: 1 } })).toBe("processed");
    const reasons = (await q(m.s.x, "SELECT payload->>'reason' AS r FROM outbox_events WHERE event_type = $1 ORDER BY occurred_at, id", [SHIPMENT_CANCEL_ATTENTION_EVENT])).map((r) => r.r);
    expect(reasons.sort()).toEqual(["already_with_courier", "courier_not_cancellable", "invalid_payload", "shipment_not_found"]);
    expect(await m.emitted(SHIPMENT_CANCELLED_EVENT)).toBe(0);
  });
  it("cancels a LABEL_PENDING shipment without an AWB and parks a shipment that carries other orders", async () => {
    const m = await make();
    await m.s.x.raw.query("UPDATE shipments SET status = 'LABEL_PENDING', awb = NULL WHERE id = $1", [m.shipment.id]);
    expect(await m.consumer.handle(evt(m.shipment.id, m.so))).toBe("processed");
    expect(await m.status()).toBe("CANCELLED");
    expect(m.calls).toHaveLength(0);
    const other = await make();
    await other.s.x.raw.query("UPDATE shipments SET seller_order_ids = $2 WHERE id = $1", [other.shipment.id, [other.so, randomUUID()]]);
    expect(await other.consumer.handle(evt(other.shipment.id, other.so))).toBe("processed");
    expect(await other.status()).toBe("LABEL_READY");
    expect((await q(other.s.x, "SELECT payload->>'reason' AS r FROM outbox_events WHERE event_type = $1", [SHIPMENT_CANCEL_ATTENTION_EVENT]))[0]?.r).toBe("multi_order_shipment");
  });
  it("exposes the trigger event name", () => { expect(SHIPMENT_CANCEL_REQUIRED_EVENT).toBe("shipment.cancel_required"); });
});

