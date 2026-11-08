// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiProblem, createBrowserApi } from "../src/lib/client-api";
import { handleAuth, handleProxy, type BffDeps, type BffRequest, type CookieOp } from "../src/server/bff";
// Read-only import of the real API test app: the browser client and the BFF must speak the SERVED API, not a mock (mock-only proof is not proof).
// Loaded lazily so the skipped suite never pulls the API harness in.
import type { TestApp } from "../../api/test/harness";

/**
 * TODO(API_ROUTES_READY): enable (set API_ROUTES_READY=1) once the other builder's routes are merged:
 * addresses CRUD, order tracking on GET order-groups/{id}, cancel before shipping, returns create/list/dispute/cancel.
 * Then tighten the final assertion (the return request) with a delivered-order fixture instead of the not-yet-returnable refusal.
 */
describe.skipIf(!process.env.API_ROUTES_READY)("shop orders: real BFF + real client against the served API", () => {
  let t: TestApp;
  let idemKey: (app: TestApp) => string;
  let phone: () => string;
  beforeAll(async () => {
    const h = await import("../../api/test/harness");
    ({ phone } = await import("../../api/test/flows"));
    idemKey = h.idemKey;
    t = await h.createTestApp();
  });
  afterAll(async () => { await t.close(); });

  const jar = new Map<string, string>();
  const apply = (ops: readonly CookieOp[]): void => { for (const c of ops) { if (c.maxAge === 0) jar.delete(c.name); else jar.set(c.name, c.value); } };
  const deps = (): BffDeps => ({
    apiUrl: "http://api.internal", now: () => t.clock.now,
    fetch: async (url, init) => {
      const u = new URL(url);
      const res = await t.inject({ method: init.method as "GET", url: `${u.pathname}${u.search}`, headers: { ...((init.headers ?? {}) as Record<string, string>) }, ...(init.body === undefined ? {} : { payload: init.body as string }) });
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h.set(k, v);
      return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: h });
    },
  });
  const bffRequest = (method: string, search: string, body: string, key: string | null): BffRequest => ({
    method, host: "shop.test", origin: method === "GET" ? null : "https://shop.test", secFetchSite: "same-origin", contentType: "application/json", acceptLanguage: "ar-EG",
    idempotencyKey: key, userAgent: "contract-test", cookies: Object.fromEntries(jar), search, body,
  });
  /** fetch() as the browser would call it: same-origin /api/bff and /api/auth routes, served by the real BFF handlers. */
  const doFetch: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://shop.test");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    // The client mints UUIDv7 keys from the wall clock; the harness runs a virtual clock, so re-mint one it accepts.
    const key = method === "GET" ? null : idemKey(t);
    const parts = u.pathname.split("/").filter(Boolean); // api, bff|auth, market, ...
    const r = parts[1] === "auth"
      ? await handleAuth(bffRequest(method, u.search, body, key), "eg", parts[3] ?? "", deps())
      : await handleProxy(bffRequest(method, u.search, body, key), "eg", parts.slice(3), deps());
    apply(r.cookies);
    return new Response(r.body, { status: r.status, headers: r.retryAfter === null ? {} : { "retry-after": r.retryAfter } });
  };

  it("address create -> quote -> order -> tracking read -> return request", async () => {
    const api = createBrowserApi("eg", doFetch);
    const p = phone();
    const req = await api.requestOtp(p, "register");
    await api.verifyOtp({ challengeId: req.challengeId, phoneE164: p, code: t.sms.last(), dob: "1990-01-01" });

    const governorate = (await api.geoAreas("governorate"))[0];
    expect(governorate).toBeDefined();
    const city = (await api.geoAreas("city", governorate?.id))[0];
    const districts = city === undefined ? [] : await api.geoAreas("district", city.id);
    const districtId = districts[0]?.id ?? city?.id ?? "";
    const addr = await api.createAddress({ recipientName: "منى", phoneE164: "+201012345678", governorateId: governorate?.id ?? "", districtId, street: "شارع النيل", building: "12", floor: "", apartment: "", landmark: "جنب الصيدلية" });
    expect((await api.listAddresses()).map((a) => a.id)).toContain(addr.id);

    const add = await handleProxy(bffRequest("POST", "", JSON.stringify({ sku_id: t.seed.skuA, qty: 1 }), idemKey(t)), "eg", ["cart", "lines"], deps());
    expect(add.status).toBe(201);
    const q = await api.quote({ addressId: addr.id, method: "cod", voucherCodes: [] });
    expect(q.total.amountMinor).toBeGreaterThan(0n);

    const rawQuote = await handleProxy(bffRequest("POST", "", JSON.stringify({ address_id: addr.id, payment_method: "cod" }), idemKey(t)), "eg", ["checkout", "quote"], deps());
    const echo = (JSON.parse(rawQuote.body ?? "{}") as { quote_echo?: unknown }).quote_echo;
    const placed = await handleProxy(bffRequest("POST", "", JSON.stringify({ quote_token: q.quote_token, ...(echo === undefined ? {} : { quote_echo: echo }), address_id: addr.id, payment_method: "cod", client_total: { amount_minor: q.total.amountMinor.toString(), currency: q.total.currency } }), idemKey(t)), "eg", ["checkout"], deps());
    expect(placed.status).toBe(201);
    const groupId = (JSON.parse(placed.body ?? "{}") as { order_group_id: string }).order_group_id;

    // Tracking is part of the order read (seller_orders[].shipment): it parses through the production schema; null until the store ships.
    const order = await api.getOrderGroup(groupId);
    expect(order.seller_orders.length).toBeGreaterThan(0);
    for (const so of order.seller_orders) { expect(so.shipment === null || typeof so.shipment.status === "string").toBe(true); expect(typeof so.cancellable).toBe("boolean"); }
    expect((await api.listOrders()).items.map((o) => o.id)).toContain(groupId);

    // Not delivered yet, so the server refuses the return; it must be a mapped problem, never a 5xx or a silent success.
    const so = order.seller_orders[0];
    const line = so?.lines[0];
    expect(so).toBeDefined();
    const attempt = await api.createReturn(so?.id ?? "", { lines: [{ orderLineId: line?.id ?? "", qty: 1 }], reasonCode: "changed_mind", method: "pickup", resolution: "refund", evidenceMediaIds: [] }).then(() => "created", (e: unknown) => (e instanceof ApiProblem ? e.status : -1));
    expect([409, 422]).toContain(attempt);
    expect((await api.listReturns()).items).toEqual([]);
  });
});
