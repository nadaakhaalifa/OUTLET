import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SellerOrderClosedPayload } from "@outlet/payouts";
import { OrderCloseJob, RETURN_WINDOW_DAYS, SELLER_ORDER_CLOSED_EVENT } from "../src/index.js";
import { windowEnd } from "../src/domain/cairo.js";
import { buildWorld, errCode, intentOf, paidWebhook, quoteAndPlace } from "./fixtures.js";
import type { World } from "./fixtures.js";

let w: World;
beforeAll(async () => { w = await buildWorld(); });
afterAll(async () => { await w.close(); });

const HOUR = 3_600_000;
const EG = "EG";

interface Placed { userId: string; storeId: string; groupId: string; sellerOrderId: string; net: bigint }
/** A paid single-store order, forced to DELIVERED with the given return window end (setup only). */
const delivered = async (windowEndsAt: Date | null): Promise<Placed> => {
  const storeId = w.stores[0];
  const sku = await w.seedSku(storeId, 50_000n, 3);
  const userId = await w.newUser();
  await w.fillBag(userId, [{ sku, qty: 1 }]);
  const { place } = await quoteAndPlace(w, userId, "card");
  const placed = await place();
  await w.webhooks.handle(paidWebhook(w, await intentOf(w, placed.orderGroupId), randomUUID()));
  const so = (await w.raw.query<{ id: string; seller_net_minor: string }>("SELECT id, seller_net_minor::text FROM seller_orders WHERE order_group_id = $1", [placed.orderGroupId])).rows[0];
  if (so === undefined) throw new Error("no seller order");
  await w.raw.query("UPDATE seller_orders SET status = 'DELIVERED', delivered_at = $2, return_window_ends_at = $2 WHERE id = $1", [so.id, (windowEndsAt ?? new Date(w.clock.t)).toISOString()]);
  if (windowEndsAt === null) await w.raw.query("UPDATE seller_orders SET return_window_ends_at = NULL WHERE id = $1", [so.id]);
  return { userId, storeId, groupId: placed.orderGroupId, sellerOrderId: so.id, net: BigInt(so.seller_net_minor) };
};

const status = async (id: string): Promise<{ status: string; closed_at: Date | null }> =>
  (await w.raw.query<{ status: string; closed_at: Date | null }>("SELECT status, closed_at FROM seller_orders WHERE id = $1", [id])).rows[0] ?? (() => { throw new Error("gone"); })();
const closedEvents = async (id: string) => (await w.raw.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2", [SELLER_ORDER_CLOSED_EVENT, id])).rows;

const seedReturn = async (o: Placed, retStatus: string, dispute?: string): Promise<string> => {
  const id = randomUUID();
  await w.raw.query(`SET session_replication_role = replica`);
  await w.raw.query(
    `INSERT INTO return_requests (id, seller_order_id, order_group_id, user_id, store_id, market_id, status, reason_code, fault, window_basis, delivered_at_snapshot, window_ends_at, method, resolution, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,'EG',$6,'changed_mind','none','no_reason_14d', now() - interval '20 days', now() - interval '1 day','pickup','refund',gen_random_uuid())`,
    [id, o.sellerOrderId, o.groupId, o.userId, o.storeId, retStatus],
  );
  if (dispute !== undefined) {
    await w.raw.query(
      `INSERT INTO disputes (id, return_request_id, user_id, store_id, market_id, status, reason_code, sla_due_at) VALUES (gen_random_uuid(),$1,$2,$3,'EG',$4,'other', now() + interval '3 days')`,
      [id, o.userId, o.storeId, dispute],
    );
  }
  await w.raw.query(`SET session_replication_role = origin`);
  return id;
};

const seedRefund = async (o: Placed, sellerMinor: bigint, account: "seller_pending" | "seller_available", posted: boolean): Promise<void> => {
  await w.raw.query(`SET session_replication_role = replica`);
  await w.raw.query(
    `INSERT INTO refunds (id, order_group_id, seller_order_id, user_id, store_id, market_id, reason, route, currency, amount_minor, goods_minor, commission_minor, commission_vat_minor, seller_minor, seller_account, destinations, status, journal_entry_id, idempotency_key)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,'EG','goodwill','psp_original','EGP',$5,$5,0,0,$5,$6,'[]'::jsonb,'COMPLETED',$7,$8)`,
    [o.groupId, o.sellerOrderId, o.userId, o.storeId, sellerMinor.toString(), account, posted ? randomUUID() : null, randomUUID()],
  );
  await w.raw.query(`SET session_replication_role = origin`);
};

describe("orders.close job", () => {
  it("closes exactly the due DELIVERED orders and emits seller_order.closed that payouts accepts", async () => {
    const due = await delivered(new Date(w.clock.t - HOUR));
    const exactly = await delivered(new Date(w.clock.t));
    const notYet = await delivered(new Date(w.clock.t + HOUR));
    const shipped = await delivered(new Date(w.clock.t - HOUR));
    await w.raw.query("UPDATE seller_orders SET status = 'SHIPPED' WHERE id = $1", [shipped.sellerOrderId]);
    const res = await w.closer.run();
    expect(res.closed).toEqual(expect.arrayContaining([due.sellerOrderId, exactly.sellerOrderId]));
    expect(res.closed).not.toContain(notYet.sellerOrderId);
    expect(res.closed).not.toContain(shipped.sellerOrderId);
    expect((await status(due.sellerOrderId)).status).toBe("CLOSED");
    expect((await status(due.sellerOrderId)).closed_at).not.toBeNull();
    expect((await status(notYet.sellerOrderId)).status).toBe("DELIVERED");
    expect((await status(shipped.sellerOrderId)).status).toBe("SHIPPED");
    const [ev] = await closedEvents(due.sellerOrderId);
    expect(ev?.payload).toMatchObject({ seller_order_id: due.sellerOrderId, store_id: due.storeId, market_id: EG, amount_minor: due.net.toString() });
    expect(typeof (ev?.payload as { closed_at: unknown }).closed_at).toBe("string");
    expect(SellerOrderClosedPayload.safeParse(ev?.payload).success).toBe(true);
    expect(await closedEvents(notYet.sellerOrderId)).toHaveLength(0);
  });

  it("skips orders with an active return or an OPEN / UNDER_REVIEW dispute, and closes them once those clear", async () => {
    const withReturn = await delivered(new Date(w.clock.t - HOUR));
    const withDispute = await delivered(new Date(w.clock.t - HOUR));
    const underReview = await delivered(new Date(w.clock.t - HOUR));
    const rejected = await delivered(new Date(w.clock.t - HOUR));
    const cancelled = await delivered(new Date(w.clock.t - HOUR));
    const retId = await seedReturn(withReturn, "RECEIVED");
    await seedReturn(withDispute, "DISPUTED", "OPEN");
    await seedReturn(underReview, "REJECTED", "UNDER_REVIEW");
    await seedReturn(rejected, "REJECTED");
    await seedReturn(cancelled, "CANCELLED");
    const res = await w.closer.run();
    expect(res.held).toEqual(expect.arrayContaining([withReturn.sellerOrderId, withDispute.sellerOrderId, underReview.sellerOrderId]));
    expect(res.closed).toEqual(expect.arrayContaining([rejected.sellerOrderId, cancelled.sellerOrderId]));
    for (const o of [withReturn, withDispute, underReview]) {
      expect((await status(o.sellerOrderId)).status).toBe("DELIVERED");
      expect(await closedEvents(o.sellerOrderId)).toHaveLength(0);
    }
    await w.raw.query("UPDATE return_requests SET status = 'CLOSED' WHERE id = $1", [retId]);
    expect((await w.closer.run()).closed).toContain(withReturn.sellerOrderId);
  });

  it("amount_minor subtracts only posted seller_pending refunds", async () => {
    const o = await delivered(new Date(w.clock.t - HOUR));
    await seedRefund(o, 10_000n, "seller_pending", true);
    await seedRefund(o, 3_000n, "seller_pending", false); // not posted yet
    await seedRefund(o, 2_000n, "seller_available", true); // already past pending
    await w.closer.run();
    const [ev] = await closedEvents(o.sellerOrderId);
    expect(ev?.payload).toMatchObject({ amount_minor: (o.net - 10_000n).toString() });
    expect(SellerOrderClosedPayload.safeParse(ev?.payload).success).toBe(true);
  });

  it("a re-run is idempotent: nothing closes twice, one event per order", async () => {
    const o = await delivered(new Date(w.clock.t - HOUR));
    await w.closer.run();
    const again = await w.closer.run();
    expect(again.closed).not.toContain(o.sellerOrderId);
    expect(await closedEvents(o.sellerOrderId)).toHaveLength(1);
  });

  it("a failing order is rolled back to its savepoint and does not stop the batch", async () => {
    const bad = await delivered(new Date(w.clock.t - 2 * HOUR));
    const good = await delivered(new Date(w.clock.t - HOUR));
    await seedRefund(bad, bad.net + 1n, "seller_pending", true); // refunds exceed the net: invalid
    const res = await w.closer.run();
    expect(res.failed).toContain(bad.sellerOrderId);
    expect(res.closed).toContain(good.sellerOrderId);
    expect((await status(bad.sellerOrderId)).status).toBe("DELIVERED");
    expect(await closedEvents(bad.sellerOrderId)).toHaveLength(0);
  });

  it("other worker jobs cannot see seller orders without a user (job-pinned policy)", async () => {
    const o = await delivered(new Date(w.clock.t - HOUR));
    const { withDbContext } = await import("@outlet/db");
    const other = await withDbContext(w.workerClient, { kind: "worker", marketId: EG, job: "checkout.expiry" }, async (tx) => (await tx.query("SELECT id FROM seller_orders WHERE id = $1", [o.sellerOrderId])).rows.length);
    expect(other).toBe(0);
  });
});

describe("markDelivered", () => {
  it("stamps delivered_at and the Cairo end-of-day 14-day window, and is idempotent", async () => {
    const o = await delivered(new Date(w.clock.t + HOUR));
    await w.raw.query("UPDATE seller_orders SET status = 'OUT_FOR_DELIVERY', delivered_at = NULL, return_window_ends_at = NULL WHERE id = $1", [o.sellerOrderId]);
    const at = new Date("2030-01-01T12:00:00.000Z");
    const r = await w.closer.markDelivered(o.sellerOrderId, at);
    expect(r.returnWindowEndsAt.toISOString()).toBe("2030-01-15T21:59:59.999Z"); // Cairo is UTC+2 in January
    expect(r.returnWindowEndsAt).toEqual(windowEnd(at, RETURN_WINDOW_DAYS));
    const row = (await w.raw.query<{ status: string; delivered_at: Date }>("SELECT status, delivered_at FROM seller_orders WHERE id = $1", [o.sellerOrderId])).rows[0];
    expect(row?.status).toBe("DELIVERED");
    expect(new Date(row?.delivered_at ?? 0)).toEqual(at);
    expect(await w.closer.markDelivered(o.sellerOrderId, new Date("2031-01-01T00:00:00Z"))).toEqual(r);
  });

  it("refuses an order that has not shipped and an unknown order", async () => {
    const sku = await w.seedSku(w.stores[1], 20_000n, 2);
    const u = await w.newUser();
    await w.fillBag(u, [{ sku, qty: 1 }]);
    const placed = await (await quoteAndPlace(w, u, "card")).place();
    await w.webhooks.handle(paidWebhook(w, await intentOf(w, placed.orderGroupId), randomUUID()));
    const so = (await w.raw.query<{ id: string }>("SELECT id FROM seller_orders WHERE order_group_id = $1", [placed.orderGroupId])).rows[0]?.id ?? "";
    expect(await errCode(w.closer.markDelivered(so, new Date(w.clock.t)))).not.toBe("NO_ERROR");
    expect(await errCode(w.closer.markDelivered(randomUUID(), new Date(w.clock.t)))).toBe("not-found");
  });
});

describe("OrderCloseJob wiring", () => {
  it("is exported with the event name payouts consumes", () => {
    expect(SELLER_ORDER_CLOSED_EVENT).toBe("seller_order.closed");
    expect(OrderCloseJob).toBeTypeOf("function");
  });
});
