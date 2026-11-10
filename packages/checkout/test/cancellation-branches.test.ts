/** Corner branches of OrderCancellation not reached by cancellation.test.ts: unknown PSP intents, unpaid discounted groups, target validation, empty lines. */
import { randomUUID } from "node:crypto";
import { uuidv7 } from "@outlet/ids";
import { PgOrderFacts } from "@outlet/promotions";
import { FakeAudit, FakeKill as PromoKill } from "@outlet/promotions/testing";
import { VoucherService } from "@outlet/promotions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CancellationRefundConsumer, OrderCancellation, PgStoreCredit, REFUND_ATTENTION_EVENT, SELLER_ORDER_REJECTED_EVENT, makePromotionsPort } from "../src/index.js";
import type { CancellationAuditPort, PaymentMethod, PromotionsPort } from "../src/index.js";
import { buildWorld, errCode, intentOf, paidWebhook } from "./fixtures.js";
import type { Sku, World } from "./fixtures.js";

let w: World;
let cancel: OrderCancellation;
let promotions: PromotionsPort;
const audit: CancellationAuditPort = { appendIn: () => Promise.resolve() };
const KEY = new Uint8Array(32).fill(9);

const addPlatformPromo = async (amountMinor: string): Promise<void> => {
  const id = randomUUID();
  await w.raw.query(
    `INSERT INTO promotions (id, market_id, owner_type, store_id, type, name_ar, rules, stacking_class, funding_platform_bp, funding_seller_bp, currency, starts_at, ends_at, status, version)
     VALUES ($1,'EG','platform',NULL,'fixed','عرض',$2::jsonb,'auto',10000,0,'EGP','2029-12-01T00:00:00Z','2031-01-01T00:00:00Z','ACTIVE',1)`,
    [id, JSON.stringify({ level: "order", discount: { kind: "fixed", amountMinor } })],
  );
  await w.raw.query("INSERT INTO promotion_usage (promotion_id, store_id, market_id, currency) VALUES ($1,NULL,'EG','EGP')", [id]);
};
const place = async (userId: string, items: readonly { sku: Sku; qty: number }[], method: PaymentMethod, opts: { promo?: boolean; pay?: boolean } = {}): Promise<string> => {
  await w.fillBag(userId, items);
  const svc = opts.promo === true ? w.makeSvc({}, { promotions }) : w.svc;
  const q = await svc.quote(userId, { addressRef: "01900000-0000-7000-8000-0000000000ad", method });
  const placed = await svc.place(userId, { addressRef: "01900000-0000-7000-8000-0000000000ad", method, idempotencyKey: uuidv7(), quoteToken: q.token, quote: q.quote });
  if (opts.pay === true) {
    const workers = opts.promo === true ? w.makeWorkers({ promotions }) : { webhooks: w.webhooks };
    await workers.webhooks.handle(paidWebhook(w, await intentOf(w, placed.orderGroupId), randomUUID()));
  }
  return placed.orderGroupId;
};
const sellerOrders = async (g: string): Promise<string[]> => (await w.raw.query<{ id: string }>("SELECT id FROM seller_orders WHERE order_group_id = $1 ORDER BY id", [g])).rows.map((r) => r.id);
const voucherKinds = async (g: string): Promise<string[]> => (await w.raw.query<{ kind: string }>("SELECT kind FROM voucher_redemptions WHERE order_group_id = $1 ORDER BY kind", [g])).rows.map((r) => r.kind);
const releaseEvents = async (g: string): Promise<{ lines: { sku_id: string; qty: number }[] }[]> =>
  (await w.raw.query<{ payload: { lines: { sku_id: string; qty: number }[] } }>("SELECT payload FROM outbox_events WHERE event_type = 'inventory.release_required' AND payload->>'order_group_id' = $1", [g])).rows.map((r) => r.payload);

beforeAll(async () => {
  w = await buildWorld();
  const pdeps = { client: w.app, marketId: "EG", kill: new PromoKill(), audit: new FakeAudit(), hmacKey: KEY, now: w.now, velocityPerHour: 1000, orderFacts: PgOrderFacts.forWorker(w.workerClient, "EG") };
  promotions = makePromotionsPort(pdeps);
  cancel = new OrderCancellation({ client: w.app, marketId: "EG", reservations: w.reservations, provider: w.fakes.provider, credit: new PgStoreCredit("EGP"), audit, vouchers: new VoucherService(pdeps), now: w.now });
});
afterAll(async () => { await w.close(); });
beforeEach(async () => {
  w.fakes.risk.decision = "allow";
  w.fakes.provider.nextVoid = "voided";
  await w.raw.query("UPDATE promotions SET status = 'ENDED'");
});

describe("unpaid group", () => {
  it("a PSP that never saw a CREATED intent is not a reason to refuse: the cancel proceeds", async () => {
    const sku = await w.seedSku(w.stores[0], 30_000n, 3);
    const u = await w.newUser();
    const g = await place(u, [{ sku, qty: 1 }], "card");
    await w.raw.query("UPDATE payment_intents SET status = 'CREATED' WHERE order_group_id = $1", [g]);
    w.fakes.provider.nextVoid = "not_found";
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" })).toMatchObject({ groupStatus: "CANCELLED", scope: "full", refundExpected: false });
    expect((await w.raw.query<{ status: string }>("SELECT status FROM payment_intents WHERE order_group_id = $1", [g])).rows[0]?.status).toBe("CANCELLED");
  });

  it("a discounted unpaid group releases its voucher (not reinstates) and a replay reports the same action", async () => {
    await addPlatformPromo("3000");
    const sku = await w.seedSku(w.stores[1], 40_000n, 3);
    const u = await w.newUser();
    const g = await place(u, [{ sku, qty: 1 }], "card", { promo: true });
    expect(await voucherKinds(g)).toEqual(["reserved"]);
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).toMatchObject({ vouchers: "released", replayed: false });
    expect(await voucherKinds(g)).toEqual(["released", "reserved"]);
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" })).toMatchObject({ vouchers: "released", replayed: true });
    // a different reason on an already-cancelled group is refused
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" }))).toBe("order-not-cancellable");
  });

  it("is cancelled as a whole by the shopper: a seller, or a subset of the seller orders, is refused and nothing changes", async () => {
    const [sa, sb] = [w.seedSku(w.stores[0], 20_000n, 3), w.seedSku(w.stores[1], 20_000n, 3)];
    const u = await w.newUser();
    const g = await place(u, [{ sku: await sa, qty: 1 }, { sku: await sb, qty: 1 }], "card");
    const [one] = await sellerOrders(g);
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other", sellerOrderIds: [one ?? ""] }))).toBe("order-not-cancellable");
    const so = (await w.raw.query<{ store_id: string; id: string }>("SELECT store_id, id FROM seller_orders WHERE order_group_id = $1 LIMIT 1", [g])).rows[0];
    await expect(cancel.cancelBySeller({ storeId: so?.store_id ?? "", actorId: "m1", sellerOrderId: so?.id ?? "", reasonCode: "out_of_stock" })).rejects.toMatchObject({ code: "order-not-cancellable" });
    expect((await w.raw.query<{ status: string }>("SELECT status FROM order_groups WHERE id = $1", [g])).rows[0]?.status).toBe("PENDING_PAYMENT");
    // the full explicit set is the same as the whole group
    expect(await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other", sellerOrderIds: await sellerOrders(g) })).toMatchObject({ scope: "full", groupStatus: "CANCELLED" });
  });

  it("skips seller orders already voided and tolerates a group without a reservation", async () => {
    const [sa, sb] = [await w.seedSku(w.stores[0], 20_000n, 3), await w.seedSku(w.stores[1], 20_000n, 3)];
    const u = await w.newUser();
    const g = await place(u, [{ sku: sa, qty: 1 }, { sku: sb, qty: 1 }], "card");
    const [first] = await sellerOrders(g);
    await w.raw.query("UPDATE seller_orders SET status = 'VOIDED' WHERE id = $1", [first]);
    await w.raw.query("UPDATE order_groups SET reservation_id = NULL WHERE id = $1", [g]);
    const res = await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other" });
    expect(res).toMatchObject({ groupStatus: "CANCELLED", scope: "full" });
    const statuses = (await w.raw.query<{ id: string; status: string }>("SELECT id, status FROM seller_orders WHERE order_group_id = $1", [g])).rows;
    expect(statuses.find((s) => s.id !== first)?.status).toBe("VOIDED");
  });
});

describe("paid group", () => {
  it("an unknown seller order id is not found and changes nothing", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n, 3);
    const u = await w.newUser();
    const g = await place(u, [{ sku, qty: 1 }], "card", { pay: true });
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "other", sellerOrderIds: [randomUUID()] }))).toBe("not-found");
    expect((await w.raw.query<{ status: string }>("SELECT status FROM order_groups WHERE id = $1", [g])).rows[0]?.status).toBe("PAID");
  });

  it("when every seller order was already rejected there is nothing left to cancel", async () => {
    const sku = await w.seedSku(w.stores[0], 20_000n, 3);
    const u = await w.newUser();
    const g = await place(u, [{ sku, qty: 1 }], "card", { pay: true });
    await w.raw.query("UPDATE seller_orders SET status = 'REJECTED_BY_SELLER', cancel_reason = 'seller_rejected' WHERE order_group_id = $1", [g]);
    expect(await errCode(cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" }))).toBe("order-not-cancellable");
  });

  it("sorts released lines by sku and emits no stock event for a seller order whose lines are already inactive", async () => {
    const store = w.stores[2];
    const [x, y] = [await w.seedSku(store, 20_000n, 3), await w.seedSku(store, 25_000n, 3)];
    const u = await w.newUser();
    const g = await place(u, [{ sku: x, qty: 1 }, { sku: y, qty: 2 }], "card", { pay: true });
    await cancel.execute({ userId: u, orderGroupId: g, reasonCode: "changed_mind" });
    const ev = await releaseEvents(g);
    expect(ev).toHaveLength(1);
    const skuIds = ev[0]?.lines.map((l) => l.sku_id) ?? [];
    expect(skuIds).toHaveLength(2);
    expect(skuIds).toEqual([...skuIds].sort());

    const z = await w.seedSku(w.stores[0], 10_000n, 3);
    const u2 = await w.newUser();
    const g2 = await place(u2, [{ sku: z, qty: 1 }], "card", { pay: true });
    await w.raw.query("UPDATE order_lines SET status = 'cancelled' WHERE order_group_id = $1", [g2]);
    expect(await cancel.execute({ userId: u2, orderGroupId: g2, reasonCode: "changed_mind" })).toMatchObject({ groupStatus: "CANCELLED" });
    expect(await releaseEvents(g2)).toEqual([]);
  });
});

describe("CancellationRefundConsumer corner paths", () => {
  const GROUP = "018f0000-0000-7000-8000-0000000000a1";
  const USER = "018f0000-0000-7000-8000-0000000000a2";
  const attention = async (eventId: string): Promise<{ payload: Record<string, unknown> }[]> =>
    (await w.raw.query<{ payload: Record<string, unknown> }>("SELECT payload FROM outbox_events WHERE event_type = $1 AND payload->>'source_event_id' = $2", [REFUND_ATTENTION_EVENT, eventId])).rows;

  it("an event type it does not own is processed with no refund call and no attention event", async () => {
    const calls: unknown[] = [];
    const c = new CancellationRefundConsumer(w.workerClient, "EG", { createForCancellation: (i) => { calls.push(i); return Promise.resolve([]); } });
    const id = uuidv7();
    expect(await c.handle({ id, type: "something.else", payload: { order_group_id: GROUP, user_id: USER } })).toBe("processed");
    expect(calls).toEqual([]);
    expect(await attention(id)).toEqual([]);
    expect(await c.handle({ id, type: "something.else", payload: {} })).toBe("duplicate");
  });

  it("a seller rejection is refunded with reason seller_rejected", async () => {
    const calls: { reason: string }[] = [];
    const c = new CancellationRefundConsumer(w.workerClient, "EG", { createForCancellation: (i) => { calls.push(i); return Promise.resolve([]); } });
    expect(await c.handle({ id: uuidv7(), type: SELLER_ORDER_REJECTED_EVENT, payload: { order_group_id: GROUP, user_id: USER } })).toBe("processed");
    expect(calls.map((x) => x.reason)).toEqual(["seller_rejected"]);
  });

  it("a refusal without a code is parked under the error name, with the real clock and default ids", async () => {
    const refuse = Object.assign(new Error("inconsistent"), { name: "ReturnsError" });
    const c = new CancellationRefundConsumer(w.workerClient, "EG", { createForCancellation: () => Promise.reject(refuse) });
    const id = uuidv7();
    expect(await c.handle({ id, type: "seller_order.cancelled", payload: { order_group_id: GROUP, user_id: USER } })).toBe("processed");
    const rows = await attention(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ order_group_id: GROUP, error: "ReturnsError", source_event_id: id });
  });

  it("a delivery that lost the race for the inbox row reports duplicate and emits nothing", async () => {
    const id = uuidv7();
    const refuse = Object.assign(new Error("x"), { name: "ReturnsError" });
    const c = new CancellationRefundConsumer(w.workerClient, "EG", {
      createForCancellation: async () => {
        await w.raw.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ('checkout.cancellation_refund', $1)", [id]);
        throw refuse;
      },
    });
    expect(await c.handle({ id, type: "seller_order.cancelled", payload: { order_group_id: GROUP, user_id: USER } })).toBe("duplicate");
    expect(await attention(id)).toEqual([]);
  });
});
