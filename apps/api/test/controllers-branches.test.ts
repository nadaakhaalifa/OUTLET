import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthController } from "../src/modules/auth/auth.controller.js";
import { CartController } from "../src/modules/cart/cart.controller.js";
import { CatalogPublicController } from "../src/modules/catalog-public/catalog-public.controller.js";
import { CheckoutController } from "../src/modules/checkout/checkout.controller.js";
import { SellerCatalogController } from "../src/modules/seller-catalog/seller-catalog.controller.js";
import { SellerListingsController } from "../src/modules/seller-listings/seller-listings.controller.js";
import type { ApiDeps } from "../src/platform/deps.js";
import type { ApiReply, ApiRequest, RequestState } from "../src/platform/http.js";
import { ProblemError } from "../src/platform/problem.js";
import { ADDRESS, addToBag, authedHeaders, checkoutRequest, placeOrder, quote } from "./flows.js";
import { bearer, createTestApp, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { webhookFor } from "./route-fixtures.js";

// The controllers' defensive guards (a guard let a request through without the state it should have set) cannot be reached over HTTP, so the
// controller methods are called directly with a state that lacks it. The deps stub fails the test if a service is touched before the guard.
const unreachable = (): never => {
  throw new Error("service reached before the guard");
};
const deps = new Proxy({}, { get: () => unreachable }) as unknown as ApiDeps;
const user = { userId: randomUUID(), sessionId: randomUUID(), amr: ["otp"] as readonly string[] };
const st = (o: Partial<RequestState> = {}): RequestState => ({ requestId: "r1", startedAt: 0, market: undefined, marketId: undefined, user: undefined, principal: undefined, storeId: undefined, db: undefined, reasonCode: undefined, rawBody: undefined, log: undefined as never, ...o });
const req = (headers: Record<string, string> = {}): ApiRequest => ({ headers, ip: "127.0.0.1", query: {}, isMultipart: () => false }) as unknown as ApiRequest;
const reply = { header: () => reply } as unknown as ApiReply;
const problem = async (p: Promise<unknown> | (() => Promise<unknown>)): Promise<[number, string]> => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof ProblemError) return [e.status, e.code];
    throw e;
  }
  throw new Error("expected a ProblemError");
};
const noMarket = st({ user });
const noUser = st({ marketId: "EG" });

describe("controller guards when the request state is incomplete", () => {
  it("cart: no market is 404 unknown-market, no user is 401, and neither reaches a service", async () => {
    const c = new CartController(deps);
    const anyId = { cart_line_id: randomUUID() };
    expect(await problem(c.getCart(noMarket))).toEqual([404, "unknown-market"]);
    expect(await problem(c.addLine(noMarket, req(), { sku_id: randomUUID(), qty: 1 }))).toEqual([404, "unknown-market"]);
    expect(await problem(c.updateLine(noMarket, anyId, { qty: 1 }))).toEqual([404, "unknown-market"]);
    expect(await problem(c.deleteLine(noMarket, anyId))).toEqual([404, "unknown-market"]);
    expect(await problem(c.suggestions(noMarket, { store_id: randomUUID(), limit: 5 }))).toEqual([404, "unknown-market"]);
    const stub = new CartController({ cart: () => ({ cart: { get: () => Promise.reject(new Error("unreached")), addLine: () => Promise.reject(new Error("unreached")), updateQty: () => Promise.reject(new Error("unreached")), removeLine: () => Promise.reject(new Error("unreached")) }, suggestions: {} }) } as unknown as ApiDeps);
    expect(await problem(stub.getCart(noUser))).toEqual([401, "unauthenticated"]);
    expect(await problem(stub.addLine(noUser, req(), { sku_id: randomUUID(), qty: 1 }))).toEqual([401, "unauthenticated"]);
    expect(await problem(stub.updateLine(noUser, anyId, { qty: 1 }))).toEqual([401, "unauthenticated"]);
    expect(await problem(stub.deleteLine(noUser, anyId))).toEqual([401, "unauthenticated"]);
  });
  it("cart: PATCH with neither qty nor saved_for_later is 422 nothing-to-update", async () => {
    expect(await problem(new CartController(deps).updateLine(st({ user, marketId: "EG" }), { cart_line_id: randomUUID() }, {}))).toEqual([422, "nothing-to-update"]);
    expect(await problem(new CartController(deps).updateLine(st({ user, marketId: "EG" }), { cart_line_id: randomUUID() }, { saved_for_later: false }))).toEqual([422, "saved-for-later-unsupported"]);
  });

  it("checkout: no market is 404 and no user is 401 on every shopper route", async () => {
    const c = new CheckoutController(deps);
    const id = { order_group_id: randomUUID() };
    expect(await problem(c.quote(noMarket, { address_id: ADDRESS, payment_method: "card" } as never))).toEqual([404, "unknown-market"]);
    expect(await problem(c.place(noMarket, req(), {} as never))).toEqual([404, "unknown-market"]);
    expect(await problem(c.list(noMarket, { limit: 5 }))).toEqual([404, "unknown-market"]);
    expect(await problem(c.get(noMarket, id))).toEqual([404, "unknown-market"]);
    expect(await problem(c.confirmCod(noMarket, id, { code: "123456" }))).toEqual([404, "unknown-market"]);
    expect(await problem(c.webhook(noMarket, req(), { provider: "paymob" }))).toEqual([404, "unknown-market"]);
    const stubSvc = { checkout: {}, orders: {}, cod: {}, webhooks: {}, provider: "paymob" };
    const stub = new CheckoutController({ checkout: () => stubSvc } as unknown as ApiDeps);
    expect(await problem(stub.confirmCod(noUser, id, { code: "123456" }))).toEqual([401, "unauthenticated"]);
    expect(await problem(stub.get(noUser, id))).toEqual([401, "unauthenticated"]);
    expect(await problem(stub.list(noUser, { limit: 5 }))).toEqual([401, "unauthenticated"]);
  });
  it("checkout: partial checkout and a malformed echo are refused before any service call", async () => {
    const c = new CheckoutController(deps);
    const s = st({ user, marketId: "EG" });
    const base = { address_id: ADDRESS, payment_method: "card" } as never;
    expect(await problem(c.quote(s, { address_id: ADDRESS, payment_method: "card", cart_line_ids: [randomUUID()] } as never))).toEqual([422, "partial-checkout-unsupported"]);
    expect(await problem(new CheckoutController({ checkout: () => ({}) } as unknown as ApiDeps).place(s, req(), { ...(base as object), quote_echo: { nope: 1 }, quote_token: "t" } as never))).toEqual([422, "quote-token-invalid"]);
  });
  it("checkout webhook: unknown provider is 404, a missing raw body is 400, a denied source is 403", async () => {
    const mk = (allowed: boolean) => new CheckoutController({ checkout: () => ({ provider: "paymob" }), webhookIps: { allowed: () => allowed } } as unknown as ApiDeps);
    const s = st({ user, marketId: "EG" });
    expect(await problem(mk(true).webhook(s, req(), { provider: "other" } as never))).toEqual([404, "not-found"]);
    expect(await problem(mk(false).webhook(s, req(), { provider: "paymob" }))).toEqual([403, "webhook-source-denied"]);
    expect(await problem(mk(true).webhook(s, req(), { provider: "paymob" }))).toEqual([400, "malformed-request"]);
  });
  it("checkout webhook maps every rejection reason; non-string headers and queries are dropped", async () => {
    const seen: { headers: Record<string, string>; query: Record<string, string> }[] = [];
    const mk = (outcome: object) =>
      new CheckoutController({
        checkout: () => ({ provider: "paymob", webhooks: { handle: (i: { headers: Record<string, string>; query: Record<string, string> }) => { seen.push(i); return Promise.resolve(outcome); } } }),
        webhookIps: { allowed: () => true }, clock: { now: () => new Date(0) },
      } as unknown as ApiDeps);
    const s = st({ user, marketId: "EG", rawBody: new Uint8Array([123, 125]) });
    const r = { headers: { "X-Sig": "abc", "x-multi": ["a", "b"] }, ip: "127.0.0.1", query: { hmac: "h", n: 5, arr: ["x"] } } as unknown as ApiRequest;
    expect(await problem(mk({ outcome: "rejected", reason: "bad_signature" }).webhook(s, r, { provider: "paymob" }))).toEqual([401, "webhook-signature-invalid"]);
    expect(await problem(mk({ outcome: "rejected", reason: "stale_timestamp" }).webhook(s, r, { provider: "paymob" }))).toEqual([401, "webhook-signature-invalid"]);
    expect(await problem(mk({ outcome: "rejected", reason: "malformed" }).webhook(s, r, { provider: "paymob" }))).toEqual([400, "webhook-malformed"]);
    expect(await mk({ outcome: "rejected", reason: "unknown_order" }).webhook(s, r, { provider: "paymob" })).toEqual({ received: true, duplicate: false });
    expect(await mk({ outcome: "duplicate" }).webhook(s, r, { provider: "paymob" })).toEqual({ received: true, duplicate: true });
    expect(seen[0]?.headers).toEqual({ "x-sig": "abc" });
    expect(seen[0]?.query).toEqual({ hmac: "h" });
  });

  it("auth: session routes and passkey registration without a user are 401; wrong purposes are 422", async () => {
    const c = new AuthController(deps);
    const anon = st({ marketId: "EG" });
    expect(await problem(c.logout(anon, reply))).toEqual([401, "unauthenticated"]);
    expect(await problem(c.listSessions(anon, { limit: 5 }))).toEqual([401, "unauthenticated"]);
    expect(await problem(c.revokeSession(anon, { session_family_id: randomUUID() }))).toEqual([401, "unauthenticated"]);
    expect(await problem(c.registerOptions(anon, req(), { purpose: "register" }))).toEqual([401, "unauthenticated"]);
    expect(await problem(c.registerVerify(anon, req(), {} as never))).toEqual([401, "unauthenticated"]);
    expect(await problem(c.listPasskeys(anon, { limit: 5 }))).toEqual([401, "unauthenticated"]);
    expect(await problem(c.revokePasskey(anon, { passkey_id: randomUUID() }))).toEqual([401, "unauthenticated"]);
    const authed = st({ user, marketId: "EG" });
    expect(await problem(c.registerOptions(authed, req(), { purpose: "sign_in" }))).toEqual([422, "purpose-invalid"]);
    expect(await problem(c.assertOptions(authed, req({ "x-device-id": randomUUID() }), { purpose: "register" }))).toEqual([422, "purpose-invalid"]);
    const withSvc = new AuthController({ auth: () => ({ passkeys: {} }) } as unknown as ApiDeps);
    expect(await problem(withSvc.assertOptions(authed, req(), { purpose: "sign_in" }))).toEqual([400, "device-id-required"]);
  });

  it("catalog and seller controllers: missing market or tenant context is a bare problem, not a crash", async () => {
    expect(await problem(() => Promise.resolve().then(() => new CatalogPublicController(deps).listStoreProducts(st(), { store_slug: "s", limit: 5 } as never, undefined as never)))).toEqual([404, "unknown-market"]);
    const sc = new SellerCatalogController(deps);
    const noTenant = st({ marketId: "EG", user });
    expect(await problem(sc.patch(noTenant, req({ "if-match": "1" }), { product_id: randomUUID() }, {}))).toEqual([500, "tenant-context-missing"]);
    expect(await problem(sc.publish(noTenant, req(), { product_id: randomUUID() }))).toEqual([500, "tenant-context-missing"]);
    expect(await problem(() => Promise.resolve().then(() => sc.createDefectCard(noTenant, req(), { product_id: randomUUID() }, {} as never)))).toEqual([500, "tenant-context-missing"]);
    expect(await problem(sc.uploadMedia(noTenant, req(), { product_id: randomUUID() }))).toEqual([500, "tenant-context-missing"]);
    expect(await problem(() => Promise.resolve().then(() => new SellerListingsController(deps).createDraft(noTenant, {} as never)))).toEqual([500, "tenant-context-missing"]);
  });
});

describe("tenant guard needs every one of principal, store and market", () => {
  const principal = { kind: "seller_staff", userId: randomUUID(), marketId: "EG", storeIds: [], roles: ["owner"], scopes: [] } as unknown as RequestState["principal"];
  const combos: [string, Partial<RequestState>][] = [
    ["no principal", { storeId: randomUUID(), marketId: "EG" }],
    ["no store", { principal, marketId: "EG" }],
    ["no market", { principal, storeId: randomUUID() }],
  ];
  it.each(combos)("%s is a 500 tenant-context-missing on the listing and catalog controllers", async (_n, o) => {
    const s = st({ user, ...o });
    const sc = new SellerCatalogController(deps);
    expect(await problem(sc.publish(s, req(), { product_id: randomUUID() }))).toEqual([500, "tenant-context-missing"]);
    expect(await problem(() => Promise.resolve().then(() => new SellerListingsController(deps).createDraft(s, {} as never)))).toEqual([500, "tenant-context-missing"]);
  });
});

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });
// Test helper: the caller names the expected shape.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const json = <T>(body: string): T => JSON.parse(body) as T;

describe("cart over HTTP: ownership, validation and honest fallbacks", () => {
  it("another shopper's line is 404 on PATCH and DELETE, and the owner's bag is unchanged", async () => {
    const a = await t.shopper();
    const b = await t.shopper();
    const { lineId } = await addToBag(t, a.token, 2);
    expect((await t.inject({ method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, b.token), payload: { qty: 1 } })).statusCode).toBe(404);
    expect((await t.inject({ method: "DELETE", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, b.token) })).statusCode).toBe(404);
    const mine = json<{ groups: { lines: { qty: number }[] }[] }>((await t.inject({ method: "GET", url: "/v1/eg/cart", headers: bearer(a.token) })).body);
    expect(mine.groups[0]?.lines[0]?.qty).toBe(2);
  });
  it("PATCH changes the quantity, rejects 0 and over-limit, and DELETE empties the bag", async () => {
    const s = await t.shopper();
    const { lineId } = await addToBag(t, s.token);
    const ok = await t.inject({ method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token), payload: { qty: 4 } });
    expect(json<{ groups: { lines: { qty: number }[] }[] }>(ok.body).groups[0]?.lines[0]?.qty).toBe(4);
    expect([400, 422]).toContain((await t.inject({ method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token), payload: { qty: 0 } })).statusCode);
    expect((await t.inject({ method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token), payload: { qty: 11 } })).statusCode).toBe(400);
    expect((await t.inject({ method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token), payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
    const del = await t.inject({ method: "DELETE", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token) });
    expect(json<{ groups: unknown[] }>(del.body).groups).toEqual([]);
  });
  it("401 without a token and 404 for an unknown market", async () => {
    expect((await t.inject({ method: "GET", url: "/v1/eg/cart" })).statusCode).toBe(401);
    expect((await t.inject({ method: "GET", url: "/v1/eg/cart", headers: bearer("not.a.jwt") })).statusCode).toBe(401);
    expect((await t.inject({ method: "GET", url: "/v1/zz/cart", headers: bearer((await t.shopper()).token) })).statusCode).toBe(404);
  });
  it("suggestions: a store in the bag below its threshold asks the engine; a store not in the bag gets nothing", async () => {
    const s = await t.shopper();
    const empty = json<{ items: unknown[] }>((await t.inject({ method: "GET", url: `/v1/eg/cart/free-delivery-suggestions?store_id=${t.seed.storeA}`, headers: bearer(s.token) })).body);
    expect(empty.items).toEqual([]);
    await addToBag(t, s.token);
    const some = await t.inject({ method: "GET", url: `/v1/eg/cart/free-delivery-suggestions?store_id=${t.seed.storeA}&limit=3`, headers: bearer(s.token) });
    expect(some.statusCode).toBe(200);
    const other = json<{ items: unknown[] }>((await t.inject({ method: "GET", url: `/v1/eg/cart/free-delivery-suggestions?store_id=${t.seed.storeB}`, headers: bearer(s.token) })).body);
    expect(other.items).toEqual([]);
    expect((await t.inject({ method: "GET", url: "/v1/eg/cart/free-delivery-suggestions?store_id=nope", headers: bearer(s.token) })).statusCode).toBe(400);
  });
});

describe("cart of a store that is no longer available", () => {
  it("a suspended store's line is shown unavailable under a fallback name, and the bag cannot be quoted", async () => {
    const app = await createTestApp();
    try {
      const s = await app.shopper();
      await addToBag(app, s.token);
      await app.raw.query("DELETE FROM catalog_public_stores WHERE id = $1", [app.seed.storeA]); // the public projection drops a suspended store
      const cart = json<{ groups: { store_slug: string; display_name_ar: string; lines: { available: boolean }[] }[]; notices: { code: string }[] }>((await app.inject({ method: "GET", url: "/v1/eg/cart", headers: bearer(s.token) })).body);
      expect(cart.groups).toHaveLength(1);
      expect(cart.groups[0]?.lines.every((l) => !l.available)).toBe(true);
      expect(cart.groups[0]?.display_name_ar.length).toBeGreaterThan(0);
      const q = await app.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: authedHeaders(app, s.token), payload: { address_id: ADDRESS, payment_method: "card" } });
      expect(q.statusCode).toBeGreaterThanOrEqual(400);
      expect(q.statusCode).toBeLessThan(500);
    } finally {
      await app.close();
    }
  });
});

describe("checkout over HTTP: client actions per method, ownership, filters", () => {
  it("fawry returns a reference with an expiry; card returns a redirect; COD returns a confirmation action", async () => {
    const f = await t.shopper();
    await addToBag(t, f.token);
    const fq = await quote(t, f.token, "fawry");
    const fr = await t.inject(checkoutRequest(t, f.token, fq, "fawry"));
    expect(fr.statusCode).toBe(201);
    const fa = json<{ client_action: { kind: string; reference: string; expires_at: string }; reservation_expires_at: string | null }>(fr.body);
    expect(fa.client_action.kind).toBe("fawry_reference");
    expect(fa.client_action.reference).toMatch(/^FW/);
    expect(Date.parse(fa.client_action.expires_at)).toBeGreaterThan(Date.parse(fa.reservation_expires_at ?? "") - 1);

    const card = await placeOrder(t, "card");
    const cg = json<{ client_action: { kind: string; url: string }; paid_at: string | null; payment_status: string }>((await t.inject({ method: "GET", url: `/v1/eg/order-groups/${card.groupId}`, headers: bearer(card.token) })).body);
    expect(cg.client_action.kind).toBe("redirect");
    expect(cg.client_action.url).toContain("https://pay.fake.test/");
    expect(cg.paid_at).toBeNull();
  });
  it("after the webhook the order shows paid_at and its seller order lines; a stranger gets 404 on read and COD confirm", async () => {
    const o = await placeOrder(t, "card");
    expect((await t.inject(await webhookFor(t, o.groupId, "payment.succeeded"))).statusCode).toBe(200);
    const g = json<{ status: string; paid_at: string | null; seller_orders: { lines: unknown[]; cancellable: boolean; returnable: boolean; store_display_name_ar: string }[] }>((await t.inject({ method: "GET", url: `/v1/eg/order-groups/${o.groupId}`, headers: bearer(o.token) })).body);
    expect(g.status).toBe("PAID");
    expect(g.paid_at).not.toBeNull();
    expect(g.seller_orders[0]?.lines).toHaveLength(1);
    expect(g.seller_orders[0]).toMatchObject({ cancellable: false, returnable: false });
    const stranger = await t.shopper();
    expect((await t.inject({ method: "GET", url: `/v1/eg/order-groups/${o.groupId}`, headers: bearer(stranger.token) })).statusCode).toBe(404);
    expect((await t.inject({ method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cod-confirmation`, headers: authedHeaders(t, stranger.token), payload: { code: "123456" } })).statusCode).toBe(404);
    expect((await t.inject({ method: "POST", url: `/v1/eg/order-groups/${randomUUID()}/cod-confirmation`, headers: authedHeaders(t, stranger.token), payload: { code: "123456" } })).statusCode).toBe(404);
    expect((await t.inject({ method: "GET", url: `/v1/eg/order-groups/${randomUUID()}`, headers: bearer(stranger.token) })).statusCode).toBe(404);
  });
  it("401 without a token on every shopper checkout route, and 400 for a malformed Idempotency-Key", async () => {
    for (const [method, url] of [["POST", "/v1/eg/checkout/quote"], ["POST", "/v1/eg/checkout"], ["GET", "/v1/eg/order-groups"], ["GET", `/v1/eg/order-groups/${randomUUID()}`], ["POST", `/v1/eg/order-groups/${randomUUID()}/cod-confirmation`]] as const) {
      expect((await t.inject({ method, url, headers: { "idempotency-key": idemKey(t) }, ...(method === "POST" ? { payload: {} } : {}) })).statusCode).toBe(401);
    }
    const s = await t.shopper();
    const bad = await t.inject({ method: "POST", url: "/v1/eg/checkout", headers: { ...bearer(s.token), "idempotency-key": "nope", "x-device-id": randomUUID() }, payload: {} });
    expect(bad.statusCode).toBe(400);
    expect(json<{ code: string }>(bad.body).code).toBe("idempotency-key-invalid");
  });
  it("an empty bag cannot be quoted, and a COD refused by risk is rejected at placement with nothing created", async () => {
    const s = await t.shopper();
    const empty = await t.inject({ method: "POST", url: "/v1/eg/checkout/quote", headers: authedHeaders(t, s.token), payload: { address_id: ADDRESS, payment_method: "card" } });
    expect([409, 422]).toContain(empty.statusCode);
    expect(json<{ code: string }>(empty.body).code).toBe("empty-bag");
    await addToBag(t, s.token);
    const q = await quote(t, s.token, "cod");
    t.fakes.risk.decision = "block";
    try {
      const r = await t.inject(checkoutRequest(t, s.token, q, "cod"));
      expect(r.statusCode).toBe(403);
      expect(json<{ code: string }>(r.body).code).toBe("cod-not-allowed");
      const orders = json<{ items: unknown[] }>((await t.inject({ method: "GET", url: "/v1/eg/order-groups", headers: bearer(s.token) })).body);
      expect(orders.items).toEqual([]);
    } finally {
      t.fakes.risk.decision = "allow";
    }
  });
  it("order list: status filter, limit bounds and a cursor from another user are safe", async () => {
    const o = await placeOrder(t, "card");
    const mine = json<{ items: { id: string; status: string }[] }>((await t.inject({ method: "GET", url: "/v1/eg/order-groups?status=PENDING_PAYMENT", headers: bearer(o.token) })).body);
    expect(mine.items.map((i) => i.id)).toContain(o.groupId);
    const none = json<{ items: unknown[] }>((await t.inject({ method: "GET", url: "/v1/eg/order-groups?status=PAID", headers: bearer(o.token) })).body);
    expect(none.items).toEqual([]);
    expect((await t.inject({ method: "GET", url: "/v1/eg/order-groups?limit=0", headers: bearer(o.token) })).statusCode).toBe(400);
    expect((await t.inject({ method: "GET", url: "/v1/eg/order-groups?limit=1000", headers: bearer(o.token) })).statusCode).toBe(400);
    expect((await t.inject({ method: "GET", url: "/v1/eg/order-groups?cursor=%%%", headers: bearer(o.token) })).statusCode).toBeLessThan(500);
  });
  it("a provider outside the contract enum is 400 and a known but unconfigured provider is 404", async () => {
    expect((await t.inject({ method: "POST", url: "/v1/eg/webhooks/psp/unknown", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(400);
    expect((await t.inject({ method: "POST", url: "/v1/eg/webhooks/psp/kashier", headers: { "content-type": "application/json" }, payload: "{}" })).statusCode).toBe(404);
  });
});
