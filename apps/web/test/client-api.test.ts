import { describe, expect, it, vi } from "vitest";
import { ApiProblem, browserApi, createBrowserApi } from "../src/lib/client-api";
import { address, cart, ids, m, order, placed, quote, wireCart, wireQuote } from "./shop-fixtures";
import { money } from "@outlet/money";

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });
interface Call { url: string; init: RequestInit }
function harness(reply: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = vi.fn((url: string, init?: RequestInit) => {
    const c = { url, init: init ?? {} };
    calls.push(c);
    return Promise.resolve(reply(c));
  });
  return { api: createBrowserApi("eg", f as unknown as typeof fetch), calls };
}
const body = (c: Call) => JSON.parse(c.init.body as string) as Record<string, unknown>;
const hdr = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k];
const page = (items: unknown[]) => ({ items, next_cursor: null });
const sessionInfo = { user_id: ids.ADDR, is_new_user: true };

describe("createBrowserApi transport", () => {
  it("sends same-origin credentials, JSON accept, and an idempotency key only on mutations", async () => {
    const h = harness(() => res(200, wireCart()));
    await h.api.getCart();
    await h.api.setQty(ids.LINE, 2);
    expect(h.calls[0]?.url).toBe("/api/bff/eg/cart");
    expect(h.calls[0]?.init.credentials).toBe("same-origin");
    expect(hdr(h.calls[0]!, "idempotency-key")).toBeUndefined();
    expect(hdr(h.calls[0]!, "content-type")).toBeUndefined();
    expect(h.calls[0]?.init.body).toBeUndefined();
    expect(hdr(h.calls[1]!, "idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(hdr(h.calls[1]!, "content-type")).toBe("application/json");
    expect(body(h.calls[1]!)).toEqual({ qty: 2 });
  });
  it("maps a non-2xx answer to ApiProblem with status, type tail, Retry-After and body", async () => {
    const h = harness(() => res(429, { type: "https://x/problems/rate-limited" }, { "retry-after": "17" }));
    const e = await h.api.getCart().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e).toMatchObject({ status: 429, type: "rate-limited", retryAfterS: 17, body: { type: "https://x/problems/rate-limited" }, name: "ApiProblem" });
  });
  it("falls back to unknown type and null retry for garbage, empty, or non-positive values", async () => {
    for (const [text, ra] of [["<html>", "0"], ["", "abc"], [JSON.stringify({ type: 5 }), "-3"], [JSON.stringify({ type: "///" }), null]] as const) {
      const h = harness(() => res(500, text, ra === null ? {} : { "retry-after": ra }));
      const e = (await h.api.getCart().catch((x: unknown) => x)) as ApiProblem;
      expect(e.type).toBe("unknown");
      expect(e.retryAfterS).toBeNull();
      expect(e.body).toEqual(text === "" || text === "<html>" ? null : JSON.parse(text));
    }
  });
  it("treats 204 as success with no body (logout, revoke, cancelDelete)", async () => {
    const h = harness(() => res(204, null));
    await expect(h.api.logout()).resolves.toBeUndefined();
    await expect(h.api.revokeSession("s9")).resolves.toBeUndefined();
    await expect(h.api.cancelDelete()).resolves.toBeUndefined();
    expect(h.calls.map((c) => `${c.init.method ?? ""} ${c.url}`)).toEqual(["POST /api/auth/eg/logout", "DELETE /api/bff/eg/me/sessions/s9", "DELETE /api/bff/eg/me/privacy/delete"]);
  });
  it("rejects a 2xx body that violates the schema instead of trusting it", async () => {
    const h = harness(() => res(200, { items_subtotal: "oops" }));
    await expect(h.api.getCart()).rejects.toThrow();
  });
  it("reads the problem type from the served API's urn form", async () => {
    const h = harness(() => res(403, { type: "urn:outlex:problem:under-age", status: 403 }));
    expect(await h.api.getCart().catch((x: unknown) => x)).toMatchObject({ status: 403, type: "under-age" });
  });
  it("surfaces 409 price-changed with the full problem body so the checkout can read body.quote", async () => {
    const problem = { type: "https://x/problems/price-changed", status: 409, quote: wireQuote({ quote_token: "qt-new" }) };
    const h = harness(() => res(409, problem));
    const e = (await h.api.placeOrder({ addressId: ids.ADDR, method: "card", voucherCodes: [], quoteToken: "qt-1", clientTotal: money(86_000n, "EGP"), acceptPriceChange: false, idempotencyKey: "K1" }).catch((x: unknown) => x)) as ApiProblem;
    expect(e).toMatchObject({ status: 409, type: "price-changed" });
    expect((e.body as { quote: { quote_token: string } }).quote.quote_token).toBe("qt-new");
  });
});

describe("createBrowserApi auth", () => {
  it("requestOtp / verifyOtp (phone + optional dob) / passkeys use the auth routes", async () => {
    const h = harness((c) => {
      if (c.url.endsWith("otp-request")) return res(200, { challenge_id: ids.ORDER, resend_after_s: 45, expires_at: "2026-11-08T10:05:00Z" });
      if (c.url.endsWith("passkey-options")) return res(200, { challenge_id: "pk", public_key: { rp: "x" } });
      return res(200, sessionInfo);
    });
    expect(await h.api.requestOtp("+201012345678", "register")).toEqual({ challengeId: ids.ORDER, resendAfterS: 45 });
    expect(body(h.calls[0]!)).toEqual({ phone_e164: "+201012345678", purpose: "register", channel: "sms" });
    expect(await h.api.verifyOtp({ challengeId: "c1", phoneE164: "+201012345678", code: "123456", dob: "2000-01-01" })).toEqual({ isNewUser: true });
    expect(body(h.calls[1]!)).toEqual({ challenge_id: "c1", phone_e164: "+201012345678", code: "123456", dob: "2000-01-01" });
    await h.api.verifyOtp({ challengeId: "c1", phoneE164: "+201012345678", code: "123456" });
    expect(body(h.calls[2]!)).not.toHaveProperty("dob");
    expect(await h.api.passkeyOptions()).toEqual({ challengeId: "pk", publicKey: { rp: "x" } });
    expect(body(h.calls[3]!)).toEqual({});
    expect(await h.api.passkeyVerify("pk", { id: "cred" })).toEqual({ isNewUser: true });
    expect(body(h.calls[4]!)).toEqual({ challenge_id: "pk", credential: { id: "cred" } });
  });
});

describe("createBrowserApi account and privacy", () => {
  const consentWire = { purpose_code: "analytics", purpose_version: 3, granted: true, text_ar: "ع", text_en: "e" };
  const reqWire = { id: ids.ORDER, kind: "export", status: "REQUESTED", due_at: "2026-12-01T00:00:00Z", cooling_until: null, created_at: "2026-11-08T00:00:00Z" };
  it("me, sessions, consents, export, delete and requests hit the right routes and shapes", async () => {
    const h = harness((c) => {
      if (c.url.endsWith("/me")) return res(200, { id: ids.ADDR, phone_masked: "+20 10** ***678", locale: "ar-EG" });
      if (c.url.includes("me/sessions")) return res(200, page([{ id: ids.LINE, platform: "web", ua_family: null, created_at: "2026-11-01T10:00:00Z", last_seen_at: null, current: true }]));
      if (c.url.includes("privacy/consents") && c.init.method === "PATCH") return res(200, { items: [consentWire] });
      if (c.url.includes("privacy/consents")) return res(200, page([consentWire]));
      if (c.url.includes("privacy/requests")) return res(200, page([reqWire]));
      return res(200, reqWire);
    });
    expect(await h.api.me()).toEqual({ phoneMasked: "+20 10** ***678" });
    expect((await h.api.listSessions()).map((s) => s.id)).toEqual([ids.LINE]);
    expect((await h.api.listConsents()).map((c) => c.purpose_code)).toEqual(["analytics"]);
    await h.api.patchConsents([{ code: "analytics", version: 3, granted: true }]);
    expect(body(h.calls[3]!)).toEqual({ changes: [{ purpose_code: "analytics", purpose_version: 3, granted: true }] });
    await h.api.requestExport();
    expect(h.calls[4]?.init.body).toBeUndefined();
    await h.api.requestDelete(true);
    expect(body(h.calls[5]!)).toEqual({ confirm: true, acknowledge_credit_forfeiture: true });
    expect((await h.api.listPrivacyRequests())[0]?.id).toBe(ids.ORDER);
  });
});

describe("createBrowserApi commerce", () => {
  it("cart reads and writes, defect acknowledgement body is snake_cased", async () => {
    const h = harness(() => res(200, wireCart()));
    await h.api.removeLine(ids.LINE);
    await h.api.ackDefects(ids.LINE, { defectCardId: "dc1", version: 2, defectCount: 3 });
    expect(h.calls[0]).toMatchObject({ url: `/api/bff/eg/cart/lines/${ids.LINE}`, init: { method: "DELETE" } });
    expect(h.calls[1]?.url).toBe(`/api/bff/eg/cart/lines/${ids.LINE}/defect-ack`);
    expect(body(h.calls[1]!)).toEqual({ defect_card_id: "dc1", version: 2, defect_count: 3 });
  });
  it("getProductBrief returns null on 404 but rethrows every other problem", async () => {
    const ok = harness(() => res(200, { id: ids.PROD, title_ar: "ت", title_en: null, skus: [{ sku_id: ids.SKU, size_label: "M" }] }));
    expect((await ok.api.getProductBrief(ids.PROD))?.skus[0]?.size_label).toBe("M");
    expect(await harness(() => res(404, { type: "x/not-found" })).api.getProductBrief("nope")).toBeNull();
    await expect(harness(() => res(500, { type: "x/boom" })).api.getProductBrief("p")).rejects.toMatchObject({ status: 500 });
  });
  it("geoAreas sends level and optional parent and drops inactive areas", async () => {
    const area = (id: string, active: boolean) => ({ id, parent_id: null, level: "governorate", name_ar: "ا", name_en: null, active });
    const h = harness(() => res(200, page([area("a", true), area("b", false)])));
    expect((await h.api.geoAreas("governorate")).map((a) => a.id)).toEqual(["a"]);
    await h.api.geoAreas("district", "p 1");
    expect(h.calls[0]?.url).toBe("/api/bff/eg/geo-areas?level=governorate&limit=50");
    expect(h.calls[1]?.url).toBe("/api/bff/eg/geo-areas?level=district&limit=50&parent_id=p+1");
  });
  it("lists and creates addresses, omitting empty floor and apartment", async () => {
    const a = address();
    const h = harness((c) => (c.init.method === "POST" ? res(200, a) : res(200, page([a]))));
    expect(await h.api.listAddresses()).toHaveLength(1);
    const input = { recipientName: "منى", phoneE164: "+201012345678", governorateId: "g1", districtId: "d1", street: "س", building: "1", floor: "", apartment: "", landmark: "ل" };
    await h.api.createAddress(input);
    await h.api.createAddress({ ...input, floor: "3", apartment: "9" });
    const f1 = (body(h.calls[1]!).fields as Record<string, string>);
    const f2 = (body(h.calls[2]!).fields as Record<string, string>);
    expect(f1).not.toHaveProperty("floor");
    expect(f1).not.toHaveProperty("apartment");
    expect(f2).toMatchObject({ floor: "3", apartment: "9", landmark: "ل" });
    expect(body(h.calls[1]!)).toMatchObject({ country_code: "EG", recipient_name: "منى" });
  });
  it("passes the map pin through on edit and makes an address default through its own endpoint", async () => {
    const a = address();
    const h = harness(() => res(200, a));
    const input = { recipientName: "منى", phoneE164: "+201012345678", governorateId: "g1", districtId: "d1", street: "س", building: "1", floor: "", apartment: "", landmark: "ل" };
    await h.api.updateAddress(a.id, { ...input, pin: { lat_e7: 300_000_000, lng_e7: 310_000_000 }, label: "Home" });
    await h.api.makeDefaultAddress(a.id);
    expect(body(h.calls[0]!)).toMatchObject({ pin: { lat_e7: 300_000_000, lng_e7: 310_000_000 }, label: "Home" });
    expect(h.calls[1]?.url).toBe(`/api/bff/eg/me/addresses/${a.id}/default`);
    expect(h.calls[1]?.init.method).toBe("POST");
  });
  it("walletBalance: positive balance, zero balance and API problems all map without throwing, other errors propagate", async () => {
    expect(await harness(() => res(200, { total_available: m(5_000) })).api.walletBalance()).toMatchObject({ amountMinor: 5_000n });
    expect(await harness(() => res(200, { total_available: m(0) })).api.walletBalance()).toBeNull();
    expect(await harness(() => res(403, { type: "x/forbidden" })).api.walletBalance()).toBeNull();
    await expect(harness(() => res(200, { total_available: "bad" })).api.walletBalance()).rejects.not.toBeInstanceOf(ApiProblem);
  });
  it("quote sends store_credit only when positive; placeOrder adds token, wire total, accept flag and the caller's idempotency key", async () => {
    const h = harness((c) => (c.url.endsWith("checkout") ? res(200, JSON.parse(JSON.stringify({ order_group_id: ids.ORDER, status: "PENDING_PAYMENT", client_action: { kind: "none" }, reservation_expires_at: "2026-11-08T12:10:00Z" }))) : res(200, wireQuote())));
    const base = { addressId: ids.ADDR, method: "cod" as const, voucherCodes: ["V1"] };
    await h.api.quote({ ...base, storeCredit: money(0n, "EGP") });
    await h.api.quote({ ...base, storeCredit: money(1_500n, "EGP") });
    await h.api.quote(base);
    expect(body(h.calls[0]!)).toEqual({ address_id: ids.ADDR, payment_method: "cod", voucher_codes: ["V1"] });
    expect(body(h.calls[1]!).store_credit).toEqual({ amount_minor: "1500", currency: "EGP" });
    expect(body(h.calls[2]!)).not.toHaveProperty("store_credit");
    await h.api.placeOrder({ ...base, quoteToken: "qt", clientTotal: money(86_000n, "EGP"), acceptPriceChange: true, idempotencyKey: "KEY-1" });
    await h.api.placeOrder({ ...base, quoteToken: "qt", clientTotal: money(86_000n, "EGP"), acceptPriceChange: false, idempotencyKey: "KEY-2" });
    expect(hdr(h.calls[3]!, "idempotency-key")).toBe("KEY-1");
    expect(body(h.calls[3]!)).toMatchObject({ quote_token: "qt", client_total: { amount_minor: "86000", currency: "EGP" }, accept_price_change: true });
    expect(body(h.calls[4]!)).not.toHaveProperty("accept_price_change");
  });
  it("order group read and COD confirmation", async () => {
    const h = harness(() => res(200, JSON.parse(JSON.stringify(order()))));
    await h.api.getOrderGroup(ids.ORDER).catch(() => undefined);
    await h.api.confirmCod(ids.ORDER, "1234").catch(() => undefined);
    expect(h.calls[0]?.url).toBe(`/api/bff/eg/order-groups/${ids.ORDER}`);
    expect(h.calls[1]?.url).toBe(`/api/bff/eg/order-groups/${ids.ORDER}/cod-confirmation`);
    expect(body(h.calls[1]!)).toEqual({ code: "1234" });
  });
});

describe("browserApi singleton", () => {
  it("is created lazily and reused", () => {
    expect(browserApi()).toBe(browserApi());
  });
  it("fixtures stay parseable", () => {
    expect(cart().groups.length).toBeGreaterThan(0);
    expect(quote().stores.length).toBeGreaterThan(0);
    expect(placed({ kind: "none" }).order_group_id).toBe(ids.ORDER);
  });
});
