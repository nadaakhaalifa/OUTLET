import { randomUUID } from "node:crypto";
import { OrderCancellation, ORDER_GROUP_CANCELLED_EVENT, PROMOTIONS_SETTLE_ATTENTION_EVENT } from "@outlet/checkout";
import { productionOrderCancellation, productionPromotionsPort } from "../src/modules/checkout/index.js";
import { SHIPMENT_CANCEL_REQUIRED_EVENT } from "@outlet/shipping";
import { roleClient } from "@outlet/db/testing";
import { ReservationService } from "@outlet/inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedHeaders } from "./flows.js";
import { DB_MARKET, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { paidOrder } from "./post-order-fixtures.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  const app = roleClient(t.raw, "outlet_app");
  t.post.cancellation.unconfigured = false;
  t.post.cancellation.delegate = new OrderCancellation({
    client: app, marketId: DB_MARKET, reservations: new ReservationService({ client: app, marketId: DB_MARKET }),
    provider: { voidIntent: () => Promise.resolve({ outcome: "voided" } as never) }, credit: { release: () => Promise.resolve() } as never, audit: { appendIn: () => Promise.resolve() },
  });
});
afterAll(async () => {
  t.post.cancellation.delegate = undefined;
  t.post.cancellation.unconfigured = true;
  await t.close();
});

const cancel = (o: { groupId: string; token: string }, key: string, payload: object = { reason_code: "changed_mind" }) =>
  t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, o.token, { "idempotency-key": key }), payload });

describe("POST /v1/eg/order-groups/{id}/cancel with the real OrderCancellation", () => {
  it("cancels a paid unshipped group, emits order_group.cancelled and replays idempotently", async () => {
    const o = await paidOrder(t);
    const key = idemKey(t);
    const r = await cancel(o, key);
    expect(r.statusCode, r.body).toBe(200);
    expect((await t.raw.query<{ status: string }>("SELECT status FROM seller_orders WHERE id = $1", [o.sellerOrderId])).rows[0]?.status).toBe("CANCELLED");
    expect((await t.raw.query<{ status: string }>("SELECT status FROM order_groups WHERE id = $1", [o.groupId])).rows[0]?.status).toBe("CANCELLED");
    const n = async (): Promise<number> => Number((await t.raw.query<{ c: string }>("SELECT count(*) AS c FROM outbox_events WHERE event_type = $1 AND payload->>'order_group_id' = $2", [ORDER_GROUP_CANCELLED_EVENT, o.groupId])).rows[0]?.c);
    expect(await n()).toBe(1);
    const again = await cancel(o, key);
    expect(again.statusCode).toBe(200);
    expect(await n()).toBe(1);
  });
  it("is 409 after shipping and 404 for another shopper", async () => {
    const shipped = await paidOrder(t, "SHIPPED");
    expect((await cancel(shipped, idemKey(t))).statusCode).toBe(409);
    const o = await paidOrder(t);
    const other = await paidOrder(t);
    expect((await cancel({ groupId: o.groupId, token: other.token }, idemKey(t))).statusCode).toBe(404);
  });
  it("rejects a seller principal", async () => {
    const o = await paidOrder(t);
    const r = await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, await t.mint({ userId: randomUUID() })), payload: { reason_code: "changed_mind" } });
    expect([403, 404]).toContain(r.statusCode);
  });
});

describe("M4: shipment.cancel_required", () => {
  const shipmentOf = async (o: { sellerOrderId: string; userId: string }, status = "LABEL_READY"): Promise<string> => {
    const id = randomUUID();
    await t.raw.query(
      `INSERT INTO shipments (id, market_id, store_id, user_id, seller_order_ids, courier, service_level, awb, status, declared_weight_g, idempotency_key)
       VALUES ($1,'EG',$2,$3,$4,'fake','standard',$7,$5,500,$6)`,
      [id, t.seed.storeA, o.userId, [o.sellerOrderId], status, `outbound:${o.sellerOrderId}`, `AWB-${id}`],
    );
    return id;
  };
  const events = async (groupId: string) =>
    (await t.raw.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1 AND payload->>'order_group_id' = $2", [SHIPMENT_CANCEL_REQUIRED_EVENT, groupId])).rows;

  it("is written in the cancel transaction for a PACKED order with a live shipment, once across a replay", async () => {
    const o = await paidOrder(t, "PACKED");
    const shipmentId = await shipmentOf(o);
    const key = idemKey(t);
    expect((await cancel(o, key)).statusCode).toBe(200);
    const ev = await events(o.groupId);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ shipment_id: shipmentId, seller_order_id: o.sellerOrderId });
    expect((await cancel(o, key)).statusCode).toBe(200);
    expect(await events(o.groupId)).toHaveLength(1);
  });
  it("is not written for an ACCEPTED order, nor for a PACKED order without a shipment", async () => {
    const accepted = await paidOrder(t, "ACCEPTED");
    await shipmentOf(accepted); // even a stray shipment: only PACKED orders hold an AWB by design
    expect((await cancel(accepted, idemKey(t))).statusCode).toBe(200);
    expect(await events(accepted.groupId)).toHaveLength(0);
    const packed = await paidOrder(t, "PACKED");
    expect((await cancel(packed, idemKey(t))).statusCode).toBe(200);
    expect(await events(packed.groupId)).toHaveLength(0);
  });
});

describe("composition (cli helpers): voucher reinstate and in-transaction audit", () => {
  /** A paid group carrying a platform voucher that was reserved at placement and confirmed by the settle consumer. */
  const discounted = async (): Promise<{ groupId: string; sellerOrderId: string; userId: string; token: string; promoId: string }> => {
    const o = await paidOrder(t);
    const promoId = randomUUID();
    await t.raw.query(
      `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
       VALUES ($1,'EG','platform',NULL,'fixed','عرض',$2::jsonb,'auto',10000,0,'EGP','2020-01-01T00:00:00Z','2099-01-01T00:00:00Z','ACTIVE',1)`,
      [promoId, JSON.stringify({ level: "order", discount: { kind: "fixed", amountMinor: "1000" } })],
    );
    await t.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, used_minor, used_count, currency) VALUES ($1,NULL,'EG',1000,1,'EGP')", [promoId]);
    await t.raw.query("UPDATE order_groups SET discount_minor = 1000, total_minor = total_minor - 1000 WHERE id = $1", [o.groupId]);
    const reserved = randomUUID();
    const row = `($1,$2,1,$3,'EG',$4,$5,$6,1000,1000,0,'EGP')`;
    const cols = "(id, promotion_id, promotion_version, user_id, market_id, order_group_id, kind, ref_id, amount_minor, platform_funded_minor, seller_funded_minor, currency)";
    await t.raw.query(`INSERT INTO voucher_redemptions ${cols} VALUES ${row}`, [reserved, promoId, o.userId, o.groupId, "reserved", null]);
    await t.raw.query(`INSERT INTO voucher_redemptions ${cols} VALUES ${row}`, [randomUUID(), promoId, o.userId, o.groupId, "confirmed", reserved]);
    return { ...o, promoId };
  };
  const kinds = async (groupId: string): Promise<string[]> =>
    (await t.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [groupId])).rows.map((r) => r.kind);
  const audits = async (groupId: string) =>
    (await t.raw.query<{ actor_type: string; actor_id: string; action: string }>("SELECT actor_type, actor_id, action FROM audit_log WHERE target_type = 'order_group' AND target_id = $1 ORDER BY seq", [groupId])).rows;

  let logged: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
  const compose = (): OrderCancellation => {
    const app = roleClient(t.raw, "outlet_app");
    return productionOrderCancellation({
      client: app, marketId: DB_MARKET, reservations: new ReservationService({ client: app, marketId: DB_MARKET }),
      provider: { voidIntent: () => Promise.resolve({ outcome: "voided" } as never) }, credit: { release: () => Promise.resolve() } as never,
      vouchers: productionPromotionsPort(app, DB_MARKET, { isKilled: () => Promise.resolve(false) }),
      log: { error: (msg, fields) => { logged.push({ msg, fields }); } },
    });
  };

  it("H: cancelling a whole paid unshipped discounted order through the API reinstates the voucher (no attention event, no error log)", async () => {
    logged = [];
    t.post.cancellation.delegate = compose();
    const o = await discounted();
    const r = await cancel(o, idemKey(t));
    expect(r.statusCode, r.body).toBe(200);
    expect(await kinds(o.groupId)).toEqual(["confirmed", "reinstated", "reserved"]);
    expect((await t.raw.query<{ used_minor: string; used_count: number }>("SELECT used_minor::text, used_count FROM promotion_usage WHERE promotion_id = $1", [o.promoId])).rows[0]).toEqual({ used_minor: "0", used_count: 0 });
    expect(logged).toEqual([]);
    expect((await t.raw.query("SELECT 1 FROM outbox_events WHERE event_type = $1 AND payload->>'order_group_id' = $2", [PROMOTIONS_SETTLE_ATTENTION_EVENT, o.groupId])).rows).toHaveLength(0);
    // M5: the hash-chained audit row was written by the cancel transaction itself, as the shopper
    expect(await audits(o.groupId)).toEqual([{ actor_type: "user", actor_id: o.userId, action: "order.cancel" }]);
  });

  it("M5: a seller-initiated cancel is audited as the store member, in the cancel transaction", async () => {
    const c = compose();
    const o = await paidOrder(t, "ACCEPTED");
    const member = randomUUID();
    const res = await c.cancelBySeller({ storeId: t.seed.storeA, actorId: member, sellerOrderId: o.sellerOrderId, reasonCode: "out_of_stock" });
    expect(res).toMatchObject({ groupStatus: "CANCELLED", scope: "full" });
    expect(await audits(o.groupId)).toEqual([{ actor_type: "store_member", actor_id: member, action: "order.cancel" }]);
  });
});

