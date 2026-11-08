import type { InjectOptions } from "fastify";
import { randomUUID } from "node:crypto";
import { DEVICE, RP_ID, RP_ORIGIN, bearer, idemKey } from "./harness.js";
import { ADDRESS, addToBag, assertVerifyRequest, authedHeaders, checkoutRequest, enrollPasskey, phone, placeOrder, quote, signIn } from "./flows.js";
import { makePng, multipartBody } from "./png.js";
import { ADMIN_FIXTURES } from "./admin-fixtures.js";
import { POST_ORDER_FIXTURES } from "./post-order-fixtures.js";
import { seedSellerOrder } from "./seller-orders-fakes.js";
import { VirtualAuthenticator } from "./webauthn.js";
import type { TestApp } from "./harness.js";

export interface HappyRequest {
  readonly req: InjectOptions;
  readonly status: number;
  /** Run once before counting (steady state: e.g. readiness caches its one-off checks). */
  readonly warmup?: boolean;
}

/**
 * One entry per production route, keyed `METHOD /openapi/path`. routes.test.ts fails when a route has no entry, so a
 * new endpoint cannot ship without its negative-authorization and query-count cases.
 * Store-tenant happy requests act for `seed.storeA` (the generator swaps tokens and X-Store-Id around it).
 */
export interface RouteFixture {
  happy(t: TestApp): Promise<HappyRequest>;
  /** Public routes with object ids: a request for an id that does not exist (or is not public) → 404. */
  missing?(t: TestApp): InjectOptions;
  /** User-tenant routes with object ids: the same request for another user's object → 404. */
  otherTenant?(t: TestApp): Promise<InjectOptions>;
}

const device = { "x-device-id": DEVICE };

/** A signed provider callback for a freshly placed card order (amount = the order total). */
export const webhookRequest = async (t: TestApp, type: "payment.succeeded" | "payment.failed", o: { badSignature?: boolean; eventId?: string } = {}): Promise<InjectOptions> => {
  const placed = await placeOrder(t, "card");
  return webhookFor(t, placed.groupId, type, o);
};

export const webhookFor = async (t: TestApp, groupId: string, type: "payment.succeeded" | "payment.failed", o: { badSignature?: boolean; eventId?: string } = {}): Promise<InjectOptions> => {
  const r = await t.raw.query<{ id: string; provider_ref: string; amount_minor: string }>("SELECT id, provider_ref, amount_minor FROM payment_intents WHERE order_group_id = $1", [groupId]);
  const intent = r.rows[0];
  if (intent === undefined) throw new Error("no intent");
  const w = t.fakes.provider.webhook(
    { id: o.eventId ?? `evt_${randomUUID()}`, type, merchantReference: intent.id, providerRef: intent.provider_ref, amountMinor: BigInt(intent.amount_minor) },
    { badSignature: o.badSignature === true },
  );
  return { method: "POST", url: "/v1/eg/webhooks/psp/paymob", headers: { "content-type": "application/json", ...w.headers }, payload: Buffer.from(w.rawBody) };
};

const WRITE_ROLES = ["catalog"] as const;
const sellerHeaders = (t: TestApp, token: string, store: string): Record<string, string> => ({ ...bearer(token), "x-store-id": store, "idempotency-key": idemKey(t) });

/** A fresh DRAFT listing created through the API (open_box = a grade that needs a defect card). */
export const newDraft = async (t: TestApp, store: string, grade = "new_with_tags"): Promise<{ id: string; version: number; token: string }> => {
  const { token } = await t.seller(store, WRITE_ROLES);
  const res = await t.inject({ method: "POST", url: "/v1/eg/seller/products", headers: sellerHeaders(t, token, store), payload: { condition_grade_code: grade, primary_category_id: t.seed.categoryId } });
  const body = JSON.parse(res.body) as { id: string; version: number };
  return { id: body.id, version: body.version, token };
};

export const DETAILS = (categoryId: string) => ({
  title_ar: "حذاء رياضي",
  description_ar: "حذاء رياضي بحالة ممتازة",
  primary_category_id: categoryId,
  attributes: {},
});

const readFixture = (url: (t: TestApp) => string, otherId: (t: TestApp) => Promise<string> | string): RouteFixture => ({
  happy: async (t) => {
    const { token } = await t.seller(t.seed.storeA, ["catalog"]);
    return { req: { method: "GET", url: url(t), headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
  },
  otherTenant: async (t) => {
    const { token } = await t.seller(t.seed.storeA, ["catalog"]);
    return { method: "GET", url: `/v1/eg/seller/products/${await otherId(t)}${url(t).includes("/readiness") ? "/readiness" : ""}`, headers: { ...bearer(token), "x-store-id": t.seed.storeA } };
  },
});

const foreignCache = new WeakMap<TestApp, string>();
/** A listing of store B, created once per test app. */
export const foreignProduct = async (t: TestApp): Promise<string> => {
  const hit = foreignCache.get(t);
  if (hit !== undefined) return hit;
  const d = await newDraft(t, t.seed.storeB);
  foreignCache.set(t, d.id);
  return d.id;
};

/** An OTP challenge ready to verify (new account). */
const otpChallenge = async (t: TestApp): Promise<{ device: string; phone: string; challenge: string; code: string }> => {
  const device = await t.device();
  const p = phone();
  const r = await t.inject({ method: "POST", url: "/v1/eg/auth/otp/request", headers: { "x-device-id": device, "idempotency-key": idemKey(t) }, payload: { phone_e164: p, channel: "sms", purpose: "sign_in" } });
  return { device, phone: p, challenge: (JSON.parse(r.body) as { challenge_id: string }).challenge_id, code: t.sms.last() };
};

const FED = { id_token: "x.y.z", nonce: "n" };

const BASE_FIXTURES: Readonly<Record<string, RouteFixture>> = {
  "POST /v1/{market}/auth/devices": {
    happy: () => Promise.resolve({ req: { method: "POST", url: "/v1/eg/auth/devices", payload: { install_id: randomUUID(), platform: "web" } }, status: 201 }),
  },
  "POST /v1/{market}/auth/otp/request": {
    happy: async (t) => ({ req: { method: "POST", url: "/v1/eg/auth/otp/request", headers: { "x-device-id": await t.device(), "idempotency-key": idemKey(t) }, payload: { phone_e164: phone(), channel: "sms", purpose: "sign_in" } }, status: 201 }),
  },
  "POST /v1/{market}/auth/otp/verify": {
    happy: async (t) => {
      const c = await otpChallenge(t);
      return { req: { method: "POST", url: "/v1/eg/auth/otp/verify", headers: { "x-device-id": c.device, "idempotency-key": idemKey(t) }, payload: { challenge_id: c.challenge, phone_e164: c.phone, code: c.code, dob: "1990-01-01" } }, status: 200 };
    },
  },
  "POST /v1/{market}/auth/refresh": {
    happy: async (t) => {
      const s = await signIn(t);
      return { req: { method: "POST", url: "/v1/eg/auth/refresh", headers: { "x-device-id": s.deviceId, "idempotency-key": idemKey(t) }, payload: { refresh_token: s.refresh } }, status: 200 };
    },
  },
  "POST /v1/{market}/auth/logout": {
    happy: async (t) => {
      const s = await t.shopper();
      return { req: { method: "POST", url: "/v1/eg/auth/logout", headers: authedHeaders(t, s.token), payload: {} }, status: 204 };
    },
  },
  "POST /v1/{market}/auth/logout-by-refresh": {
    happy: async (t) => {
      const s = await signIn(t);
      return { req: { method: "POST", url: "/v1/eg/auth/logout-by-refresh", headers: { "x-device-id": s.deviceId }, payload: { refresh_token: s.refresh } }, status: 204 };
    },
  },
  "GET /v1/{market}/me/passkeys": {
    happy: async (t) => {
      const s = await signIn(t);
      await enrollPasskey(t, s);
      return { req: { method: "GET", url: "/v1/eg/me/passkeys?limit=10", headers: bearer(s.token) }, status: 200 };
    },
  },
  "DELETE /v1/{market}/me/passkeys/{passkey_id}": {
    happy: async (t) => {
      const s = await signIn(t);
      await enrollPasskey(t, s);
      const id = (await t.passkeyStore.listByUser("EG", s.userId))[0]?.id ?? "";
      return { req: { method: "DELETE", url: `/v1/eg/me/passkeys/${id}`, headers: authedHeaders(t, s.token) }, status: 204 };
    },
    otherTenant: async (t) => {
      const owner = await signIn(t);
      await enrollPasskey(t, owner);
      const intruder = await t.shopper();
      const id = (await t.passkeyStore.listByUser("EG", owner.userId))[0]?.id ?? "";
      return { method: "DELETE", url: `/v1/eg/me/passkeys/${id}`, headers: authedHeaders(t, intruder.token) };
    },
  },
  "GET /v1/{market}/me/sessions": {
    happy: async (t) => {
      const s = await t.shopper();
      return { req: { method: "GET", url: "/v1/eg/me/sessions?limit=10", headers: bearer(s.token) }, status: 200 };
    },
  },
  "DELETE /v1/{market}/me/sessions/{session_family_id}": {
    happy: async (t) => {
      const s = await signIn(t);
      return { req: { method: "DELETE", url: `/v1/eg/me/sessions/${s.sessionId}`, headers: authedHeaders(t, s.token) }, status: 204 };
    },
    otherTenant: async (t) => {
      const owner = await signIn(t);
      const intruder = await t.shopper();
      return { method: "DELETE", url: `/v1/eg/me/sessions/${owner.sessionId}`, headers: authedHeaders(t, intruder.token) };
    },
  },
  "POST /v1/{market}/auth/apple": { happy: async (t) => ({ req: { method: "POST", url: "/v1/eg/auth/apple", headers: { "x-device-id": await t.device(), "idempotency-key": idemKey(t) }, payload: FED }, status: 503 }) },
  "POST /v1/{market}/auth/google": { happy: async (t) => ({ req: { method: "POST", url: "/v1/eg/auth/google", headers: { "x-device-id": await t.device(), "idempotency-key": idemKey(t) }, payload: FED }, status: 503 }) },
  "POST /v1/{market}/auth/passkeys/register/options": {
    happy: async (t) => {
      const s = await t.shopper();
      return { req: { method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token), payload: { purpose: "register" } }, status: 200 };
    },
  },
  "POST /v1/{market}/auth/passkeys/register/verify": {
    happy: async (t) => {
      const s = await t.shopper();
      const o = await t.inject({ method: "POST", url: "/v1/eg/auth/passkeys/register/options", headers: authedHeaders(t, s.token), payload: { purpose: "register" } });
      const body = JSON.parse(o.body) as { challenge_id: string; public_key: { challenge: string } };
      const authn = new VirtualAuthenticator(RP_ID, RP_ORIGIN);
      return { req: { method: "POST", url: "/v1/eg/auth/passkeys/register/verify", headers: authedHeaders(t, s.token), payload: { challenge_id: body.challenge_id, credential: authn.create(body.public_key.challenge) } }, status: 201 };
    },
  },
  "POST /v1/{market}/auth/passkeys/assert/options": {
    happy: async (t) => ({ req: { method: "POST", url: "/v1/eg/auth/passkeys/assert/options", headers: { "x-device-id": await t.device(), "idempotency-key": idemKey(t) }, payload: { purpose: "sign_in" } }, status: 200 }),
  },
  "POST /v1/{market}/auth/passkeys/assert/verify": {
    happy: async (t) => {
      const s = await signIn(t);
      const authn = await enrollPasskey(t, s);
      return { req: await assertVerifyRequest(t, authn, s.deviceId), status: 200 };
    },
  },
  "GET /v1/{market}/cart": {
    happy: async (t) => ({ req: { method: "GET", url: "/v1/eg/cart", headers: bearer((await t.shopper()).token) }, status: 200 }),
  },
  "POST /v1/{market}/cart/lines": {
    happy: async (t) => ({ req: { method: "POST", url: "/v1/eg/cart/lines", headers: authedHeaders(t, (await t.shopper()).token), payload: { sku_id: t.seed.skuA, qty: 1 } }, status: 201 }),
  },
  "PATCH /v1/{market}/cart/lines/{cart_line_id}": {
    happy: async (t) => {
      const s = await t.shopper();
      const { lineId } = await addToBag(t, s.token);
      return { req: { method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token), payload: { qty: 2 } }, status: 200 };
    },
    otherTenant: async (t) => {
      const owner = await t.shopper();
      const { lineId } = await addToBag(t, owner.token);
      return { method: "PATCH", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, (await t.shopper()).token), payload: { qty: 2 } };
    },
  },
  "DELETE /v1/{market}/cart/lines/{cart_line_id}": {
    happy: async (t) => {
      const s = await t.shopper();
      const { lineId } = await addToBag(t, s.token);
      return { req: { method: "DELETE", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, s.token) }, status: 200 };
    },
    otherTenant: async (t) => {
      const owner = await t.shopper();
      const { lineId } = await addToBag(t, owner.token);
      return { method: "DELETE", url: `/v1/eg/cart/lines/${lineId}`, headers: authedHeaders(t, (await t.shopper()).token) };
    },
  },
  "GET /v1/{market}/cart/free-delivery-suggestions": {
    happy: async (t) => {
      const s = await t.shopper();
      await addToBag(t, s.token);
      return { req: { method: "GET", url: `/v1/eg/cart/free-delivery-suggestions?store_id=${t.seed.storeA}&limit=10`, headers: bearer(s.token) }, status: 200 };
    },
  },
  "POST /v1/{market}/checkout/quote": {
    happy: async (t) => {
      const s = await t.shopper();
      await addToBag(t, s.token);
      return { req: { method: "POST", url: "/v1/eg/checkout/quote", headers: bearer(s.token), payload: { address_id: ADDRESS, payment_method: "card" } }, status: 200 };
    },
  },
  "POST /v1/{market}/checkout": {
    happy: async (t) => {
      const s = await t.shopper();
      await addToBag(t, s.token);
      return { req: checkoutRequest(t, s.token, await quote(t, s.token)), status: 201 };
    },
  },
  "GET /v1/{market}/order-groups": {
    happy: async (t) => ({ req: { method: "GET", url: "/v1/eg/order-groups?limit=10", headers: bearer((await t.shopper()).token) }, status: 200 }),
  },
  "GET /v1/{market}/order-groups/{order_group_id}": {
    happy: async (t) => {
      const o = await placeOrder(t);
      return { req: { method: "GET", url: `/v1/eg/order-groups/${o.groupId}`, headers: bearer(o.token) }, status: 200 };
    },
    otherTenant: async (t) => {
      const o = await placeOrder(t);
      return { method: "GET", url: `/v1/eg/order-groups/${o.groupId}`, headers: bearer((await t.shopper()).token) };
    },
  },
  "POST /v1/{market}/order-groups/{order_group_id}/cod-confirmation": {
    happy: async (t) => {
      t.fakes.risk.decision = "require_confirmation";
      const o = await placeOrder(t, "cod");
      t.fakes.risk.decision = "allow";
      return { req: { method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cod-confirmation`, headers: authedHeaders(t, o.token), payload: { code: "123456" } }, status: 200 };
    },
    otherTenant: async (t) => {
      t.fakes.risk.decision = "require_confirmation";
      const o = await placeOrder(t, "cod");
      t.fakes.risk.decision = "allow";
      return { method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cod-confirmation`, headers: authedHeaders(t, (await t.shopper()).token), payload: { code: "123456" } };
    },
  },
  "POST /v1/{market}/webhooks/psp/{provider}": {
    happy: async (t) => ({ req: await webhookRequest(t, "payment.succeeded"), status: 200 }),
    // The market's PSP is paymob: a callback addressed to another provider is not routable.
    missing: () => ({ method: "POST", url: "/v1/eg/webhooks/psp/kashier", headers: { "content-type": "application/json" }, payload: "{}" }),
  },
  "GET /v1/health/live": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/health/live" }, status: 200 }),
  },
  "GET /v1/health/ready": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/health/ready" }, status: 200, warmup: true }),
  },
  "GET /v1/{market}/stores": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/stores?limit=10", headers: device }, status: 200 }),
  },
  "GET /v1/{market}/categories": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/categories?limit=50", headers: device }, status: 200 }),
  },
  "GET /v1/{market}/deals": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/deals?band=59_50&limit=10", headers: device }, status: 200 }),
  },
  "GET /v1/{market}/products/{product_id}": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/products/${t.seed.productA}`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/products/00000000-0000-4000-8000-00000000dead", headers: device }),
  },
  "GET /v1/{market}/stores/{store_slug}": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/stores/${t.seed.slugA}`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/stores/no-such-store", headers: device }),
  },
  "GET /v1/{market}/stores/{store_slug}/products": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/stores/${t.seed.slugA}/products?limit=10`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/stores/no-such-store/products", headers: device }),
  },
  "GET /v1/{market}/passports/{passport_code}": {
    happy: (t) => Promise.resolve({ req: { method: "GET", url: `/v1/eg/passports/${t.seed.passportA}`, headers: device }, status: 200 }),
    missing: () => ({ method: "GET", url: "/v1/eg/passports/0000000000000000000000000A", headers: device }),
  },
  "POST /v1/{market}/seller/products": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return {
        req: {
          method: "POST",
          url: "/v1/eg/seller/products",
          headers: { ...bearer(token), "x-store-id": t.seed.storeA, "idempotency-key": idemKey(t) },
          payload: { condition_grade_code: "new_with_tags", primary_category_id: t.seed.categoryId },
        },
        status: 201,
      };
    },
  },
  "GET /v1/{market}/seller/products": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "GET", url: "/v1/eg/seller/products?limit=10", headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
  },
  "GET /v1/{market}/seller/products/{product_id}": readFixture((t) => `/v1/eg/seller/products/${t.seed.productA}`, foreignProduct),
  "GET /v1/{market}/seller/products/{product_id}/readiness": readFixture((t) => `/v1/eg/seller/products/${t.seed.productA}/readiness`, foreignProduct),
  "PATCH /v1/{market}/seller/products/{product_id}": {
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA);
      return {
        req: {
          method: "PATCH",
          url: `/v1/eg/seller/products/${d.id}`,
          headers: { ...sellerHeaders(t, d.token, t.seed.storeA), "if-match": `"${String(d.version)}"` },
          payload: { details: DETAILS(t.seed.categoryId), price: { price: { amount_minor: "129900", currency: "EGP" } } },
        },
        status: 200,
      };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return {
        method: "PATCH",
        url: `/v1/eg/seller/products/${await foreignProduct(t)}`,
        headers: { ...sellerHeaders(t, token, t.seed.storeA), "if-match": '"1"' },
        payload: { details: DETAILS(t.seed.categoryId) },
      };
    },
  },
  "POST /v1/{market}/seller/products/{product_id}/media": {
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA);
      const form = multipartBody({ kind: "product" }, { name: "front.png", type: "image/png", data: makePng() });
      return { req: { method: "POST", url: `/v1/eg/seller/products/${d.id}/media`, headers: { ...sellerHeaders(t, d.token, t.seed.storeA), "content-type": form.contentType }, payload: form.payload }, status: 201 };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      const form = multipartBody({ kind: "product" }, { name: "front.png", type: "image/png", data: makePng() });
      return { method: "POST", url: `/v1/eg/seller/products/${await foreignProduct(t)}/media`, headers: { ...sellerHeaders(t, token, t.seed.storeA), "content-type": form.contentType }, payload: form.payload };
    },
  },
  "POST /v1/{market}/seller/products/{product_id}/defect-cards": {
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA, "open_box");
      return {
        req: {
          method: "POST",
          url: `/v1/eg/seller/products/${d.id}/defect-cards`,
          headers: { ...sellerHeaders(t, d.token, t.seed.storeA), "if-match": `"${String(d.version)}"` },
          payload: DEFECT_CARD(),
        },
        status: 201,
      };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { method: "POST", url: `/v1/eg/seller/products/${await foreignProduct(t)}/defect-cards`, headers: { ...sellerHeaders(t, token, t.seed.storeA), "if-match": '"1"' }, payload: DEFECT_CARD() };
    },
  },
  "POST /v1/{market}/seller/products/{product_id}/publish": {
    // A fresh draft cannot go live: the 409 with its reason list is the steady-state answer measured here (the 200 path has its own test).
    happy: async (t) => {
      const d = await newDraft(t, t.seed.storeA);
      return { req: { method: "POST", url: `/v1/eg/seller/products/${d.id}/publish`, headers: sellerHeaders(t, d.token, t.seed.storeA), payload: {} }, status: 409 };
    },
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { method: "POST", url: `/v1/eg/seller/products/${await foreignProduct(t)}/publish`, headers: sellerHeaders(t, token, t.seed.storeA), payload: {} };
    },
  },
  "GET /v1/{market}/seller/categories": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "GET", url: "/v1/eg/seller/categories?limit=50", headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
  },
  "GET /v1/{market}/seller/attribute-sets/{category_id}": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "GET", url: `/v1/eg/seller/attribute-sets/${t.seed.categoryId}`, headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
    // Not tenant data: an unknown or inactive category is 404.
    otherTenant: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { method: "GET", url: "/v1/eg/seller/attribute-sets/00000000-0000-4000-8000-00000000dead", headers: { ...bearer(token), "x-store-id": t.seed.storeA } };
    },
  },
};

const ORDER_ROLES = ["warehouse"] as const;
const READ_ROLES = ["finance"] as const;
const orderHeaders = (t: TestApp, token: string, store: string): Record<string, string> => ({ ...bearer(token), "x-store-id": store, "idempotency-key": idemKey(t) });

/** A fulfilment action on a fresh store-A order in `from` (happy) and on a store-B order (otherTenant). */
const orderAction = (action: string, from: string, payload: object = {}): RouteFixture => ({
  happy: async (t) => {
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: from });
    const { token } = await t.seller(t.seed.storeA, ORDER_ROLES);
    return { req: { method: "POST", url: `/v1/eg/seller/orders/${o.id}/${action}`, headers: orderHeaders(t, token, t.seed.storeA), payload }, status: 200 };
  },
  otherTenant: async (t) => {
    const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeB, status: from });
    const { token } = await t.seller(t.seed.storeA, ORDER_ROLES);
    return { method: "POST", url: `/v1/eg/seller/orders/${o.id}/${action}`, headers: orderHeaders(t, token, t.seed.storeA), payload };
  },
});

export const SELLER_ORDER_FIXTURES: Readonly<Record<string, RouteFixture>> = {
  "GET /v1/{market}/seller/orders": {
    happy: async (t) => {
      await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA });
      const { token } = await t.seller(t.seed.storeA, READ_ROLES);
      return { req: { method: "GET", url: "/v1/eg/seller/orders?limit=10", headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
  },
  "GET /v1/{market}/seller/orders/{seller_order_id}": {
    happy: async (t) => {
      const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA });
      const { token } = await t.seller(t.seed.storeA, READ_ROLES);
      return { req: { method: "GET", url: `/v1/eg/seller/orders/${o.id}`, headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
    otherTenant: async (t) => {
      const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeB });
      const { token } = await t.seller(t.seed.storeA, READ_ROLES);
      return { method: "GET", url: `/v1/eg/seller/orders/${o.id}`, headers: { ...bearer(token), "x-store-id": t.seed.storeA } };
    },
  },
  "POST /v1/{market}/seller/orders/{seller_order_id}/accept": orderAction("accept", "PAID"),
  "POST /v1/{market}/seller/orders/{seller_order_id}/reject": orderAction("reject", "PAID", { reason_code: "out_of_stock" }),
  "POST /v1/{market}/seller/orders/{seller_order_id}/pack": orderAction("pack", "ACCEPTED"),
  "POST /v1/{market}/seller/shipments": {
    happy: async (t) => {
      const o = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status: "PACKED" });
      const { token } = await t.seller(t.seed.storeA, ORDER_ROLES);
      return { req: { method: "POST", url: "/v1/eg/seller/shipments", headers: orderHeaders(t, token, t.seed.storeA), payload: { seller_order_ids: [o.id], declared_weight_g: 800 } }, status: 201 };
    },
  },
  "GET /v1/{market}/seller/inventory": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["warehouse"]);
      return { req: { method: "GET", url: "/v1/eg/seller/inventory?limit=10", headers: { ...bearer(token), "x-store-id": t.seed.storeA } }, status: 200 };
    },
  },
  "POST /v1/{market}/seller/inventory/adjustments": {
    happy: async (t) => {
      const { token } = await t.seller(t.seed.storeA, ["catalog"]);
      return { req: { method: "POST", url: "/v1/eg/seller/inventory/adjustments", headers: orderHeaders(t, token, t.seed.storeA), payload: { sku_id: t.seed.skuA, delta: 2, reason: "received" } }, status: 201 };
    },
  },
};

export const ROUTE_FIXTURES: Readonly<Record<string, RouteFixture>> = { ...BASE_FIXTURES, ...SELLER_ORDER_FIXTURES, ...ADMIN_FIXTURES, ...POST_ORDER_FIXTURES };

export function DEFECT_CARD() {
  return {
    summary_ar: "خدش خفيف على الجانب",
    affects_function: false,
    items: [{ defect_type_code: "stain", location_ar: "الجانب الأيمن", severity: "minor", affects_function: false, photo_media_id: "00000000-0000-4000-8000-0000000d0001", hotspot_x_bp: 2500, hotspot_y_bp: 6000 }],
  };
}
