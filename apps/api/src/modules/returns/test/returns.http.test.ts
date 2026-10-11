import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addBusinessDays } from "../domain/bridge";
import {
  DAY,
  IDEM,
  SHOPPER_1,
  STORE_A,
  TOKENS,
  U,
  START_MS,
  bearer,
  createReturnsHarness,
  line,
  type ReturnsHarness,
} from "./returns-harness";

let h: ReturnsHarness;
let seq = 0;
const key = (): string => IDEM(++seq);
const PHOTO = U(7001);
const PHOTO2 = U(7002);

const CHANGED_MIND = { qty: 1, reason: "changed_mind", resolution: "refund", method: "pickup" } as const;
const DEFECTIVE = { qty: 1, reason: "defective", resolution: "refund", method: "pickup", photo_upload_ids: [PHOTO] } as const;

const create = (token: string | null, lineId: string, body: object, k: string | null = key()) => {
  let r = h.http().post(`/v1/orders/lines/${lineId}/returns`);
  if (token !== null) r = r.set(bearer(token));
  if (k !== null) r = r.set("Idempotency-Key", k);
  return r.send(body);
};
const inspect = (token: string, id: string, body: object) =>
  h.http().post(`/v1/seller/returns/${id}/inspect`).set(bearer(token)).set("Idempotency-Key", key()).send(body);
const dispute = (token: string, id: string, body: object) =>
  h.http().post(`/v1/returns/${id}/dispute`).set(bearer(token)).set("Idempotency-Key", key()).send(body);

beforeAll(async () => {
  h = await createReturnsHarness();
}, 30_000);
afterAll(async () => {
  await h.close();
});

let n = 100;
/** A fresh delivered line per test so quantities never interact. */
function freshLine(over: Parameters<typeof line>[1] = {}) {
  n += 1;
  const l = line(n, over);
  h.lines.add(l);
  return l;
}
beforeEach(() => {
  h.clock.set(START_MS);
  h.events.events.length = 0;
});

describe("acceptance: windows count from delivered_at", () => {
  it("day 15 change of mind is refused with an Arabic and English reason", async () => {
    const l = freshLine({ deliveredAtMs: START_MS - 15 * DAY });
    const r = await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND);
    expect(r.status).toBe(422);
    expect(r.body.type).toBe("/problems/return-not-eligible");
    expect(r.body.code).toBe("window_elapsed");
    expect(r.body.reason_ar).toMatch(/[؀-ۿ]/);
    expect(typeof r.body.reason_en).toBe("string");
    expect(r.body.window_ends_at).toBe(new Date(START_MS - 15 * DAY + 14 * DAY).toISOString());
    expect(await h.repo.committedQty(l.orderLineId)).toBe(0);
  });

  it("day 29 defect with a photo is accepted", async () => {
    const l = freshLine({ deliveredAtMs: START_MS - 29 * DAY });
    const r = await create(TOKENS.shopper1, l.orderLineId, DEFECTIVE);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("RETURN_REQUESTED");
    expect(r.body.return_shipping_payer).toBe("seller");
    expect(r.body.eligibility_window_ends_at).toBe(new Date(START_MS - 29 * DAY + 30 * DAY).toISOString());
    expect(r.body.refund).toBeNull();
    expect(h.events.named("return.requested")).toHaveLength(1);
  });

  it("an undelivered line is refused", async () => {
    const l = freshLine({ deliveredAtMs: null });
    const r = await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("not_delivered");
  });

  it("defective without a photo, hygiene change of mind and unknown exchange stock are refused", async () => {
    const a = freshLine();
    expect((await create(TOKENS.shopper1, a.orderLineId, { ...DEFECTIVE, photo_upload_ids: [] })).body.code).toBe("photos_required");
    const b = freshLine({ returnClass: "hygiene" });
    expect((await create(TOKENS.shopper1, b.orderLineId, CHANGED_MIND)).body.code).toBe("non_returnable_class");
    expect((await create(TOKENS.shopper1, b.orderLineId, DEFECTIVE)).status).toBe(201);
    const c = freshLine();
    h.exchangeStock.soldOut(U(8001));
    const r = await create(TOKENS.shopper1, c.orderLineId, {
      qty: 1,
      reason: "too_small",
      resolution: "exchange",
      exchange_sku_id: U(8001),
      method: "pickup",
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("exchange_unavailable");
    expect(r.body.reason_ar).toMatch(/[؀-ۿ]/);
  });

  it("a foreign photo is refused and nothing is stored", async () => {
    const FOREIGN = U(7003);
    h.evidence.markForeign(FOREIGN);
    const l = freshLine();
    const r = await create(TOKENS.shopper1, l.orderLineId, { ...DEFECTIVE, photo_upload_ids: [FOREIGN] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("invalid_evidence");
    expect(await h.repo.committedQty(l.orderLineId)).toBe(0);
  });
});

describe("quantity and idempotency", () => {
  it("cannot return more than ordered across requests", async () => {
    const l = freshLine({ qtyOrdered: 2 });
    expect((await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND)).status).toBe(201);
    expect((await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND)).status).toBe(201);
    const third = await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND);
    expect(third.status).toBe(422);
    expect(third.body.code).toBe("qty_exceeds_returnable");
  });

  it("replays the same key and request, and 422s the same key with another body", async () => {
    const l = freshLine({ qtyOrdered: 3 });
    const k = key();
    const first = await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND, k);
    const again = await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND, k);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.id).toBe(first.body.id);
    expect(await h.repo.committedQty(l.orderLineId)).toBe(1);
    const other = await create(TOKENS.shopper1, l.orderLineId, { ...CHANGED_MIND, qty: 2 }, k);
    expect(other.status).toBe(422);
  });

  it("requires an Idempotency-Key and strict bodies", async () => {
    const l = freshLine();
    expect((await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND, null)).status).toBe(400);
    expect((await create(TOKENS.shopper1, l.orderLineId, { ...CHANGED_MIND, price: 1 })).status).toBe(400);
    expect((await create(TOKENS.shopper1, l.orderLineId, { ...CHANGED_MIND, qty: 0 })).status).toBe(400);
    expect((await create(TOKENS.shopper1, l.orderLineId, { ...CHANGED_MIND, reason: "bored" })).status).toBe(400);
    expect((await create(TOKENS.shopper1, l.orderLineId, { ...CHANGED_MIND, exchange_sku_id: U(1) })).status).toBe(400);
  });
});

describe("lifecycle: request, receive, approve, refund intent", () => {
  async function toReceived(over: Parameters<typeof line>[1] = {}, body: object = CHANGED_MIND) {
    const l = freshLine(over);
    const r = await create(TOKENS.shopper1, l.orderLineId, body);
    expect(r.status).toBe(201);
    const id = r.body.id as string;
    expect((await h.schedulePickup.execute(id)).kind).toBe("ok");
    expect((await h.pickedUp.execute(id)).kind).toBe("ok");
    const rec = await h.received.execute(id);
    expect(rec.kind).toBe("ok");
    return { id, line: l };
  }

  it("approval emits one refund intent with the integer allocation and no money execution", async () => {
    const { id } = await toReceived();
    const view = await h.http().get(`/v1/me/returns/${id}`).set(bearer(TOKENS.shopper1));
    expect(view.body.status).toBe("RETURN_RECEIVED");
    expect(view.body.inspection_due_at).toBe(new Date(START_MS + 48 * 3_600_000).toISOString());

    const ok = await inspect(TOKENS.warehouseA, id, { result: "approve" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("RETURN_INSPECTED");
    const intents = h.events.named("return.refund_intent");
    expect(intents).toHaveLength(1);
    const e = intents[0];
    expect(e?.idempotencyKey).toBe(`refund-intent:${id}`);
    // qty 1 of 2, unit 50000, voucher 5000 -> 2500, whole order not returned -> no delivery fee
    expect(e?.allocation.itemTotal).toBe("50000");
    expect(e?.allocation.voucherTotal).toBe("2500");
    expect(e?.allocation.deliveryFeeTotal).toBe("0");
    expect(e?.allocation.netTotal).toBe("47500");
    expect(e?.refundPreference).toBe("original_method");
    const stored = await h.repo.findById(id);
    expect(stored?.intentPublishedAtMs).not.toBeNull();

    expect((await h.completeRefund.execute(id)).kind).toBe("ok");
    const done = await h.http().get(`/v1/me/returns/${id}`).set(bearer(TOKENS.shopper1));
    expect(done.body.status).toBe("REFUNDED");
  });

  it("a whole-order change of mind inside 7 days gets the delivery fee share back", async () => {
    const { id } = await toReceived({ qtyOrdered: 1, discountAlloc: { amount: 3_333n, currency: "EGP" } });
    await inspect(TOKENS.ownerA, id, { result: "approve" });
    const e = h.events.named("return.refund_intent")[0];
    expect(e?.allocation.voucherTotal).toBe("3333");
    expect(e?.allocation.deliveryFeeTotal).toBe("6000");
    expect(e?.allocation.netTotal).toBe(String(50_000 - 3_333 + 6_000));
  });

  it("a defect refunds the delivery fee share even for a partial return", async () => {
    const { id } = await toReceived({}, DEFECTIVE);
    await inspect(TOKENS.ownerA, id, { result: "approve" });
    const e = h.events.named("return.refund_intent")[0];
    expect(e?.allocation.deliveryFeeTotal).toBe("3000");
    expect(e?.allocation.netTotal).toBe("50500");
    expect(e?.shippingPayer).toBe("seller");
  });

  it("a lost publish is persisted and republished by the sweeper, with the same key", async () => {
    const { id } = await toReceived();
    h.events.failNext = 2;
    await inspect(TOKENS.ownerA, id, { result: "approve" });
    expect(h.events.named("return.refund_intent")).toHaveLength(0);
    expect((await h.repo.findById(id))?.refundIntent).not.toBeNull();
    expect(await h.publishPending.run()).toBe(1);
    expect(h.events.named("return.refund_intent")[0]?.idempotencyKey).toBe(`refund-intent:${id}`);
    expect(await h.publishPending.run()).toBe(0);
  });

  it("silence for 48 hours auto-approves, and a late rejection is a 409 that keeps the approval", async () => {
    const { id } = await toReceived();
    h.clock.advance(48 * 3_600_000 - 1);
    expect(await h.autoApprove.run()).toBe(0);
    h.clock.advance(1);
    expect(await h.autoApprove.run()).toBe(1);
    expect((await h.repo.findById(id))?.inspectionResult).toBe("auto_approved");
    expect(h.events.named("return.refund_intent")).toHaveLength(1);
    const late = await inspect(TOKENS.ownerA, id, { result: "reject", rejection_reason: "used", photo_upload_ids: [PHOTO] });
    expect(late.status).toBe(409);
    expect((await h.repo.findById(id))?.state).toBe("APPROVED");
    expect(await h.autoApprove.run()).toBe(0);
  });

  it("a seller verdict after the deadline but before the sweeper approves it first", async () => {
    const { id } = await toReceived();
    h.clock.advance(49 * 3_600_000);
    const r = await inspect(TOKENS.ownerA, id, { result: "reject", rejection_reason: "used", photo_upload_ids: [PHOTO] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("inspection_window_elapsed");
    expect((await h.repo.findById(id))?.state).toBe("APPROVED");
  });

  it("rejection needs a reason and photos, then the shopper can dispute", async () => {
    const { id } = await toReceived();
    const noPhotos = await inspect(TOKENS.ownerA, id, { result: "reject", rejection_reason: "used" });
    expect(noPhotos.status).toBe(422);
    expect(noPhotos.body.code).toBe("photos_required");
    const noReason = await inspect(TOKENS.ownerA, id, { result: "reject", photo_upload_ids: [PHOTO] });
    expect(noReason.status).toBe(400);

    const rej = await inspect(TOKENS.ownerA, id, { result: "reject", rejection_reason: "used", photo_upload_ids: [PHOTO] });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe("RETURN_REJECTED");
    expect(h.events.named("return.refund_intent")).toHaveLength(0);

    const d = await dispute(TOKENS.shopper1, id, { statement: "The item was unused.", photo_upload_ids: [PHOTO2] });
    expect(d.status).toBe(201);
    expect(d.body.status).toBe("OPEN");
    expect(d.body.return_id).toBe(id);
    expect(d.body.review_due_at).toBe(new Date(addBusinessDays(START_MS, 5)).toISOString());
    const view = await h.http().get(`/v1/me/returns/${id}`).set(bearer(TOKENS.shopper1));
    expect(view.body.status).toBe("DISPUTED");

    const second = await dispute(TOKENS.shopper1, id, { statement: "again" });
    expect(second.status).toBe(409);

    // Trust and safety upholds for the shopper: approved and the intent is emitted once.
    expect((await h.resolveDispute.execute(id, "for_shopper")).kind).toBe("ok");
    expect(h.events.named("return.refund_intent")).toHaveLength(1);
    expect((await h.repo.findById(id))?.dispute?.status).toBe("RESOLVED_FOR_SHOPPER");
  });

  it("an undisputed rejection closes after the dispute window, and a late dispute is refused", async () => {
    const { id } = await toReceived();
    await inspect(TOKENS.ownerA, id, { result: "reject", rejection_reason: "missing_tags", photo_upload_ids: [PHOTO] });
    h.clock.advance(7 * DAY + 1);
    const late = await dispute(TOKENS.shopper1, id, { statement: "too late" });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe("dispute_window_elapsed");
    expect(await h.closeWindows.run()).toBe(1);
    expect((await h.repo.findById(id))?.state).toBe("CLOSED");
    // the rejection stands on the wire
    const view = await h.http().get(`/v1/me/returns/${id}`).set(bearer(TOKENS.shopper1));
    expect(view.body.status).toBe("RETURN_REJECTED");
  });

  it("an exchange approval emits an exchange intent and completes on shipment", async () => {
    const l = freshLine();
    const r = await create(TOKENS.shopper1, l.orderLineId, {
      qty: 1,
      reason: "too_small",
      resolution: "exchange",
      exchange_sku_id: U(8100),
      method: "drop_off",
    });
    expect(r.status).toBe(201);
    expect(r.body.return_shipping_payer).toBe("platform_free");
    const id = r.body.id as string;
    await h.schedulePickup.execute(id);
    await h.pickedUp.execute(id);
    await h.received.execute(id);
    await inspect(TOKENS.warehouseA, id, { result: "approve" });
    expect(h.events.named("return.exchange_intent")[0]?.exchangeSkuId).toBe(U(8100));
    expect(h.events.named("return.refund_intent")).toHaveLength(0);
    expect((await h.completeRefund.execute(id)).kind).toBe("invalid_transition");
    expect((await h.completeExchange.execute(id)).kind).toBe("ok");
    expect((await h.repo.findById(id))?.state).toBe("EXCHANGED");
  });

  it("inspecting before receipt is a 409", async () => {
    const l = freshLine();
    const r = await create(TOKENS.shopper1, l.orderLineId, CHANGED_MIND);
    const res = await inspect(TOKENS.ownerA, r.body.id as string, { result: "approve" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_transition");
  });
});

describe("serial returner policy is applied and published", () => {
  it("removes free returns for a Plus member over the threshold and notifies once", async () => {
    h.membership.grant(SHOPPER_1);
    const before = freshLine();
    expect((await create(TOKENS.shopper1, before.orderLineId, CHANGED_MIND)).body.return_shipping_payer).toBe("platform_free");
    h.history.set(SHOPPER_1, { deliveredOrders: 10, returnedOrders: 7 });
    const l1 = freshLine();
    const a = await create(TOKENS.shopper1, l1.orderLineId, CHANGED_MIND);
    expect(a.body.return_shipping_payer).toBe("shopper");
    const l2 = freshLine();
    await create(TOKENS.shopper1, l2.orderLineId, CHANGED_MIND);
    expect(h.events.named("return.serial_returner_notice")).toHaveLength(1);
    // seller-fault returns keep the seller as payer
    const l3 = freshLine();
    expect((await create(TOKENS.shopper1, l3.orderLineId, DEFECTIVE)).body.return_shipping_payer).toBe("seller");
    h.history.set(SHOPPER_1, { deliveredOrders: 0, returnedOrders: 0 });
  });
});

describe("lists", () => {
  it("paginates the shopper's returns newest first and the seller's queue by store", async () => {
    const mk = async () => {
      const l = freshLine({ userId: U(77), storeId: STORE_A });
      h.clock.advance(1000);
      h.tokens.add("token-shopper-77-0000000077", {
        actor: { id: U(77), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] },
        aud: "buyer_api",
      });
      const r = await create("token-shopper-77-0000000077", l.orderLineId, CHANGED_MIND);
      return r.body.id as string;
    };
    const ids = [await mk(), await mk(), await mk()];
    const p1 = await h.http().get("/v1/me/returns?limit=2").set(bearer("token-shopper-77-0000000077"));
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i: { id: string }) => i.id)).toEqual([ids[2], ids[1]]);
    expect(p1.body.page.has_more).toBe(true);
    const p2 = await h.http().get(`/v1/me/returns?limit=2&cursor=${encodeURIComponent(p1.body.page.next_cursor)}`).set(bearer("token-shopper-77-0000000077"));
    expect(p2.body.items.map((i: { id: string }) => i.id)).toEqual([ids[0]]);
    expect(p2.body.page).toEqual({ next_cursor: null, has_more: false });

    const bad = await h.http().get("/v1/me/returns?cursor=!!!").set(bearer(TOKENS.shopper1));
    expect(bad.status).toBe(400);

    const sellerA = await h.http().get("/v1/seller/returns?limit=50").set(bearer(TOKENS.supportA));
    expect(sellerA.status).toBe(200);
    expect(sellerA.body.items.length).toBeGreaterThan(0);
    const sellerB = await h.http().get("/v1/seller/returns").set(bearer(TOKENS.ownerB));
    expect(sellerB.status).toBe(200);
    expect(sellerB.body.items).toEqual([]);
  });
});

describe("shopper owns the line", () => {
  it("a return on another shopper's line is a 404 and writes nothing", async () => {
    const l = freshLine({ userId: SHOPPER_1 });
    const r = await create(TOKENS.shopper2, l.orderLineId, CHANGED_MIND);
    expect(r.status).toBe(404);
    expect(await h.repo.committedQty(l.orderLineId)).toBe(0);
  });
});
