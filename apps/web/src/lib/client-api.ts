import { z } from "zod";
import { toWire, type Money } from "@outlet/money";
import { uuidv7 } from "./uuid7";
import {
  addressPageSchema, addressSchema, orderSummaryPageSchema, returnPageSchema, returnRequestSchema, uploadTicketSchema, cartSchema, challengeSchema, checkoutResultSchema, consentListSchema, consentPageSchema, geoPageSchema, meSchema, orderGroupSchema,
  privacyPageSchema, privacyRequestSchema, productBriefSchema, quoteSchema, sessionInfoSchema, sessionPageSchema, walletSchema,
  type Address, type OrderSummary, type ReturnRequest, type Cart, type CheckoutResult, type ConsentState, type GeoArea, type OrderGroup, type PaymentMethod, type PrivacyRequest, type ProductBrief, type Quote, type SessionFamily,
} from "./wire";

/** Non-2xx answer from the API (via the BFF). `type` is the last path segment of the problem `type` URI, e.g. `price-changed` (from `urn:outlex:problem:price-changed` or a URL). */
export class ApiProblem extends Error {
  constructor(readonly status: number, readonly type: string, readonly retryAfterS: number | null, readonly body: unknown) {
    super(`API problem ${String(status)} ${type}`);
    this.name = "ApiProblem";
  }
}

export interface Challenge { readonly challengeId: string; readonly resendAfterS: number }
export interface QuoteInput {
  readonly addressId: string;
  readonly method: PaymentMethod;
  readonly voucherCodes: readonly string[];
  readonly storeCredit?: Money;
}
export interface CheckoutInput extends QuoteInput {
  readonly quoteToken: string;
  readonly clientTotal: Money;
  readonly acceptPriceChange: boolean;
  readonly idempotencyKey: string;
}
export interface NewAddress {
  readonly recipientName: string;
  readonly phoneE164: string;
  readonly governorateId: string;
  readonly districtId: string;
  readonly street: string;
  readonly building: string;
  readonly floor: string;
  readonly apartment: string;
  readonly landmark: string;
  readonly isDefault?: boolean;
}
export interface Page<T> { readonly items: readonly T[]; readonly nextCursor: string | null }
export interface NewReturn {
  readonly lines: readonly { orderLineId: string; qty: number }[];
  readonly reasonCode: string;
  readonly method: "pickup" | "dropoff";
  readonly resolution: "refund" | "exchange";
  readonly refundPreference?: "original" | "store_credit";
  readonly evidenceMediaIds: readonly string[];
}

/** Everything the shopper pages call. The browser implementation talks only to same-origin BFF routes; tests pass stubs. */
export interface ShopperApi {
  requestOtp: (phoneE164: string, purpose: "sign_in" | "register") => Promise<Challenge>;
  /** `dob` is sent for new accounts; the API enforces the 18+ rule (under-age / age-blocked problems). */
  verifyOtp: (input: { challengeId: string; phoneE164: string; code: string; dob?: string }) => Promise<{ isNewUser: boolean }>;
  passkeyOptions: () => Promise<{ challengeId: string; publicKey: Record<string, unknown> }>;
  passkeyVerify: (challengeId: string, credential: Record<string, unknown>) => Promise<{ isNewUser: boolean }>;
  logout: () => Promise<void>;
  me: () => Promise<{ phoneMasked: string }>;
  listSessions: () => Promise<readonly SessionFamily[]>;
  revokeSession: (id: string) => Promise<void>;
  listConsents: () => Promise<readonly ConsentState[]>;
  patchConsents: (changes: readonly { code: string; version: number; granted: boolean }[]) => Promise<readonly ConsentState[]>;
  requestExport: () => Promise<PrivacyRequest>;
  requestDelete: (acknowledgeCreditForfeiture: boolean) => Promise<PrivacyRequest>;
  cancelDelete: () => Promise<void>;
  listPrivacyRequests: () => Promise<readonly PrivacyRequest[]>;
  getCart: () => Promise<Cart>;
  setQty: (lineId: string, qty: number) => Promise<Cart>;
  removeLine: (lineId: string) => Promise<Cart>;
  ackDefects: (lineId: string, ack: { defectCardId: string; version: number; defectCount: number }) => Promise<Cart>;
  getProductBrief: (productId: string) => Promise<ProductBrief | null>;
  geoAreas: (level: "governorate" | "city" | "district", parentId?: string) => Promise<readonly GeoArea[]>;
  listAddresses: () => Promise<readonly Address[]>;
  createAddress: (input: NewAddress) => Promise<Address>;
  updateAddress: (id: string, input: NewAddress) => Promise<Address>;
  deleteAddress: (id: string) => Promise<void>;
  walletBalance: () => Promise<Money | null>;
  quote: (input: QuoteInput) => Promise<Quote>;
  placeOrder: (input: CheckoutInput) => Promise<CheckoutResult>;
  getOrderGroup: (id: string) => Promise<OrderGroup>;
  confirmCod: (id: string, code: string) => Promise<OrderGroup>;
  listOrders: (cursor?: string) => Promise<Page<OrderSummary>>;
  /** Not optimistic: resolves with the server's order after the cancel saga ran. */
  cancelSellerOrder: (orderGroupId: string, sellerOrderId: string, input: { reasonCode: string; refundPreference?: "original" | "store_credit" }) => Promise<OrderGroup>;
  createReturn: (sellerOrderId: string, input: NewReturn) => Promise<ReturnRequest>;
  listReturns: (cursor?: string) => Promise<Page<ReturnRequest>>;
  getReturn: (id: string) => Promise<ReturnRequest>;
  cancelReturn: (id: string) => Promise<ReturnRequest>;
  openDispute: (id: string, input: { statement: string; mediaIds: readonly string[] }) => Promise<void>;
  /** Signed-URL upload (ticket, PUT, complete); resolves with the media id once the server accepted the file. */
  uploadEvidence: (file: File, purpose: "return_evidence" | "dispute_evidence") => Promise<string>;
}

function problemType(body: unknown): string {
  if (typeof body === "object" && body !== null && "type" in body && typeof body.type === "string") return body.type.split(/[/:]/).filter(Boolean).pop() ?? "unknown";
  return "unknown";
}

function parseJson(text: string): unknown {
  try {
    return text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function createBrowserApi(market = "eg", doFetch: typeof fetch = (i, init) => fetch(i, init)): ShopperApi {
  async function call(url: string, method: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey ?? uuidv7();
    const res = await doFetch(url, { method, headers, credentials: "same-origin", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status === 204) return null;
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) {
      const ra = Number(res.headers.get("retry-after"));
      throw new ApiProblem(res.status, problemType(json), Number.isFinite(ra) && ra > 0 ? ra : null, json);
    }
    return json;
  }
  const auth = (action: string, body?: unknown) => call(`/api/auth/${market}/${action}`, "POST", body ?? {});
  const bff = (path: string, method = "GET", body?: unknown, key?: string) => call(`/api/bff/${market}/${path}`, method, body, key);
  const wire = (m: Money) => ({ amount_minor: toWire(m).amountMinor, currency: m.currency });
  const addressBody = (a: NewAddress) => ({
    country_code: "EG", recipient_name: a.recipientName, phone_e164: a.phoneE164, ...(a.isDefault === undefined ? {} : { is_default: a.isDefault }),
    fields: { governorate_id: a.governorateId, district_id: a.districtId, street: a.street, building: a.building, ...(a.floor === "" ? {} : { floor: a.floor }), ...(a.apartment === "" ? {} : { apartment: a.apartment }), landmark: a.landmark },
  });
  const cursorQ = (cursor?: string) => `?limit=20${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
  const quoteBody = (i: QuoteInput) => ({
    address_id: i.addressId, payment_method: i.method, voucher_codes: [...i.voucherCodes], ...(i.storeCredit && i.storeCredit.amountMinor > 0n ? { store_credit: wire(i.storeCredit) } : {}),
  });

  return {
    async requestOtp(phone, purpose) {
      const c = challengeSchema.parse(await auth("otp-request", { phone_e164: phone, purpose, channel: "sms" }));
      return { challengeId: c.challenge_id, resendAfterS: c.resend_after_s };
    },
    async verifyOtp(i) {
      const r = sessionInfoSchema.parse(await auth("otp-verify", { challenge_id: i.challengeId, phone_e164: i.phoneE164, code: i.code, ...(i.dob === undefined ? {} : { dob: i.dob }) }));
      return { isNewUser: r.is_new_user };
    },
    async passkeyOptions() {
      const r = z.object({ challenge_id: z.string(), public_key: z.record(z.string(), z.unknown()) }).parse(await auth("passkey-options"));
      return { challengeId: r.challenge_id, publicKey: r.public_key };
    },
    async passkeyVerify(challengeId, credential) {
      const r = sessionInfoSchema.parse(await auth("passkey-verify", { challenge_id: challengeId, credential }));
      return { isNewUser: r.is_new_user };
    },
    async logout() { await auth("logout"); },
    async me() { return { phoneMasked: meSchema.parse(await bff("me")).phone_masked }; },
    async listSessions() { return sessionPageSchema.parse(await bff("me/sessions?limit=50")).items; },
    async revokeSession(id) { await bff(`me/sessions/${id}`, "DELETE"); },
    async listConsents() { return consentPageSchema.parse(await bff("me/privacy/consents?limit=50")).items; },
    async patchConsents(changes) {
      return consentListSchema.parse(await bff("me/privacy/consents", "PATCH", { changes: changes.map((c) => ({ purpose_code: c.code, purpose_version: c.version, granted: c.granted })) })).items;
    },
    async requestExport() { return privacyRequestSchema.parse(await bff("me/privacy/export", "POST", undefined)); },
    async requestDelete(ack) { return privacyRequestSchema.parse(await bff("me/privacy/delete", "POST", { confirm: true, acknowledge_credit_forfeiture: ack })); },
    async cancelDelete() { await bff("me/privacy/delete", "DELETE"); },
    async listPrivacyRequests() { return privacyPageSchema.parse(await bff("me/privacy/requests?limit=50")).items; },
    async getCart() { return cartSchema.parse(await bff("cart")); },
    async setQty(id, qty) { return cartSchema.parse(await bff(`cart/lines/${id}`, "PATCH", { qty })); },
    async removeLine(id) { return cartSchema.parse(await bff(`cart/lines/${id}`, "DELETE")); },
    async ackDefects(id, a) { return cartSchema.parse(await bff(`cart/lines/${id}/defect-ack`, "POST", { defect_card_id: a.defectCardId, version: a.version, defect_count: a.defectCount })); },
    async getProductBrief(id) {
      try {
        return productBriefSchema.parse(await bff(`products/${id}`));
      } catch (e) {
        if (e instanceof ApiProblem && e.status === 404) return null;
        throw e;
      }
    },
    async geoAreas(level, parentId) {
      const q = new URLSearchParams({ level, limit: "50", ...(parentId === undefined ? {} : { parent_id: parentId }) });
      return geoPageSchema.parse(await bff(`geo-areas?${q.toString()}`)).items.filter((a) => a.active);
    },
    async listAddresses() { return addressPageSchema.parse(await bff("me/addresses?limit=50")).items; },
    async createAddress(a) { return addressSchema.parse(await bff("me/addresses", "POST", addressBody(a))); },
    async updateAddress(id, a) { return addressSchema.parse(await bff(`me/addresses/${id}`, "PATCH", addressBody(a))); },
    async deleteAddress(id) { await bff(`me/addresses/${id}`, "DELETE"); },
    async walletBalance() {
      try {
        const w = walletSchema.parse(await bff("me/wallet"));
        return w.total_available.amountMinor > 0n ? w.total_available : null;
      } catch (e) {
        if (e instanceof ApiProblem) return null;
        throw e;
      }
    },
    async quote(i) { return quoteSchema.parse(await bff("checkout/quote", "POST", quoteBody(i))); },
    async placeOrder(i) {
      const body = { ...quoteBody(i), quote_token: i.quoteToken, client_total: wire(i.clientTotal), ...(i.acceptPriceChange ? { accept_price_change: true } : {}) };
      return checkoutResultSchema.parse(await bff("checkout", "POST", body, i.idempotencyKey));
    },
    async getOrderGroup(id) { return orderGroupSchema.parse(await bff(`order-groups/${id}`)); },
    async confirmCod(id, code) { return orderGroupSchema.parse(await bff(`order-groups/${id}/cod-confirmation`, "POST", { code })); },
    async listOrders(cursor) {
      const r = orderSummaryPageSchema.parse(await bff(`order-groups${cursorQ(cursor)}`));
      return { items: r.items, nextCursor: r.next_cursor };
    },
    async cancelSellerOrder(groupId, soId, i) {
      return orderGroupSchema.parse(await bff(`order-groups/${groupId}/seller-orders/${soId}/cancel`, "POST", { reason_code: i.reasonCode, ...(i.refundPreference === undefined ? {} : { refund_preference: i.refundPreference }) }));
    },
    async createReturn(soId, i) {
      return returnRequestSchema.parse(await bff(`seller-orders/${soId}/returns`, "POST", {
        lines: i.lines.map((l) => ({ order_line_id: l.orderLineId, qty: l.qty })), reason_code: i.reasonCode, method: i.method, resolution: i.resolution,
        ...(i.refundPreference === undefined ? {} : { refund_preference: i.refundPreference }), ...(i.evidenceMediaIds.length === 0 ? {} : { evidence_media_ids: [...i.evidenceMediaIds] }),
      }));
    },
    async listReturns(cursor) {
      const r = returnPageSchema.parse(await bff(`returns${cursorQ(cursor)}`));
      return { items: r.items, nextCursor: r.next_cursor };
    },
    async getReturn(id) { return returnRequestSchema.parse(await bff(`returns/${id}`)); },
    async cancelReturn(id) { return returnRequestSchema.parse(await bff(`returns/${id}/cancel`, "POST", {})); },
    async openDispute(id, i) { await bff(`returns/${id}/dispute`, "POST", { statement: i.statement, ...(i.mediaIds.length === 0 ? {} : { media_ids: [...i.mediaIds] }) }); },
    async uploadEvidence(file, purpose) {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const ticket = uploadTicketSchema.parse(await bff("media/uploads", "POST", { purpose, mime: file.type, bytes: file.size, sha256 }));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(ticket.upload_headers)) if (typeof v === "string") headers[k] = v;
      const put = await doFetch(ticket.upload_url, { method: "PUT", headers, body: file });
      if (!put.ok) throw new ApiProblem(put.status, "upload-failed", null, null);
      await bff(`media/${ticket.media_id}/complete`, "POST", {});
      return ticket.media_id;
    },
  };
}

let shared: ShopperApi | null = null;
/** Lazily created browser API (never at import time, so server rendering has no fetch side effects). */
export function browserApi(): ShopperApi {
  shared ??= createBrowserApi();
  return shared;
}
