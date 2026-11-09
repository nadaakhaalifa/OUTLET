import { randomUUID } from "node:crypto";
import { OrderCancellation, ORDER_GROUP_CANCELLED_EVENT } from "@outlet/checkout";
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
    provider: { voidIntent: () => Promise.resolve({ outcome: "voided" } as never) }, credit: { release: () => Promise.resolve() } as never, audit: { append: () => Promise.resolve() },
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
