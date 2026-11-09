import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { T0, bearer, idemKey } from "./harness.js";
import type { TestApp } from "./harness.js";
import { authedHeaders } from "./flows.js";
import { makePdf, multipartBody } from "./png.js";
import type { RouteFixture } from "./route-fixture-types.js";
import { seedSellerOrder } from "./seller-orders-fakes.js";

export const DAY = 86_400_000;
export const VALID_IBAN = "EG380019000500000000263180002";
const PASSKEY = ["otp", "passkey"] as const;

/** A delivered seller order (store A by default) with one line, plus a token for its buyer. delivered_at is relative to the test clock. */
export interface Delivered { readonly id: string; readonly groupId: string; readonly userId: string; readonly lineId: string; readonly token: string; readonly storeId: string }
export const deliveredOrder = async (t: TestApp, o: { daysAgo?: number; storeId?: string; status?: string } = {}): Promise<Delivered> => {
  const storeId = o.storeId ?? t.seed.storeA;
  const so = await seedSellerOrder(t.raw, t.seed, { storeId });
  await t.raw.query("UPDATE seller_orders SET status = $2, delivered_at = $3 WHERE id = $1", [so.id, o.status ?? "DELIVERED", new Date(T0 - (o.daysAgo ?? 2) * DAY).toISOString()]);
  const line = (await t.raw.query<{ id: string }>("SELECT id FROM order_lines WHERE seller_order_id = $1", [so.id])).rows[0];
  return { ...so, lineId: line?.id ?? "", token: await t.mint({ userId: so.userId }), storeId };
};

/** A paid order group with one store-A seller order in `status`, seeded directly (the checkout saga has its own suites), plus a token for its buyer. */
export const paidOrder = async (t: TestApp, status = "PAID"): Promise<{ groupId: string; sellerOrderId: string; userId: string; token: string }> => {
  const so = await seedSellerOrder(t.raw, t.seed, { storeId: t.seed.storeA, status });
  return { groupId: so.groupId, sellerOrderId: so.id, userId: so.userId, token: await t.mint({ userId: so.userId }) };
};

export const returnBody = (d: Delivered, o: { reason?: string; evidence?: string[] } = {}): object => ({
  lines: [{ order_line_id: d.lineId, qty: 1 }], reason_code: o.reason ?? "changed_mind", method: "pickup", resolution: "refund", ...(o.evidence === undefined ? {} : { evidence_media_ids: o.evidence }),
});

export const createReturn = async (t: TestApp, d: Delivered, o: { reason?: string; evidence?: string[] } = {}): Promise<{ status: number; body: { id: string; status: string; code?: string } }> => {
  const r = await t.inject({ method: "POST", url: `/v1/eg/seller-orders/${d.id}/returns`, headers: authedHeaders(t, d.token), payload: returnBody(d, o) });
  return { status: r.statusCode, body: JSON.parse(r.body) as { id: string; status: string; code?: string } };
};

/** A return of a delivered store order, moved by SQL to `status` (the parcel scan that RECEIVES it is a courier/warehouse job). */
export const returnIn = async (t: TestApp, status: string, storeId = t.seed.storeA): Promise<{ d: Delivered; returnId: string; itemId: string }> => {
  const d = await deliveredOrder(t, { storeId });
  const r = await createReturn(t, d);
  if (r.status !== 201) throw new Error(`return failed: ${JSON.stringify(r.body)}`);
  await t.raw.query("UPDATE return_requests SET status = $2, received_at = $3, inspection_due_at = $4 WHERE id = $1", [r.body.id, status, new Date(T0).toISOString(), new Date(T0 + 2 * DAY).toISOString()]);
  const item = (await t.raw.query<{ id: string }>("SELECT id FROM return_items WHERE return_request_id = $1", [r.body.id])).rows[0];
  return { d, returnId: r.body.id, itemId: item?.id ?? "" };
};

export const geoIds = async (t: TestApp): Promise<{ gov: string; city: string }> => {
  const rows = (await t.raw.query<{ code: string; id: string }>("SELECT code, id FROM geo_areas WHERE market_id = 'EG' AND code IN ('CAI', 'CAI-NASR')")).rows;
  return { gov: rows.find((r) => r.code === "CAI")?.id ?? "", city: rows.find((r) => r.code === "CAI-NASR")?.id ?? "" };
};

export const addressBody = async (t: TestApp, o: { landmark?: string; label?: string } = {}): Promise<object> => {
  const g = await geoIds(t);
  return {
    country_code: "EG", ...(o.label === undefined ? {} : { label: o.label }), recipient_name: "منى أحمد", phone_e164: "+201012345678",
    fields: { governorate_id: g.gov, district_id: g.city, street: "شارع مصطفى النحاس", building: "12", floor: "3", landmark: o.landmark ?? "أمام الصيدلية" },
    pin: { lat_e7: 300_500_000, lng_e7: 313_300_000 },
  };
};

export const createAddress = async (t: TestApp, token: string): Promise<{ id: string }> => {
  const r = await t.inject({ method: "POST", url: "/v1/eg/me/addresses", headers: authedHeaders(t, token), payload: await addressBody(t) });
  if (r.statusCode !== 201) throw new Error(`address failed: ${r.body}`);
  return JSON.parse(r.body) as { id: string };
};

/** A user with an active owner row for store A in the database (the team service re-checks the database, not the token). */
export const ownerOfStoreA = async (t: TestApp): Promise<{ userId: string; token: string }> => {
  const s = await t.seller(t.seed.storeA, ["owner"]);
  const at = new Date(T0).toISOString();
  await t.raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [s.userId, at]);
  await t.raw.query(
    `INSERT INTO store_members (id, store_id, market_id, user_id, role_code, status, accepted_at, strong_auth_enrolled_at, strong_auth_method, created_at, updated_at)
     VALUES ($1,$2,'EG',$3,'owner','active',$4,$4,'passkey',$4,$4)`,
    [randomUUID(), t.seed.storeA, s.userId, at],
  );
  return s;
};

export const sellerHeaders = (t: TestApp, token: string, store: string): Record<string, string> => ({ ...bearer(token), "x-store-id": store, "idempotency-key": idemKey(t) });

export const onboardingBody = (): object => ({
  legal_type: "company", legal_name_ar: "شركة النور للتجارة", legal_name_en: "Al Nour Trading", commercial_register_no: `CR-${randomUUID().slice(0, 8)}`, tax_card_no: `TX-${randomUUID().slice(0, 8)}`,
  governorate_code: "CAI", governorate_name_ar: "القاهرة",
});

export const startOnboarding = async (t: TestApp): Promise<{ userId: string; token: string }> => {
  const s = await t.shopper();
  const token = await t.mint({ userId: s.userId, amr: PASSKEY });
  const r = await t.inject({ method: "POST", url: "/v1/eg/seller/onboarding", headers: authedHeaders(t, token), payload: onboardingBody() });
  if (r.statusCode !== 201) throw new Error(`onboarding failed: ${r.body}`);
  return { userId: s.userId, token };
};

export const courierEvents = (events: { eventId: string; awb: string; rawStatus: string; occurredAt: string }[], headers: Record<string, string> = { "x-signature": "valid", "x-timestamp": new Date(T0).toISOString() }): InjectOptions => ({
  method: "POST", url: "/v1/eg/webhooks/couriers/fake", headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify({ events }),
});

/** A SHIPPED seller order with an outbound shipment (awb) for the same buyer. */
export const shippedOrder = async (t: TestApp, awb = `AWB${randomUUID().slice(0, 6)}`): Promise<Delivered & { awb: string; shipmentId: string }> => {
  const d = await deliveredOrder(t, { status: "SHIPPED" });
  await t.raw.query("UPDATE seller_orders SET delivered_at = NULL WHERE id = $1", [d.id]);
  const shipmentId = randomUUID();
  await t.raw.query(
    `INSERT INTO shipments (id, market_id, store_id, user_id, seller_order_ids, courier, service_level, awb, status, declared_weight_g, idempotency_key, last_event_at)
     VALUES ($1,'EG',$2,$3,ARRAY[$4]::uuid[],'fake','standard',$5,'IN_TRANSIT',800,$6,$7)`,
    [shipmentId, d.storeId, d.userId, d.id, awb, randomUUID(), new Date(T0).toISOString()],
  );
  return { ...d, awb, shipmentId };
};

const SELLER_READ = ["warehouse"] as const;
const hdr = (_t: TestApp, token: string, store: string): Record<string, string> => ({ ...bearer(token), "x-store-id": store });

export const POST_ORDER_FIXTURES: Readonly<Record<string, RouteFixture>> = {
  "GET /v1/{market}/geo-areas": {
    happy: () => Promise.resolve({ req: { method: "GET", url: "/v1/eg/geo-areas?level=governorate&limit=50", headers: { "x-device-id": "0f6f1d2e-3c4b-4a59-8e7f-1a2b3c4d5e6f" } }, status: 200 }),
  },
  "GET /v1/{market}/me/addresses": {
    happy: async (t) => {
      const s = await t.shopper();
      await createAddress(t, s.token);
      return { req: { method: "GET", url: "/v1/eg/me/addresses?limit=10", headers: bearer(s.token) }, status: 200 };
    },
  },
  "POST /v1/{market}/me/addresses": {
    happy: async (t) => ({ req: { method: "POST", url: "/v1/eg/me/addresses", headers: authedHeaders(t, (await t.shopper()).token), payload: await addressBody(t) }, status: 201 }),
  },
  "PATCH /v1/{market}/me/addresses/{address_id}": {
    happy: async (t) => {
      const s = await t.shopper();
      const a = await createAddress(t, s.token);
      return { req: { method: "PATCH", url: `/v1/eg/me/addresses/${a.id}`, headers: authedHeaders(t, s.token), payload: await addressBody(t, { label: "العمل" }) }, status: 200 };
    },
    otherTenant: async (t) => {
      const owner = await t.shopper();
      const a = await createAddress(t, owner.token);
      return { method: "PATCH", url: `/v1/eg/me/addresses/${a.id}`, headers: authedHeaders(t, (await t.shopper()).token), payload: await addressBody(t) };
    },
  },
  "POST /v1/{market}/me/addresses/{address_id}/default": {
    happy: async (t) => {
      const s = await t.shopper();
      const a = await createAddress(t, s.token);
      return { req: { method: "POST", url: `/v1/eg/me/addresses/${a.id}/default`, headers: authedHeaders(t, s.token) }, status: 200 };
    },
    otherTenant: async (t) => {
      const owner = await t.shopper();
      const a = await createAddress(t, owner.token);
      return { method: "POST", url: `/v1/eg/me/addresses/${a.id}/default`, headers: authedHeaders(t, (await t.shopper()).token) };
    },
  },
  "DELETE /v1/{market}/me/addresses/{address_id}": {
    happy: async (t) => {
      const s = await t.shopper();
      const a = await createAddress(t, s.token);
      return { req: { method: "DELETE", url: `/v1/eg/me/addresses/${a.id}`, headers: authedHeaders(t, s.token) }, status: 204 };
    },
    otherTenant: async (t) => {
      const owner = await t.shopper();
      const a = await createAddress(t, owner.token);
      return { method: "DELETE", url: `/v1/eg/me/addresses/${a.id}`, headers: authedHeaders(t, (await t.shopper()).token) };
    },
  },
  "GET /v1/{market}/order-groups/{order_group_id}/tracking": {
    happy: async (t) => {
      const o = await paidOrder(t);
      return { req: { method: "GET", url: `/v1/eg/order-groups/${o.groupId}/tracking`, headers: bearer(o.token) }, status: 200 };
    },
    otherTenant: async (t) => {
      const o = await paidOrder(t);
      return { method: "GET", url: `/v1/eg/order-groups/${o.groupId}/tracking`, headers: bearer((await t.shopper()).token) };
    },
  },
  "POST /v1/{market}/order-groups/{order_group_id}/cancel": {
    // An unshipped order is eligible; the cancellation saga is not configured (like production), so the port answers 503 and nothing changes.
    happy: async (t) => {
      const o = await paidOrder(t);
      return { req: { method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, o.token), payload: { reason_code: "changed_mind" } }, status: 503 };
    },
    otherTenant: async (t) => {
      const o = await paidOrder(t);
      return { method: "POST", url: `/v1/eg/order-groups/${o.groupId}/cancel`, headers: authedHeaders(t, (await t.shopper()).token), payload: { reason_code: "changed_mind" } };
    },
  },
  "POST /v1/{market}/seller-orders/{seller_order_id}/returns": {
    happy: async (t) => {
      const d = await deliveredOrder(t);
      return { req: { method: "POST", url: `/v1/eg/seller-orders/${d.id}/returns`, headers: authedHeaders(t, d.token), payload: returnBody(d) }, status: 201 };
    },
    otherTenant: async (t) => {
      const d = await deliveredOrder(t);
      return { method: "POST", url: `/v1/eg/seller-orders/${d.id}/returns`, headers: authedHeaders(t, (await t.shopper()).token), payload: returnBody(d) };
    },
  },
  "GET /v1/{market}/returns": {
    happy: async (t) => {
      const d = await deliveredOrder(t);
      await createReturn(t, d);
      return { req: { method: "GET", url: "/v1/eg/returns?limit=10", headers: bearer(d.token) }, status: 200 };
    },
  },
  "GET /v1/{market}/returns/{return_id}": {
    happy: async (t) => {
      const r = await returnIn(t, "APPROVED");
      return { req: { method: "GET", url: `/v1/eg/returns/${r.returnId}`, headers: bearer(r.d.token) }, status: 200 };
    },
    otherTenant: async (t) => {
      const r = await returnIn(t, "APPROVED");
      return { method: "GET", url: `/v1/eg/returns/${r.returnId}`, headers: bearer((await t.shopper()).token) };
    },
  },
  "POST /v1/{market}/returns/{return_id}/cancel": {
    happy: async (t) => {
      const r = await returnIn(t, "APPROVED");
      return { req: { method: "POST", url: `/v1/eg/returns/${r.returnId}/cancel`, headers: authedHeaders(t, r.d.token), payload: {} }, status: 200 };
    },
    otherTenant: async (t) => {
      const r = await returnIn(t, "APPROVED");
      return { method: "POST", url: `/v1/eg/returns/${r.returnId}/cancel`, headers: authedHeaders(t, (await t.shopper()).token), payload: {} };
    },
  },
  "POST /v1/{market}/returns/{return_id}/dispute": {
    happy: async (t) => {
      const r = await returnIn(t, "REJECTED");
      return { req: { method: "POST", url: `/v1/eg/returns/${r.returnId}/dispute`, headers: authedHeaders(t, r.d.token), payload: { statement: "المنتج كما وصفته ولم يُستخدم" } }, status: 201 };
    },
    otherTenant: async (t) => {
      const r = await returnIn(t, "REJECTED");
      return { method: "POST", url: `/v1/eg/returns/${r.returnId}/dispute`, headers: authedHeaders(t, (await t.shopper()).token), payload: { statement: "x" } };
    },
  },
  "GET /v1/{market}/seller/returns": {
    happy: async (t) => {
      await returnIn(t, "APPROVED");
      const { token } = await t.seller(t.seed.storeA, SELLER_READ);
      return { req: { method: "GET", url: "/v1/eg/seller/returns?limit=10", headers: hdr(t, token, t.seed.storeA) }, status: 200 };
    },
  },
  "GET /v1/{market}/seller/returns/{return_id}": {
    happy: async (t) => {
      const r = await returnIn(t, "APPROVED");
      const { token } = await t.seller(t.seed.storeA, SELLER_READ);
      return { req: { method: "GET", url: `/v1/eg/seller/returns/${r.returnId}`, headers: hdr(t, token, t.seed.storeA) }, status: 200 };
    },
    otherTenant: async (t) => {
      const r = await returnIn(t, "APPROVED", t.seed.storeB);
      const { token } = await t.seller(t.seed.storeA, SELLER_READ);
      return { method: "GET", url: `/v1/eg/seller/returns/${r.returnId}`, headers: hdr(t, token, t.seed.storeA) };
    },
  },
  "POST /v1/{market}/seller/returns/{return_id}/inspect": {
    happy: async (t) => {
      const r = await returnIn(t, "RECEIVED");
      const { token } = await t.seller(t.seed.storeA, SELLER_READ);
      const line = (await t.raw.query<{ id: string }>("SELECT id FROM return_items WHERE return_request_id = $1", [r.returnId])).rows[0];
      return { req: { method: "POST", url: `/v1/eg/seller/returns/${r.returnId}/inspect`, headers: sellerHeaders(t, token, t.seed.storeA), payload: { result: "accepted", lines: [{ return_line_id: line?.id ?? "", condition_received: "as_new", restock_decision: "restock" }] } }, status: 200 };
    },
    otherTenant: async (t) => {
      const r = await returnIn(t, "RECEIVED", t.seed.storeB);
      const { token } = await t.seller(t.seed.storeA, SELLER_READ);
      return { method: "POST", url: `/v1/eg/seller/returns/${r.returnId}/inspect`, headers: sellerHeaders(t, token, t.seed.storeA), payload: { result: "accepted", lines: [] } };
    },
  },
  "POST /v1/{market}/seller/onboarding": {
    happy: async (t) => {
      const s = await t.shopper();
      return { req: { method: "POST", url: "/v1/eg/seller/onboarding", headers: authedHeaders(t, await t.mint({ userId: s.userId, amr: PASSKEY })), payload: onboardingBody() }, status: 201 };
    },
  },
  "GET /v1/{market}/seller/onboarding": {
    happy: async (t) => {
      const s = await startOnboarding(t);
      return { req: { method: "GET", url: "/v1/eg/seller/onboarding", headers: bearer(s.token) }, status: 200 };
    },
  },
  "POST /v1/{market}/seller/onboarding/documents": {
    happy: async (t) => {
      const s = await startOnboarding(t);
      const form = multipartBody({ doc_type: "commercial_register" }, { name: "cr.pdf", type: "application/pdf", data: makePdf() });
      return { req: { method: "POST", url: "/v1/eg/seller/onboarding/documents", headers: { ...authedHeaders(t, s.token), "content-type": form.contentType }, payload: form.payload }, status: 201 };
    },
  },
  "PUT /v1/{market}/seller/onboarding/bank-account": {
    happy: async (t) => {
      const s = await startOnboarding(t);
      return { req: { method: "PUT", url: "/v1/eg/seller/onboarding/bank-account", headers: authedHeaders(t, s.token), payload: { iban: VALID_IBAN, account_name: "شركة النور للتجارة" } }, status: 200 };
    },
  },
  // A fresh application has gaps (documents, IBAN, signatory): the 422 with the gap list is the steady-state answer measured here.
  "POST /v1/{market}/seller/onboarding/submit": {
    happy: async (t) => {
      const s = await startOnboarding(t);
      return { req: { method: "POST", url: "/v1/eg/seller/onboarding/submit", headers: authedHeaders(t, s.token), payload: {} }, status: 422 };
    },
  },
  "GET /v1/{market}/seller/store/members": {
    happy: async (t) => {
      const s = await ownerOfStoreA(t);
      return { req: { method: "GET", url: "/v1/eg/seller/store/members?limit=10", headers: hdr(t, s.token, t.seed.storeA) }, status: 200 };
    },
  },
  "POST /v1/{market}/seller/store/invites": {
    happy: async (t) => {
      const s = await ownerOfStoreA(t);
      return { req: { method: "POST", url: "/v1/eg/seller/store/invites", headers: sellerHeaders(t, s.token, t.seed.storeA), payload: { contact: "+201055550001", role_code: "warehouse" } }, status: 201 };
    },
  },
  "POST /v1/{market}/webhooks/couriers/{courier_code}": {
    // An event for an AWB we never created is acknowledged and ignored: nothing to change, and nothing the courier could fix by retrying.
    happy: () => Promise.resolve({ req: courierEvents([{ eventId: `evt-${randomUUID()}`, awb: "NO-SUCH-AWB", rawStatus: "picked_up", occurredAt: new Date(T0).toISOString() }]), status: 200 }),
    missing: () => ({ method: "POST", url: "/v1/eg/webhooks/couriers/nope", headers: { "content-type": "application/json" }, payload: "{}" }),
  },
};
