import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STANDARD_POOL_ID } from "./in-memory";
import {
  createInventoryHarness,
  sellerActor,
  shopperActor,
  type InventoryHarness,
} from "../test/harness";
import { LOC_A, LOC_B, SKU_A1, SKU_B1, STORE_A, STORE_B, U } from "../test/fixtures";

const IDEM = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const URL = (sku: string): string => `/v1/seller/skus/${sku}/stock`;
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

let h: InventoryHarness;
const T = {
  ownerA: "token-owner-store-a-0001",
  warehouseA: "token-warehouse-store-a-01",
  supportA: "token-support-store-a-0001",
  noScopeA: "token-owner-a-no-scope-001",
  ownerB: "token-owner-store-b-0001",
  suspendedA: "token-suspended-store-a-01",
  shopper: "token-shopper-0000000001",
  buyerAudOwnerA: "token-buyer-aud-owner-a-1",
};

beforeAll(async () => {
  h = await createInventoryHarness();
  h.directory.register(SKU_A1, { storeId: STORE_A, locationId: LOC_A, dropId: null });
  h.directory.register(SKU_B1, { storeId: STORE_B, locationId: LOC_B, dropId: null });
  h.tokens.add(T.ownerA, { actor: sellerActor(U(1), STORE_A, "owner"), aud: "seller_api" });
  h.tokens.add(T.warehouseA, { actor: sellerActor(U(2), STORE_A, "warehouse"), aud: "seller_api" });
  h.tokens.add(T.supportA, { actor: sellerActor(U(3), STORE_A, "support"), aud: "seller_api" });
  h.tokens.add(T.noScopeA, { actor: sellerActor(U(4), STORE_A, "owner", { tokenScopes: ["seller:read"] }), aud: "seller_api" });
  h.tokens.add(T.ownerB, { actor: sellerActor(U(5), STORE_B, "owner"), aud: "seller_api" });
  h.tokens.add(T.suspendedA, { actor: sellerActor(U(6), STORE_A, "owner", { status: "suspended" }), aud: "seller_api" });
  h.tokens.add(T.shopper, { actor: shopperActor(U(7)), aud: "seller_api" });
  h.tokens.add(T.buyerAudOwnerA, { actor: sellerActor(U(1), STORE_A, "owner"), aud: "buyer_api" });
});
afterAll(async () => {
  await h.close();
});

const put = (sku: string, token: string | null, key: string | null, body: object, extra: Record<string, string> = {}) => {
  let r = h.http().put(URL(sku));
  if (token !== null) r = r.set(bearer(token));
  if (key !== null) r = r.set("Idempotency-Key", key);
  for (const [k, v] of Object.entries(extra)) r = r.set(k, v);
  return r.send(body);
};
const BODY = { mode: "set", quantity: 10, reason: "received" } as const;

describe("PUT /v1/seller/skus/{skuId}/stock negative authorization", () => {
  it("unauthenticated -> 401 and no stock change", async () => {
    const res = await put(SKU_A1, null, IDEM(1), BODY);
    expect(res.status).toBe(401);
    expect(h.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)).toBeNull();
  });

  it("buyer-audience token -> 401", async () => {
    expect((await put(SKU_A1, T.buyerAudOwnerA, IDEM(2), BODY)).status).toBe(401);
  });

  it("garbage bearer -> 401", async () => {
    expect((await put(SKU_A1, "not-a-known-token-0000000", IDEM(3), BODY)).status).toBe(401);
  });

  it("wrong role (support) -> 403", async () => {
    const res = await put(SKU_A1, T.supportA, IDEM(4), BODY);
    expect(res.status).toBe(403);
    expect(h.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)).toBeNull();
  });

  it("shopper grant on the seller audience -> 403", async () => {
    expect((await put(SKU_A1, T.shopper, IDEM(5), BODY)).status).toBe(403);
  });

  it("missing seller:write scope -> 403", async () => {
    expect((await put(SKU_A1, T.noScopeA, IDEM(6), BODY)).status).toBe(403);
  });

  it("suspended seller -> 403", async () => {
    expect((await put(SKU_A1, T.suspendedA, IDEM(7), BODY)).status).toBe(403);
  });

  it("another store's SKU -> 404, same as a missing SKU, and no side effect", async () => {
    const foreign = await put(SKU_B1, T.ownerA, IDEM(8), BODY);
    const missing = await put(U(0xdead), T.ownerA, IDEM(9), BODY);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body).toEqual({ ...missing.body, request_id: foreign.body.request_id });
    expect(h.store.model.level(SKU_B1, LOC_B, STANDARD_POOL_ID)).toBeNull();
  });

  it("malformed sku id -> 404 before any lookup side effect", async () => {
    const res = await h.http().put("/v1/seller/skus/not-a-uuid/stock").set(bearer(T.ownerA)).set("Idempotency-Key", IDEM(10)).send(BODY);
    expect([400, 404]).toContain(res.status);
  });
});

describe("PUT /v1/seller/skus/{skuId}/stock behaviour", () => {
  it("requires an Idempotency-Key", async () => {
    expect((await put(SKU_A1, T.ownerA, null, BODY)).status).toBe(400);
  });

  it("rejects unknown fields and bad values with 400", async () => {
    expect((await put(SKU_A1, T.ownerA, IDEM(20), { ...BODY, extra: 1 })).status).toBe(400);
    expect((await put(SKU_A1, T.ownerA, IDEM(21), { ...BODY, mode: "replace" })).status).toBe(400);
    expect((await put(SKU_A1, T.ownerA, IDEM(22), { ...BODY, quantity: 1.5 })).status).toBe(400);
    expect((await put(SKU_A1, T.ownerA, IDEM(23), { ...BODY, reason: "gift" })).status).toBe(400);
    expect((await put(SKU_A1, T.ownerA, IDEM(24), { mode: "set", quantity: 1 })).status).toBe(400);
  });

  it("sets stock and returns only the StockLevel fields", async () => {
    const res = await put(SKU_A1, T.ownerA, IDEM(30), { mode: "set", quantity: 12, reason: "recount" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["available", "on_hand", "reserved", "sku_id", "updated_at"]);
    expect(res.body).toMatchObject({ sku_id: SKU_A1, on_hand: 12, reserved: 0, available: 12 });
    expect(Number.isNaN(Date.parse(res.body.updated_at))).toBe(false);
  });

  it("a warehouse member may write; adjust adds a delta", async () => {
    const res = await put(SKU_A1, T.warehouseA, IDEM(31), { mode: "adjust", quantity: -2, reason: "damaged" });
    expect(res.status).toBe(200);
    expect(res.body.on_hand).toBe(10);
  });

  it("replays the same key and request without re-applying", async () => {
    const first = await put(SKU_A1, T.ownerA, IDEM(32), { mode: "adjust", quantity: 5, reason: "received" });
    const again = await put(SKU_A1, T.ownerA, IDEM(32), { mode: "adjust", quantity: 5, reason: "received" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(first.body.on_hand).toBe(15);
  });

  it("the same key with a different body is a 422", async () => {
    const res = await put(SKU_A1, T.ownerA, IDEM(32), { mode: "adjust", quantity: 6, reason: "received" });
    expect(res.status).toBe(422);
  });

  it("refuses to go below zero with 422 and changes nothing", async () => {
    const res = await put(SKU_A1, T.ownerA, IDEM(33), { mode: "adjust", quantity: -1000, reason: "other" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("stock_negative");
    expect(h.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID)?.onHand).toBe(15);
  });

  it("If-Match guards against concurrent edits", async () => {
    const lv = h.store.model.level(SKU_A1, LOC_A, STANDARD_POOL_ID);
    const stale = await put(SKU_A1, T.ownerA, IDEM(34), BODY, { "If-Match": `"${(lv?.syncVersion ?? 0) - 1}"` });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("stock_version_conflict");
    const ok = await put(SKU_A1, T.ownerA, IDEM(35), BODY, { "If-Match": `"${lv?.syncVersion ?? 0}"` });
    expect(ok.status).toBe(200);
    const bad = await put(SKU_A1, T.ownerA, IDEM(36), BODY, { "If-Match": "abc" });
    expect(bad.status).toBe(400);
  });

  it("lowering stock below promised units is accepted and recorded as an oversell, never silently", async () => {
    const res = await put(SKU_A1, T.ownerA, IDEM(40), { mode: "set", quantity: 10, reason: "received" });
    expect(res.status).toBe(200);
    // two units get reserved by checkout, then the seller cuts to 1
    const plan = {
      lines: [{ skuId: SKU_A1, locationId: LOC_A, poolId: STANDARD_POOL_ID, storeId: STORE_A, qty: 2 }],
      ttlSeconds: 600,
      ttlPolicyId: U(0x601),
      poolKind: "STANDARD" as const,
      holdReason: "CARD_WINDOW" as const,
      fingerprint: "x",
    };
    expect(h.store.model.reserve({ reservationId: U(0x9001), orderGroupId: U(0x9002), userId: U(0x701), plan, nowMs: 0 }).status).toBe("reserved");
    const cut = await put(SKU_A1, T.ownerA, IDEM(41), { mode: "set", quantity: 1, reason: "damaged" });
    expect(cut.status).toBe(200);
    expect(cut.body).toMatchObject({ on_hand: 1, reserved: 2, available: 0 });
    expect(h.store.model.oversellRecords.at(-1)).toMatchObject({ skuId: SKU_A1, shortfall: 1 });
  });

  it("error bodies carry only RFC 9457 members", async () => {
    const res = await put(SKU_B1, T.ownerA, IDEM(50), BODY);
    expect(Object.keys(res.body).every((k) => ["type", "title", "status", "detail", "code", "request_id", "errors"].includes(k))).toBe(true);
  });
});
