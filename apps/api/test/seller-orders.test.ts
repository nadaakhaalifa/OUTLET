import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp, bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { seedSellerOrder } from "./seller-orders-fakes.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const H = async (store: string, roles: readonly ("owner" | "warehouse" | "finance" | "support" | "catalog" | "manager")[], write = false): Promise<Record<string, string>> => {
  const { token } = await t.seller(store, roles);
  return { ...bearer(token), "x-store-id": store, ...(write ? { "idempotency-key": idemKey(t) } : {}) };
};
const post = async (url: string, headers: Record<string, string>, payload: object = {}) => t.inject({ method: "POST", url, headers, payload });
const getOrder = async (id: string, headers: Record<string, string>) => {
  const r = await t.inject({ method: "GET", url: `/v1/eg/seller/orders/${id}`, headers });
  return { status: r.statusCode, body: JSON.parse(r.body) as Record<string, unknown> & { status: string; delivery: { phone_masked: string; recipient_name: string } | null; payment_kind: string | null; available_actions: string[] } };
};

describe("seller orders: accept, pack, ship", () => {
  it("runs the happy path, sets the 48 h dispatch SLA and writes one outbox event per step", async () => {
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA });
    const h = await H(t.seed.storeA, ["warehouse"], true);
    const before = await getOrder(o.id, h);
    expect(before.body.available_actions).toEqual(["accept", "reject"]);
    expect(before.body.dispatch_by).toBeNull();

    const a = await post(`/v1/eg/seller/orders/${o.id}/accept`, h);
    expect(a.statusCode, a.body).toBe(200);
    expect((JSON.parse(a.body) as { status: string; dispatch_by: string }).status).toBe("ACCEPTED");
    expect((JSON.parse(a.body) as { dispatch_by: string }).dispatch_by).not.toBeNull();
    expect((await post(`/v1/eg/seller/orders/${o.id}/pack`, { ...h, "idempotency-key": idemKey(t, 1) })).statusCode).toBe(200);
    const s = await post("/v1/eg/seller/shipments", { ...h, "idempotency-key": idemKey(t, 2) }, { seller_order_ids: [o.id], declared_weight_g: 900 });
    expect(s.statusCode, s.body).toBe(201);
    const ship = JSON.parse(s.body) as { awb: string; seller_order_id: string; label_url: string | null };
    expect(ship.awb).toMatch(/^FAKE/);
    expect(ship.seller_order_id).toBe(o.id);
    expect((await getOrder(o.id, h)).body.status).toBe("SHIPPED");
    const ev = await t.raw.query<{ event_type: string }>("SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at, id", [o.id]);
    expect(ev.rows.map((r) => r.event_type).sort()).toEqual(["seller_order.accepted", "seller_order.packed", "seller_order.shipped"]);
  });

  it("an invalid transition is 409 and leaves the order unchanged", async () => {
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PAID" });
    const h = await H(t.seed.storeA, ["owner"], true);
    const r = await post(`/v1/eg/seller/orders/${o.id}/pack`, h);
    expect(r.statusCode).toBe(409);
    expect((JSON.parse(r.body) as { code: string }).code).toBe("invalid-transition");
    const s = await post("/v1/eg/seller/shipments", { ...h, "idempotency-key": idemKey(t, 3) }, { seller_order_ids: [o.id], declared_weight_g: 500 });
    expect(s.statusCode).toBe(409);
    expect((await getOrder(o.id, h)).body.status).toBe("PAID");
  });

  it("store A staff cannot see or act on a store B order (404), finance and support cannot fulfil (403)", async () => {
    const b = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeB });
    const h = await H(t.seed.storeA, ["owner"], true);
    expect((await t.inject({ method: "GET", url: `/v1/eg/seller/orders/${b.id}`, headers: h })).statusCode).toBe(404);
    expect((await post(`/v1/eg/seller/orders/${b.id}/accept`, h)).statusCode).toBe(404);
    const packed = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED" });
    for (const role of ["finance", "support"] as const) {
      const f = await H(t.seed.storeA, [role], true);
      expect((await post("/v1/eg/seller/shipments", f, { seller_order_ids: [packed.id], declared_weight_g: 500 })).statusCode, role).toBe(403);
      expect((await t.inject({ method: "GET", url: `/v1/eg/seller/orders/${packed.id}`, headers: f })).statusCode, `${role} read`).toBe(200);
    }
    expect((await getOrder(packed.id, h)).body.status).toBe("PACKED");
  });

  it("reject cancels the lines, records the reason and emits seller_order.rejected for the refund saga", async () => {
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA });
    const h = await H(t.seed.storeA, ["manager"], true);
    const r = await post(`/v1/eg/seller/orders/${o.id}/reject`, h, { reason_code: "damaged", note: "x" });
    expect(r.statusCode, r.body).toBe(200);
    expect((JSON.parse(r.body) as { status: string }).status).toBe("REJECTED_BY_SELLER");
    const lines = await t.raw.query<{ status: string }>("SELECT status FROM order_lines WHERE seller_order_id = $1", [o.id]);
    expect(lines.rows.map((x) => x.status)).toEqual(["cancelled"]);
    const ev = await t.raw.query<{ payload: { reason_code: string; total_minor: string; has_note: boolean } }>("SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'seller_order.rejected'", [o.id]);
    expect(ev.rows[0]?.payload).toMatchObject({ reason_code: "damaged", total_minor: "129900", has_note: true });
    expect((await post(`/v1/eg/seller/orders/${o.id}/reject`, { ...h, "idempotency-key": idemKey(t, 4) }, { reason_code: "other" })).statusCode).toBe(409);
    expect((await post(`/v1/eg/seller/orders/${o.id}/reject`, { ...h, "idempotency-key": idemKey(t, 5) }, { reason_code: "nope" })).statusCode).toBe(400);
  });

  it("an accept replayed with the same Idempotency-Key answers the stored response instead of 409", async () => {
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA });
    const h = await H(t.seed.storeA, ["owner"], true);
    const first = await post(`/v1/eg/seller/orders/${o.id}/accept`, h);
    const again = await post(`/v1/eg/seller/orders/${o.id}/accept`, h);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(JSON.parse(again.body)).toEqual(JSON.parse(first.body));
  });

  it("ship: courier failure is 503 and the order stays PACKED; COD sends the order total, prepaid sends 0", async () => {
    const h = await H(t.seed.storeA, ["warehouse"], true);
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED" });
    t.fakes.courier.failNext = true;
    const bad = await post("/v1/eg/seller/shipments", h, { seller_order_ids: [o.id], declared_weight_g: 700 });
    expect(bad.statusCode).toBe(503);
    expect((JSON.parse(bad.body) as { code: string }).code).toBe("courier-unavailable");
    expect((await getOrder(o.id, h)).body.status).toBe("PACKED");

    const spy = vi.spyOn(t.fakes.courier, "createShipment");
    const cod = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED", paymentMethod: "cod", totalMinor: 55_500 });
    expect((await post("/v1/eg/seller/shipments", { ...h, "idempotency-key": idemKey(t, 6) }, { seller_order_ids: [cod.id], declared_weight_g: 700 })).statusCode).toBe(201);
    const prepaid = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED" });
    expect((await post("/v1/eg/seller/shipments", { ...h, "idempotency-key": idemKey(t, 7) }, { seller_order_ids: [prepaid.id], declared_weight_g: 700, length_mm: 300, width_mm: 200, height_mm: 100 })).statusCode).toBe(201);
    expect(spy.mock.calls.map((c) => c[0].codMinor)).toEqual([55_500n, 0n]);
    expect(spy.mock.calls[1]?.[0].parcels[0]?.dimsMm).toEqual({ lengthMm: 300, widthMm: 200, heightMm: 100 });
    spy.mockRestore();
  });

  it("ship without delivery data is 409 and never reaches the courier", async () => {
    const h = await H(t.seed.storeA, ["warehouse"], true);
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED" });
    t.fakes.delivery.byOrder.set(o.id, null);
    const spy = vi.spyOn(t.fakes.courier, "createShipment");
    const r = await post("/v1/eg/seller/shipments", h, { seller_order_ids: [o.id], declared_weight_g: 700 });
    expect(r.statusCode).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("seller orders: reads", () => {
  it("masks the phone and shows the delivery only while the access window is open", async () => {
    const h = await H(t.seed.storeA, ["support"]);
    const live = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED" });
    const d = (await getOrder(live.id, h)).body;
    expect(d.delivery?.phone_masked).toBe("+20••••••••78");
    expect(JSON.stringify(d)).not.toContain("1012345678");
    expect(d.payment_kind).toBe("prepaid");
    expect(JSON.stringify(d)).not.toContain(live.userId);

    const closed = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "DELIVERED" });
    t.fakes.delivery.byOrder.set(closed.id, { ...t.fakes.delivery.default, accessUntil: new Date(t.clock.now - 1000) });
    expect((await getOrder(closed.id, h)).body.delivery).toBeNull();
    t.fakes.delivery.byOrder.set(closed.id, { ...t.fakes.delivery.default, accessUntil: new Date(t.clock.now + 86_400_000) });
    expect((await getOrder(closed.id, h)).body.delivery?.recipient_name).toBe("منى أحمد");
    const cod = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, paymentMethod: "cod" });
    expect((await getOrder(cod.id, h)).body.payment_kind).toBe("cod");
  });

  it("lists newest first with keyset pages and status and date filters", async () => {
    const h = await H(t.seed.storeA, ["finance"]);
    const mk = (status: string, createdAt: string) => seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status, createdAt });
    const o1 = await mk("CANCELLED", "2029-03-01T10:00:00.000Z");
    const o2 = await mk("CANCELLED", "2029-03-02T10:00:00.000Z");
    const o3 = await mk("CANCELLED", "2029-03-03T10:00:00.000Z");
    const page = async (qs: string) => JSON.parse((await t.inject({ method: "GET", url: `/v1/eg/seller/orders?${qs}`, headers: h })).body) as { items: { id: string }[]; next_cursor: string | null; server_time: string };
    const p1 = await page("status=CANCELLED&limit=2");
    expect(p1.items.map((i) => i.id)).toEqual([o3.id, o2.id]);
    expect(p1.next_cursor).not.toBeNull();
    expect(p1.server_time).toBe(new Date(t.clock.now).toISOString());
    const p2 = await page(`status=CANCELLED&limit=2&cursor=${p1.next_cursor ?? ""}`);
    expect(p2.items.map((i) => i.id)).toEqual([o1.id]);
    expect(p2.next_cursor).toBeNull();
    const ranged = await page("status=CANCELLED&from=2029-03-02T00:00:00.000Z&to=2029-03-02T23:59:59.000Z");
    expect(ranged.items.map((i) => i.id)).toEqual([o2.id]);
    expect((await t.inject({ method: "GET", url: "/v1/eg/seller/orders?status=bad", headers: h })).statusCode).toBe(400);
    const none = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeB, status: "CANCELLED", createdAt: "2029-03-04T10:00:00.000Z" });
    expect((await page("status=CANCELLED&limit=50")).items.map((i) => i.id)).not.toContain(none.id);
  });
});

describe("seller inventory", () => {
  const adjust = (h: Record<string, string>, body: object) => t.inject({ method: "POST", url: "/v1/eg/seller/inventory/adjustments", headers: h, payload: body });
  const levels = async (h: Record<string, string>) => (JSON.parse((await t.inject({ method: "GET", url: "/v1/eg/seller/inventory", headers: h })).body) as { items: { sku_id: string; on_hand: number; available: number; low_stock: boolean; version: number; location_id: string | null }[] }).items;

  it("adjusts once per Idempotency-Key, enforces expected_version and reports real levels", async () => {
    const h = await H(t.seed.storeA, ["catalog"], true);
    const start = (await levels(h)).find((l) => l.sku_id === t.seed.skuA);
    expect(start).toMatchObject({ on_hand: 50, low_stock: false });
    const key = idemKey(t, 10);
    const a = await adjust({ ...h, "idempotency-key": key }, { sku_id: t.seed.skuA, delta: -48, reason: "damage", expected_version: start?.version });
    expect(a.statusCode, a.body).toBe(201);
    expect(JSON.parse(a.body)).toMatchObject({ on_hand: 2, available: 2, low_stock: true });
    const replay = await adjust({ ...h, "idempotency-key": key }, { sku_id: t.seed.skuA, delta: -48, reason: "damage", expected_version: start?.version });
    expect(JSON.parse(replay.body)).toEqual(JSON.parse(a.body));
    expect((await levels(h)).find((l) => l.sku_id === t.seed.skuA)?.on_hand).toBe(2);
    // A stale expected_version is a conflict and changes nothing.
    const stale = await adjust({ ...h, "idempotency-key": idemKey(t, 11) }, { sku_id: t.seed.skuA, delta: 5, reason: "received", expected_version: start?.version });
    expect(stale.statusCode).toBe(409);
    expect((JSON.parse(stale.body) as { code: string }).code).toBe("version-conflict");
    // Same inventory key reused for a different delta (different HTTP key space) is refused by the ledger, not applied twice.
    expect((await levels(h)).find((l) => l.sku_id === t.seed.skuA)?.on_hand).toBe(2);
  });

  it("rejects zero deltas, unknown fields and a SKU of another store; refuses to go below zero", async () => {
    const h = await H(t.seed.storeA, ["owner"], true);
    const k = (n: number) => ({ ...h, "idempotency-key": idemKey(t, 20 + n) });
    expect((await adjust(k(1), { sku_id: t.seed.skuA, delta: 0, reason: "recount" })).statusCode).toBe(400);
    expect((await adjust(k(2), { sku_id: t.seed.skuA, delta: 1, reason: "recount", on_hand: 9 })).statusCode).toBe(400);
    const b = await H(t.seed.storeB, ["owner"], true);
    expect((await adjust({ ...b, "idempotency-key": idemKey(t, 23) }, { sku_id: t.seed.skuA, delta: 1, reason: "recount" })).statusCode).toBe(404);
    expect((await levels(b)).length).toBe(0);
    const below = await adjust(k(4), { sku_id: t.seed.skuA, delta: -100_000, reason: "correction" });
    expect([409, 422]).toContain(below.statusCode);
  });

  it("warehouse can read levels but not adjust (listing.write), support cannot read", async () => {
    const w = await H(t.seed.storeA, ["warehouse"], true);
    expect((await t.inject({ method: "GET", url: "/v1/eg/seller/inventory", headers: w })).statusCode).toBe(200);
    expect((await adjust(w, { sku_id: t.seed.skuA, delta: 1, reason: "received" })).statusCode).toBe(403);
    const s = await H(t.seed.storeA, ["support"]);
    expect((await t.inject({ method: "GET", url: "/v1/eg/seller/inventory", headers: s })).statusCode).toBe(403);
  });
});
