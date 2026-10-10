import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createOrdersHarness, sellerActor, shopperActor, type OrdersHarness } from "./harness";
import {
  GROUP_1,
  ORDER_A,
  ORDER_B,
  SHOPPER_A,
  SHOPPER_B,
  STORE_A,
  STORE_B,
  T0,
  U,
} from "./fixtures";

const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const MISSING = U(0xdead);

const T = {
  ownerA: "token-owner-store-a-0001",
  warehouseA: "token-warehouse-store-a-01",
  supportA: "token-support-store-a-0001",
  financeA: "token-finance-store-a-0001",
  noScopeA: "token-owner-a-no-scope-001",
  ownerB: "token-owner-store-b-0001",
  suspendedA: "token-suspended-store-a-01",
  shopperOnSellerAud: "token-shopper-seller-aud-1",
  buyerAudOwnerA: "token-buyer-aud-owner-a-1",
  shopperA: "token-shopper-a-000000001",
  shopperB: "token-shopper-b-000000001",
  sellerAudOnBuyerRoute: "token-seller-on-buyer-rt-1",
};

let h: OrdersHarness;
let key = 1000;
const next = (): string => IDEM(key++);

beforeEach(async () => {
  if (h !== undefined) await h.close();
  h = await createOrdersHarness();
  h.tokens.add(T.ownerA, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "seller_api" });
  h.tokens.add(T.warehouseA, { actor: sellerActor(U(22), STORE_A, "warehouse"), aud: "seller_api" });
  h.tokens.add(T.supportA, { actor: sellerActor(U(23), STORE_A, "support"), aud: "seller_api" });
  h.tokens.add(T.financeA, { actor: sellerActor(U(24), STORE_A, "finance"), aud: "seller_api" });
  h.tokens.add(T.noScopeA, { actor: sellerActor(U(25), STORE_A, "owner", { tokenScopes: ["seller:read"] }), aud: "seller_api" });
  h.tokens.add(T.ownerB, { actor: sellerActor(U(26), STORE_B, "owner"), aud: "seller_api" });
  h.tokens.add(T.suspendedA, { actor: sellerActor(U(27), STORE_A, "owner", { status: "suspended" }), aud: "seller_api" });
  h.tokens.add(T.shopperOnSellerAud, { actor: shopperActor(U(28)), aud: "seller_api" });
  h.tokens.add(T.buyerAudOwnerA, { actor: sellerActor(U(21), STORE_A, "owner"), aud: "buyer_api" });
  h.tokens.add(T.shopperA, { actor: shopperActor(SHOPPER_A), aud: "buyer_api" });
  h.tokens.add(T.shopperB, { actor: shopperActor(SHOPPER_B), aud: "buyer_api" });
  h.tokens.add(T.sellerAudOnBuyerRoute, { actor: shopperActor(SHOPPER_A), aud: "seller_api" });
  h.stores.add({ id: STORE_A, slug: "store-a", name: { ar: "متجر أ", en: "Store A" }, kind: "local", verifiedBadge: true });
  h.stores.add({ id: STORE_B, slug: "store-b", name: { ar: "متجر ب" }, kind: "global", verifiedBadge: false });
  await h.kit.intake.placeOrder({
    groupId: GROUP_1,
    userId: SHOPPER_A,
    paidAtMs: T0,
    stores: [
      { sellerOrderId: ORDER_A, storeId: STORE_A, lines: 2 },
      { sellerOrderId: ORDER_B, storeId: STORE_B },
    ],
  });
});
afterAll(async () => {
  if (h !== undefined) await h.close();
});

const status = async (id: string) => (await h.repo.getSellerOrder(id, { kind: "system" }))?.status;
const eventTypes = () => h.repo.outbox.map((e) => e.type);

const post = (path: string, token: string | null, k: string | null, body?: object) => {
  let r = h.http().post(path);
  if (token !== null) r = r.set(bearer(token));
  if (k !== null) r = r.set("Idempotency-Key", k);
  return r.send(body ?? {});
};
const get = (path: string, token: string | null, extra: Record<string, string> = {}) => {
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
  return r;
};

describe("GET /v1/seller/orders", () => {
  it("lists only the caller's store and paginates", async () => {
    const a = await get("/v1/seller/orders", T.ownerA);
    expect(a.status).toBe(200);
    expect(a.body.items.map((o: { id: string }) => o.id)).toEqual([ORDER_A]);
    expect(a.body.page).toEqual({ next_cursor: null, has_more: false });
    const b = await get("/v1/seller/orders", T.ownerB);
    expect(b.body.items.map((o: { id: string }) => o.id)).toEqual([ORDER_B]);
  });

  it("filters by status and rejects a bad status or cursor with 400", async () => {
    expect((await get("/v1/seller/orders?status=ACCEPTED", T.ownerA)).body.items).toEqual([]);
    expect((await get("/v1/seller/orders?status=PAID", T.ownerA)).body.items).toHaveLength(1);
    expect((await get("/v1/seller/orders?status=bogus", T.ownerA)).status).toBe(400);
    expect((await get("/v1/seller/orders?cursor=%%%", T.ownerA)).status).toBe(400);
    expect((await get("/v1/seller/orders?limit=0", T.ownerA)).status).toBe(400);
  });

  it("negative authorization", async () => {
    expect((await get("/v1/seller/orders", null)).status).toBe(401);
    expect((await get("/v1/seller/orders", T.buyerAudOwnerA)).status).toBe(401);
    expect((await get("/v1/seller/orders", T.shopperOnSellerAud)).status).toBe(403);
    expect((await get("/v1/seller/orders", T.suspendedA)).status).toBe(403);
  });

  it("support and finance may read", async () => {
    expect((await get("/v1/seller/orders", T.supportA)).status).toBe(200);
    expect((await get("/v1/seller/orders", T.financeA)).status).toBe(200);
  });
});

describe("GET /v1/seller/orders/{id}", () => {
  it("masks buyer data until acceptance and exposes only relay and first name afterwards", async () => {
    const before = await get(`/v1/seller/orders/${ORDER_A}`, T.ownerA);
    expect(before.status).toBe(200);
    expect(before.body.buyer).toEqual({ governorate_code: "EG-C", address_visible: false });
    expect(JSON.stringify(before.body)).not.toContain("Mona");
    expect(before.body.accept_by).toBe(new Date(T0 + 86_400_000).toISOString());
    expect(before.body.commission).toEqual({ amount: "11250", currency: "EGP" }); // 15% of 75000 (1x250 + 2x250 EGP lines)

    await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    const after = await get(`/v1/seller/orders/${ORDER_A}`, T.ownerA);
    expect(after.body.buyer).toEqual({
      governorate_code: "EG-C",
      first_name: "Mona",
      phone_relay: "+20100000099",
      address_visible: true,
    });
    expect(after.body).not.toHaveProperty("phone");
    expect(after.body).not.toHaveProperty("address");
  });

  it("another store's order is 404 and byte-identical to a missing one", async () => {
    const foreign = await get(`/v1/seller/orders/${ORDER_B}`, T.ownerA);
    const missing = await get(`/v1/seller/orders/${MISSING}`, T.ownerA);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual({ ...missing.body, request_id: foreign.body.request_id });
    expect((await get("/v1/seller/orders/not-a-uuid", T.ownerA)).status).toBe(404);
  });

  it("supports If-None-Match", async () => {
    const first = await get(`/v1/seller/orders/${ORDER_A}`, T.ownerA);
    const etag = first.headers["etag"];
    expect(typeof etag).toBe("string");
    const again = await get(`/v1/seller/orders/${ORDER_A}`, T.ownerA, { "If-None-Match": String(etag) });
    expect(again.status).toBe(304);
  });

  it("negative authorization", async () => {
    expect((await get(`/v1/seller/orders/${ORDER_A}`, null)).status).toBe(401);
    expect((await get(`/v1/seller/orders/${ORDER_A}`, T.buyerAudOwnerA)).status).toBe(401);
    expect((await get(`/v1/seller/orders/${ORDER_A}`, T.shopperOnSellerAud)).status).toBe(403);
  });
});

describe("POST /v1/seller/orders/{id}/accept", () => {
  it("accepts, is idempotent per key and emits exactly one event", async () => {
    const k = next();
    const res = await post(`/v1/seller/orders/${ORDER_A}/accept`, T.warehouseA, k);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACCEPTED");
    expect(res.body.dispatch_by).toBe(new Date(T0 + 172_800_000).toISOString());
    const again = await post(`/v1/seller/orders/${ORDER_A}/accept`, T.warehouseA, k);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect(eventTypes().filter((t) => t === "seller_order.accepted")).toHaveLength(1);
    expect(await status(ORDER_A)).toBe("ACCEPTED");
  });

  it("a second accept with a new key is 409 invalid_transition", async () => {
    await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    const res = await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_transition");
  });

  it("after the SLA the answer is 409 accept_window_elapsed and the sweep cancels", async () => {
    h.clock.advance(86_400_000);
    const res = await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("accept_window_elapsed");
    const swept = await h.kit.commands.expireUnaccepted();
    expect(swept.cancelled).toBe(2);
    expect(await status(ORDER_A)).toBe("CANCELLED");
  });

  it("requires an Idempotency-Key", async () => {
    expect((await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, null)).status).toBe(400);
    expect(await status(ORDER_A)).toBe("PAID");
  });

  it("negative authorization: no side effect on any denial", async () => {
    const path = `/v1/seller/orders/${ORDER_A}/accept`;
    expect((await post(path, null, next())).status).toBe(401);
    expect((await post(path, T.buyerAudOwnerA, next())).status).toBe(401);
    expect((await post(path, T.shopperOnSellerAud, next())).status).toBe(403);
    expect((await post(path, T.supportA, next())).status).toBe(403);
    expect((await post(path, T.financeA, next())).status).toBe(403);
    expect((await post(path, T.noScopeA, next())).status).toBe(403);
    expect((await post(path, T.suspendedA, next())).status).toBe(403);
    const foreign = await post(path, T.ownerB, next());
    const missing = await post(`/v1/seller/orders/${MISSING}/accept`, T.ownerB, next());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ ...missing.body, request_id: foreign.body.request_id });
    expect(await status(ORDER_A)).toBe("PAID");
    expect(eventTypes().filter((t) => t !== "seller_order.placed")).toEqual([]);
  });
});

describe("POST /v1/seller/orders/{id}/pack", () => {
  it("requires acceptance first, then packs", async () => {
    const path = `/v1/seller/orders/${ORDER_A}/pack`;
    const early = await post(path, T.ownerA, next());
    expect(early.status).toBe(409);
    expect(early.body.code).toBe("invalid_transition");
    await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    const ok = await post(path, T.ownerA, next());
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("PACKED");
  });

  it("negative authorization", async () => {
    await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    const path = `/v1/seller/orders/${ORDER_A}/pack`;
    expect((await post(path, null, next())).status).toBe(401);
    expect((await post(path, T.supportA, next())).status).toBe(403);
    expect((await post(path, T.ownerB, next())).status).toBe(404);
    expect(await status(ORDER_A)).toBe("ACCEPTED");
  });
});

describe("POST /v1/seller/orders/{id}/reject", () => {
  it("rejects with a reason, emits the saga event and never touches money", async () => {
    const res = await post(`/v1/seller/orders/${ORDER_A}/reject`, T.ownerA, next(), { reason: "out_of_stock", note: "sold in store" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REJECTED_BY_SELLER");
    const ev = h.repo.outbox.find((e) => e.type === "seller_order.rejected");
    expect(ev?.payload).toMatchObject({ reason: "out_of_stock", refund_required: true, payment_type: "prepaid" });
    // no buyer PII and no free text in events
    expect(JSON.stringify(ev)).not.toContain("Mona");
    expect(JSON.stringify(ev)).not.toContain("sold in store");
    expect(await status(ORDER_B)).toBe("PAID");
  });

  it("validates the body strictly", async () => {
    const path = `/v1/seller/orders/${ORDER_A}/reject`;
    expect((await post(path, T.ownerA, next(), {})).status).toBe(400);
    expect((await post(path, T.ownerA, next(), { reason: "bored" })).status).toBe(400);
    expect((await post(path, T.ownerA, next(), { reason: "other", extra: 1 })).status).toBe(400);
    expect((await post(path, T.ownerA, next(), { reason: "other", note: "x".repeat(501) })).status).toBe(400);
  });

  it("negative authorization", async () => {
    const path = `/v1/seller/orders/${ORDER_A}/reject`;
    const body = { reason: "other" };
    expect((await post(path, null, next(), body)).status).toBe(401);
    expect((await post(path, T.supportA, next(), body)).status).toBe(403);
    expect((await post(path, T.ownerB, next(), body)).status).toBe(404);
    expect(await status(ORDER_A)).toBe("PAID");
  });

  it("cannot reject after packing", async () => {
    await post(`/v1/seller/orders/${ORDER_A}/accept`, T.ownerA, next());
    await post(`/v1/seller/orders/${ORDER_A}/pack`, T.ownerA, next());
    const res = await post(`/v1/seller/orders/${ORDER_A}/reject`, T.ownerA, next(), { reason: "other" });
    expect(res.status).toBe(409);
  });
});

describe("GET /v1/order-groups/{id}", () => {
  it("returns the group with its seller orders to the owner", async () => {
    const res = await get(`/v1/order-groups/${GROUP_1}`, T.shopperA);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(res.body.payment_method).toBe("card");
    expect(res.body.seller_orders).toHaveLength(2);
    expect(res.body.seller_orders[0].store.slug).toBe("store-a");
    expect(res.body.seller_orders[0].cancellable).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("Mona");
    expect(JSON.stringify(res.body)).not.toContain("+20100000099");
    expect(res.headers["etag"]).toBeDefined();
  });

  it("negative authorization", async () => {
    const foreign = await get(`/v1/order-groups/${GROUP_1}`, T.shopperB);
    const missing = await get(`/v1/order-groups/${MISSING}`, T.shopperB);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ ...missing.body, request_id: foreign.body.request_id });
    expect((await get(`/v1/order-groups/${GROUP_1}`, null)).status).toBe(401);
    expect((await get(`/v1/order-groups/${GROUP_1}`, T.sellerAudOnBuyerRoute)).status).toBe(401);
    expect((await get(`/v1/order-groups/${GROUP_1}`, T.ownerA)).status).toBe(401);
    expect((await get("/v1/order-groups/not-a-uuid", T.shopperA)).status).toBe(404);
  });
});

describe("POST /v1/seller-orders/{id}/cancel", () => {
  const path = `/v1/seller-orders/${ORDER_A}/cancel`;

  it("cancels before shipping, idempotently, and emits one cancelled event", async () => {
    const k = next();
    const res = await post(path, T.shopperA, k, { reason: "changed_mind" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
    expect(res.body.cancellable).toBe(false);
    const again = await post(path, T.shopperA, k, { reason: "changed_mind" });
    expect(again.body).toEqual(res.body);
    expect(eventTypes().filter((t) => t === "seller_order.cancelled")).toHaveLength(1);
    expect(await status(ORDER_B)).toBe("PAID");
  });

  it("cannot cancel once shipped", async () => {
    h.repo.setStatusForTest(ORDER_A, "SHIPPED");
    const res = await post(path, T.shopperA, next(), { reason: "other" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_cancellable");
  });

  it("validates the body and requires a key", async () => {
    expect((await post(path, T.shopperA, next(), { reason: "bad" })).status).toBe(400);
    expect((await post(path, T.shopperA, null, { reason: "other" })).status).toBe(400);
    expect(await status(ORDER_A)).toBe("PAID");
  });

  it("negative authorization", async () => {
    const body = { reason: "other" };
    expect((await post(path, null, next(), body)).status).toBe(401);
    expect((await post(path, T.sellerAudOnBuyerRoute, next(), body)).status).toBe(401);
    expect((await post(path, T.ownerA, next(), body)).status).toBe(401);
    const foreign = await post(path, T.shopperB, next(), body);
    const missing = await post(`/v1/seller-orders/${MISSING}/cancel`, T.shopperB, next(), body);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ ...missing.body, request_id: foreign.body.request_id });
    expect(await status(ORDER_A)).toBe("PAID");
  });
});
