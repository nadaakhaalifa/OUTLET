import { vi } from "vitest";
import type { ShopperApi } from "../src/lib/client-api";
import { returnRequestSchema, orderSummarySchema, addressSchema, cartSchema, checkoutResultSchema, consentSchema, geoAreaSchema, orderGroupSchema, privacyRequestSchema, quoteSchema, sessionSchema } from "../src/lib/wire";

/** Real-shaped wire fixtures (docs/api/openapi.yaml), TESTS ONLY, parsed through the production schemas. */
export const m = (minor: number | string, currency = "EGP") => ({ amount_minor: String(minor), currency });
const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
const PROD = "0b7d1f4e-0000-4000-8000-0000000000a1";
const SKU = "0b7d1f4e-0000-4000-8000-0000000000b1";
const LINE = "0b7d1f4e-0000-4000-8000-0000000000c1";
export const ids = { STORE, PROD, SKU, LINE, ADDR: "0b7d1f4e-0000-4000-8000-0000000000d1", ORDER: "0b7d1f4e-0000-4000-8000-0000000000e1" };

const price = (cur: number) => ({ current_price: m(cur), claim_type: "plain", price_proof_path: "/v1/eg/proof/1" });
export const wireLine = (over: Record<string, unknown> = {}) => ({
  id: LINE, sku_id: SKU, product_id: PROD, store_id: STORE, qty: 1, price_at_add: m(80_000), current_price: price(80_000), defect_ack_required: false, saved_for_later: false, available: true, added_at: "2026-11-01T10:00:00Z", ...over,
});
export const wireCart = (lines: Record<string, unknown>[] = [wireLine()], over: Record<string, unknown> = {}) => ({
  id: "0b7d1f4e-0000-4000-8000-0000000000f1", currency: "EGP", version: 1, items_subtotal: m(80_000), notices: [],
  groups: lines.length === 0 ? [] : [{ store_id: STORE, store_slug: "nile-outlet", display_name_ar: "نيل أوتليت", subtotal: m(80_000), free_delivery_threshold: m(200_000), remaining_for_free_delivery: m(120_000), lines }],
  ...over,
});
export const cart = (lines?: Record<string, unknown>[], over?: Record<string, unknown>) => cartSchema.parse(wireCart(lines, over));

export const wireQuote = (over: Record<string, unknown> = {}) => ({
  quote_token: "qt-1", expires_at: "2026-11-08T12:00:00Z", currency: "EGP",
  stores: [{ store_id: STORE, items_subtotal: m(80_000), seller_discount: m(0), platform_discount: m(0), shipping: m(6_000), parcels: [{ store_id: STORE, courier_service_code: "std", chargeable_weight_g: 500, fee: m(6_000), days_min: 2, days_max: 4, free_delivery_applied: false }] }],
  items_subtotal: m(80_000), discount: m(0), shipping: m(6_000), vat_included: m(10_500), store_credit: m(0), total: m(86_000), verified_savings: m(0),
  fees: [{ code: "cod_fee", amount: m(2_500) }],
  payment_options: [{ method: "card", available: true }, { method: "cod", available: true }, { method: "bnpl", available: false, reason_key: "age" }],
  cod_allowed: true, cod_requires_confirmation: true, notices: [], ...over,
});
export const quote = (over?: Record<string, unknown>) => quoteSchema.parse(wireQuote(over));

export const address = (over: Record<string, unknown> = {}) => addressSchema.parse({
  id: ids.ADDR, recipient_name: "منى", phone_e164: "+201012345678", is_default: true,
  fields: { governorate_id: "g1", district_id: "d1", street: "شارع النيل", building: "12", landmark: "جنب الصيدلية" }, ...over,
});
export const geo = (id: string, level: "governorate" | "city" | "district", name: string, parent: string | null = null) => geoAreaSchema.parse({ id, parent_id: parent, level, name_ar: name, name_en: null, active: true });

export const order = (over: Record<string, unknown> = {}) => orderGroupSchema.parse({
  id: ids.ORDER, status: "PENDING_PAYMENT", currency: "EGP", items_subtotal: m(80_000), discount: m(0), shipping: m(6_000), vat: m(10_500), store_credit: m(0), total: m(86_000),
  payment_method: "card", payment_status: "pending", client_action: null, seller_orders: [{ id: "so1", store_display_name_ar: "نيل أوتليت", status: "PENDING_PAYMENT", total: m(86_000) }], ...over,
});
export const placed = (action: Record<string, unknown>, status = "PENDING_PAYMENT") => checkoutResultSchema.parse({ order_group_id: ids.ORDER, status, client_action: action, reservation_expires_at: "2026-11-08T12:10:00Z" });
export const consent = (code: string, granted = false) => consentSchema.parse({ purpose_code: code, purpose_version: 3, granted, text_ar: `موافقة ${code}`, text_en: `Consent ${code}` });
export const session = (over: Record<string, unknown> = {}) => sessionSchema.parse({ id: "s1", platform: "web", ua_family: "Safari", created_at: "2026-11-01T10:00:00Z", last_seen_at: "2026-11-07T10:00:00Z", current: true, ...over });
export const privacyRequest = (over: Record<string, unknown> = {}) => privacyRequestSchema.parse({ id: "p1", kind: "delete", status: "COOLING", due_at: "2026-12-01T00:00:00Z", cooling_until: "2026-11-22T00:00:00Z", created_at: "2026-11-08T00:00:00Z", ...over });

const unset = (name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`));
/** A ShopperApi whose every method rejects unless overridden, so a test fails loudly on an unplanned call. */
export function stubApi(over: Partial<{ [K in keyof ShopperApi]: ShopperApi[K] }> = {}): ShopperApi {
  const names = ["requestOtp", "verifyOtp", "passkeyOptions", "passkeyVerify", "logout", "me", "listSessions", "revokeSession", "listConsents", "patchConsents", "requestExport", "requestDelete", "cancelDelete", "listPrivacyRequests", "getCart", "setQty", "removeLine", "ackDefects", "getProductBrief", "geoAreas", "listAddresses", "createAddress", "updateAddress", "deleteAddress", "makeDefaultAddress", "walletBalance", "quote", "placeOrder", "getOrderGroup", "confirmCod", "listOrders", "cancelSellerOrder", "createReturn", "listReturns", "getReturn", "cancelReturn", "openDispute", "uploadEvidence"] as const;
  const base = Object.fromEntries(names.map((n) => [n, vi.fn(unset(n))])) as unknown as ShopperApi;
  return { ...base, ...over };
}

const SO = "0b7d1f4e-0000-4000-8000-0000000000a5";
export const ids2 = { SO, RETURN: "0b7d1f4e-0000-4000-8000-0000000000b9", ORDER_LINE: "0b7d1f4e-0000-4000-8000-0000000000c9" };
export const wireSellerOrder = (over: Record<string, unknown> = {}) => ({
  id: SO, store_id: STORE, store_display_name_ar: "نيل أوتليت", status: "SHIPPED", items_subtotal: m(80_000), shipping: m(6_000), vat: m(10_500), total: m(86_000),
  lines: [{ id: ids2.ORDER_LINE, sku_id: SKU, product_id: PROD, title_ar_snapshot: "جاكيت", title_en_snapshot: "Jacket", condition_grade_snapshot: "open_box", qty: 1, unit_price: m(80_000), platform_discount: m(0), seller_discount: m(0), vat_rate_bp: 1400, vat: m(9_824), claim_type_snapshot: "plain", status: "SHIPPED" }],
  shipment: { shipment_id: "0b7d1f4e-0000-4000-8000-0000000000aa", status: "IN_TRANSIT", courier_code: "bosta", awb: "AWB123", events: [{ normalized_status: "PICKED_UP", location_text: "Cairo hub", occurred_at: "2026-11-05T10:00:00Z" }, { normalized_status: "IN_TRANSIT", location_text: null, occurred_at: "2026-11-06T10:00:00Z" }], delivered_at: null },
  delivered_at: null, return_window_ends_at: null, cancellable: false, returnable: false, tax_documents: [], ...over,
});
export const orderWith = (so: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => orderGroupSchema.parse({
  id: ids.ORDER, status: "PAID", currency: "EGP", items_subtotal: m(80_000), discount: m(0), shipping: m(6_000), vat: m(10_500), store_credit: m(0), total: m(86_000),
  payment_method: "card", payment_status: "captured", client_action: null, seller_orders: [wireSellerOrder(so)], ...over,
});
export const orderSummary = (id: string, over: Record<string, unknown> = {}) => orderSummarySchema.parse({ id, status: "PAID", total: m(86_000), store_count: 1, placed_at: "2026-11-04T10:00:00Z", ...over });
export const wireReturn = (over: Record<string, unknown> = {}) => ({
  id: ids2.RETURN, seller_order_id: SO, status: "REQUESTED", reason_code: "too_small", fault: "none", window_basis: "no_reason", delivered_at_snapshot: "2026-11-06T10:00:00Z", window_ends_at: "2026-11-20T10:00:00Z",
  method: "pickup", resolution: "exchange", lines: [{ id: "0b7d1f4e-0000-4000-8000-0000000000ba", order_line_id: ids2.ORDER_LINE, qty: 1 }], received_at: null, inspection_due_at: null, refund_due_at: null, created_at: "2026-11-08T09:00:00Z", ...over,
});
export const returnReq = (over?: Record<string, unknown>) => returnRequestSchema.parse(wireReturn(over));
