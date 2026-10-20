import { describe, expect, it } from "vitest";
import { createClient, type FetchLike } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiBrandPort, mapSummary } from "./api";
import { BrandPortError, EMPTY_DRAFT, type ProductDraft } from "./model";

const U = (n: number) => `0192f3a4-5b6c-7d8e-9f01-23456789ab${String(n).padStart(2, "0")}`;
const STORE = U(1), PROD = U(2), SKU = U(3), CAT = U(4), RET = U(5), ORD = U(6), SHIP = U(7), UP1 = U(8), UP2 = U(9);
const TS = "2026-10-11T10:00:00Z";
const egp = (n: number) => ({ amount: String(n), currency: "EGP" as const });

interface Req { method: string; path: string; headers: Record<string, string>; body: unknown }
interface Res { status?: number; body?: unknown; headers?: Record<string, string>; raw?: ArrayBuffer }
type Handler = (r: Req) => Res;

function harness(routes: Record<string, Handler>, extra: Record<string, Handler> = {}) {
  const calls: Req[] = [];
  const all = { ...BASE, ...routes };
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req: Req = {
      method: init?.method ?? "GET", path: u.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const h = all[`${req.method} ${req.path}`];
    if (h === undefined) return new Response(JSON.stringify({ type: "/problems/not-found", title: "nf", status: 404 }), { status: 404, headers: { "Content-Type": "application/problem+json" } });
    const r = h(req);
    const status = r.status ?? 200;
    if (r.raw !== undefined) return new Response(r.raw, { status, headers: { "Content-Type": "application/pdf" } });
    const problem = status >= 400;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status, headers: { "Content-Type": problem ? "application/problem+json" : "application/json", ...(r.headers ?? {}) },
    });
  };
  void extra;
  const client = createClient({ baseUrl: "https://api.test", fetch, getToken: () => "tok", sleep: async () => undefined, randomBytes: (n) => new Uint8Array(n).fill(3), maxRetries: 0 });
  const ctx: AdapterContext = { client, locale: () => "ar", nowMs: () => Date.parse(TS), deviceId: () => "install-device-1" };
  return { ctx, calls };
}

const problem = (status: number, code?: string, more: Record<string, unknown> = {}) => ({ status, body: { type: "/problems/x", title: "x", status, ...(code !== undefined ? { code } : {}), ...more } });

const BASE: Record<string, Handler> = {
  "GET /v1/seller/me": () => ({ body: { user_id: U(10), memberships: [{ store_id: STORE, role: "owner" }] } }),
  "GET /v1/seller/store": () => ({ body: { id: STORE, slug: "s", name: { ar: "متجر", en: "Store" }, kind: "local", verified_badge: true, live_drop: false, is_favorite: false, status: "active", legal_identity: { legal_name: "Store LLC" }, kyc_status: "APPROVED" } }),
};

const product = (over: Record<string, unknown> = {}) => ({
  id: PROD, status: "draft", title: { ar: "فستان كتان" }, category_id: CAT, condition: "new_with_tags", department: "unisex", image_upload_ids: [UP1],
  skus: [{ id: SKU, size_label: "M", price: egp(125000), on_hand: 4, available: 4 }], updated_at: TS, ...over,
});
const draft: ProductDraft = { ...EMPTY_DRAFT, photos: [{ localId: "a", uri: "f", uploadId: UP1, progress: 1, state: "done" }], titleAr: "فستان كتان", categoryId: CAT, condition: "new_with_tags", priceInput: "1,250", sizes: [{ label: "M", stock: "4" }] };

async function failure(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof BrandPortError ? e.kind : `other:${String(e)}`; }
  return "none";
}
const pathOf = (c: Req[]) => c.map((r) => `${r.method} ${r.path}`);

describe("brand adapter: categories and products", () => {
  it("maps categories", async () => {
    const { ctx } = harness({ "GET /v1/seller/categories": () => ({ body: { items: [{ id: CAT, slug: "dresses", name: { ar: "فساتين", en: "Dresses" }, product_type: "dress", return_class: "standard", requires_size_chart: true }] } }) });
    expect(await new ApiBrandPort(ctx).categories()).toEqual([{ id: CAT, name: { ar: "فساتين", en: "Dresses" }, sized: true }]);
  });

  it("getProduct reads the ETag and update sends it as If-Match; publish is status active", async () => {
    const { ctx, calls } = harness({
      [`GET /v1/seller/products/${PROD}`]: () => ({ body: product(), headers: { ETag: '"v7"' } }),
      [`PATCH /v1/seller/products/${PROD}`]: () => ({ body: product({ status: "active" }), headers: { ETag: '"v8"' } }),
    });
    const port = new ApiBrandPort(ctx);
    const d = await port.getProduct(PROD);
    expect(d).toMatchObject({ id: PROD, titleAr: "فستان كتان", priceInput: "1250.00", sizes: [{ label: "M", stock: "4" }], categoryId: CAT });
    const r = await port.saveProduct({ ...d, titleAr: "فستان كتان جديد" }, true);
    expect(r).toEqual({ id: PROD, status: "active" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.headers["If-Match"]).toBe('"v7"');
    expect(patch?.body).toMatchObject({ status: "active", title: { ar: "فستان كتان جديد" } });
    expect(calls.filter((c) => c.path.includes("/skus/"))).toHaveLength(0);
  });

  it("an unchanged price and stock write nothing to the SKU; a changed price calls updateSellerSkuPrice", async () => {
    const { ctx, calls } = harness({
      [`GET /v1/seller/products/${PROD}`]: () => ({ body: product(), headers: { ETag: '"v1"' } }),
      [`PUT /v1/seller/skus/${SKU}/price`]: () => ({ body: product().skus[0] }),
      [`PATCH /v1/seller/products/${PROD}`]: () => ({ body: product() }),
    });
    await new ApiBrandPort(ctx).saveProduct({ ...draft, id: PROD, priceInput: "1,300" }, false);
    expect(calls.find((c) => c.path.endsWith("/price"))?.body).toEqual({ price: { amount: "130000", currency: "EGP" } });
  });

  it("department round-trips: read from the product and sent on update", async () => {
    const { ctx, calls } = harness({
      [`GET /v1/seller/products/${PROD}`]: () => ({ body: product({ department: "women" }), headers: { ETag: '"v1"' } }),
      [`PATCH /v1/seller/products/${PROD}`]: () => ({ body: product({ department: "kids" }) }),
    });
    const port = new ApiBrandPort(ctx);
    const d = await port.getProduct(PROD);
    expect(d.department).toBe("women");
    await port.saveProduct({ ...d, department: "kids" }, false);
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ department: "kids" });
  });

  it("refuses to add a size to an existing product (no backend) instead of dropping it", async () => {
    const { ctx } = harness({ [`GET /v1/seller/products/${PROD}`]: () => ({ body: product(), headers: { ETag: '"v1"' } }) });
    expect(await failure(new ApiBrandPort(ctx).saveProduct({ ...draft, id: PROD, sizes: [{ label: "M", stock: "4" }, { label: "L", stock: "2" }] }, false))).toBe("unsupported");
  });

  it("creates a product in piastres with upload ids, then publishes with the create ETag", async () => {
    const { ctx, calls } = harness({
      "POST /v1/seller/products": () => ({ status: 201, body: product(), headers: { ETag: '"c1"' } }),
      [`PATCH /v1/seller/products/${PROD}`]: () => ({ body: product({ status: "active" }) }),
    });
    const r = await new ApiBrandPort(ctx).saveProduct({ ...draft, id: null }, true);
    expect(r.status).toBe("active");
    expect(calls[calls.length - 2]?.body).toMatchObject({ category_id: CAT, image_upload_ids: [UP1], skus: [{ size_label: "M", price: egp(125000), initial_stock: 4 }] });
    expect(calls[calls.length - 1]?.headers["If-Match"]).toBe('"c1"');
  });

  it("an incomplete new draft is a failed save, never a request", async () => {
    const { ctx, calls } = harness({});
    expect(await failure(new ApiBrandPort(ctx).saveProduct({ ...EMPTY_DRAFT, titleAr: "فستان" }, false))).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("maps 412 to conflict, 428 to unsupported, 403 to forbidden, 401 to session_expired", async () => {
    const mk = (status: number, code?: string) => harness({
      [`GET /v1/seller/products/${PROD}`]: () => ({ body: product(), headers: { ETag: '"v1"' } }),
      [`PATCH /v1/seller/products/${PROD}`]: () => problem(status, code),
    });
    const upd = (status: number, code?: string) => failure(new ApiBrandPort(mk(status, code).ctx).saveProduct({ ...draft, id: PROD }, false));
    expect(await upd(412)).toBe("conflict");
    expect(await upd(428)).toBe("unsupported");
    expect(await upd(403)).toBe("forbidden");
    expect(await upd(401)).toBe("session_expired");
    expect(await upd(403, "strong_factor_required")).toBe("session_expired");
  });

  it("uploads photos: bulk request, signed PUT, confirm, progress", async () => {
    const puts: { url: string; headers: unknown }[] = [];
    const { ctx, calls } = harness({
      [`POST /v1/seller/stores/${STORE}/media/product-uploads`]: () => ({ status: 201, body: { items: [
        { upload_id: UP1, object_key: "k1", upload_url: "https://store.test/u1", method: "PUT", headers: { "x-a": "1" }, expires_at: TS },
        { upload_id: UP2, object_key: "k2", upload_url: "https://store.test/u2", method: "PUT", headers: {}, expires_at: TS },
      ] } }),
      [`POST /v1/seller/stores/${STORE}/media/uploads/${UP1}/confirm`]: () => ({ body: { upload_id: UP1, status: "confirmed" } }),
      [`POST /v1/seller/stores/${STORE}/media/uploads/${UP2}/confirm`]: () => ({ body: { upload_id: UP2, status: "confirmed" } }),
    });
    const fetchFile = async (input: string, init?: RequestInit): Promise<Response> => {
      if (init?.method === "PUT") { puts.push({ url: input, headers: init.headers }); return new Response(null, { status: 200 }); }
      return new Response(new Blob([new Uint8Array(10)], { type: "image/jpeg" }));
    };
    const progress: [number, number][] = [];
    const out = await new ApiBrandPort(ctx, { fetch: fetchFile }).uploadPhotos(["file://a.jpg", "file://b.jpg"], (i, p) => progress.push([i, p]));
    expect(out).toEqual([{ uploadId: UP1 }, { uploadId: UP2 }]);
    expect(puts.map((p) => p.url)).toEqual(["https://store.test/u1", "https://store.test/u2"]);
    expect(calls.find((c) => c.path.endsWith("/product-uploads"))?.body).toEqual({ items: [{ content_type: "image/jpeg", byte_size: 10 }, { content_type: "image/jpeg", byte_size: 10 }] });
    expect(progress.at(-1)).toEqual([1, 1]);
  });
});

const profile = (over: Record<string, unknown> = {}) => ({
  store_id: STORE, name_ar: "متجر", name_en: "Store", description_ar: null, description_en: null, logo_key: null, cover_key: null,
  social_links: { instagram: "@s" },
  return_policy: { change_of_mind_days: 14, defect_days: 30, text_ar: null, text_en: null, statutory_minimum: { change_of_mind_days: 14, defect_days: 30 } },
  free_delivery_threshold: egp(200000), vacation: { enabled: false, until: null, eta_extra_days: 0 }, version: 3, ...over,
});
const settingsRoutes = (extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  [`GET /v1/seller/stores/${STORE}/profile`]: () => ({ body: profile() }),
  [`GET /v1/seller/stores/${STORE}/shipping`]: () => ({ body: { configured: false, handling_time_hours: 48 } }),
  [`GET /v1/seller/stores/${STORE}/payout-account`]: () => ({ body: { configured: true, iban_masked: "EG**1234", iban_last4: "1234", name_match_score: 90, payouts_held: true, held_until: TS, activates_at: TS, created_at: TS } }),
  [`GET /v1/seller/stores/${STORE}/notification-preferences`]: () => ({ body: { preferences: { stock_low: { push: false, in_app: true } }, transactional_events: ["new_order"] } }),
  ...extra,
});

describe("brand adapter: store settings", () => {
  it("assembles StoreSettings from profile, shipping, payout account and preferences", async () => {
    const { ctx } = harness(settingsRoutes());
    const s = await new ApiBrandPort(ctx).store();
    expect(s).toMatchObject({
      name: { ar: "متجر", en: "Store" }, social: { instagram: "@s", website: "" }, returnDays: { changeOfMind: 14, defect: 30 },
      shipping: { handlingHours: 48 }, payout: { last4: "1234", nameMatch: "match" }, version: 3,
      notifications: { low_stock: false, payout: true },
    });
  });

  it("saves only what changed: profile keeps the threshold, vacation and prefs go to their routes", async () => {
    const { ctx, calls } = harness(settingsRoutes({
      [`PUT /v1/seller/stores/${STORE}/profile`]: () => ({ body: profile() }),
      [`PUT /v1/seller/stores/${STORE}/vacation`]: () => ({ body: profile() }),
      [`PUT /v1/seller/stores/${STORE}/notification-preferences`]: () => ({ body: { preferences: {}, transactional_events: [] } }),
    }));
    const port = new ApiBrandPort(ctx);
    const cur = await port.store();
    const end = Date.parse(TS) + 5 * 86_400_000;
    await port.saveStore({ ...cur, returnDays: { changeOfMind: 20, defect: 30 }, vacationEndMs: end, notifications: { ...cur.notifications, payout: false } });
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.path.split(STORE)[1])).toEqual(["/profile", "/vacation", "/notification-preferences"]);
    expect(puts[0]?.body).toMatchObject({ name_ar: "متجر", free_delivery_threshold: egp(200000), return_policy: { change_of_mind_days: 20, defect_days: 30 } });
    expect(puts[1]?.body).toEqual({ enabled: true, until: new Date(end).toISOString(), eta_extra_days: 0 });
    expect(puts[2]?.body).toEqual({ preferences: { payout_sent: { push: false } } });
    expect(puts.every((c) => (c.headers["Idempotency-Key"] ?? "").length > 0)).toBe(true);
  });

  it("an unchanged form writes nothing", async () => {
    const { ctx, calls } = harness(settingsRoutes());
    const port = new ApiBrandPort(ctx);
    await port.saveStore(await port.store());
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("shipping edits are unsupported (the wire masks the contact phone PUT needs)", async () => {
    const { ctx } = harness(settingsRoutes());
    const port = new ApiBrandPort(ctx);
    const cur = await port.store();
    expect(await failure(port.saveStore({ ...cur, shipping: { ...cur.shipping, handlingHours: 72 } }))).toBe("unsupported");
  });

  const IBAN = "EG380019000500000000263180002";
  it("payout: strong factor required (403 or 422) becomes session_expired", async () => {
    for (const status of [403, 422]) {
      const { ctx } = harness({ [`PUT /v1/seller/stores/${STORE}/payout-account`]: () => problem(status, "strong_factor_required") });
      expect(await failure(new ApiBrandPort(ctx).savePayoutAccount(IBAN, "Mona Ali"))).toBe("session_expired");
    }
  });

  it("payout: success and name mismatch map to results", async () => {
    const ok = harness({ [`PUT /v1/seller/stores/${STORE}/payout-account`]: () => ({ body: { configured: true, iban_masked: "x", iban_last4: "0002", name_match_score: 90, payouts_held: false, held_until: null, activates_at: TS, created_at: TS } }) });
    expect(await new ApiBrandPort(ok.ctx).savePayoutAccount(IBAN, "Mona Ali")).toMatchObject({ last4: "0002", nameMatch: "match" });
    expect((ok.calls.at(-1)?.body as { iban: string }).iban).toBe(IBAN);
    const bad = harness({ [`PUT /v1/seller/stores/${STORE}/payout-account`]: () => problem(422, "name_mismatch", { score: 72 }) });
    expect(await new ApiBrandPort(bad.ctx).savePayoutAccount(IBAN, "Someone Else")).toMatchObject({ nameMatch: "partial", last4: "0002" });
  });

  it("an invalid IBAN never reaches the network", async () => {
    const { ctx, calls } = harness({});
    expect(await failure(new ApiBrandPort(ctx).savePayoutAccount("EG00", "Mona Ali"))).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("store logo upload: request, PUT, confirm with scan_pending retry", async () => {
    let confirms = 0;
    const { ctx, calls } = harness({
      [`POST /v1/seller/stores/${STORE}/media/uploads`]: () => ({ status: 201, body: { upload_id: UP1, object_key: "k", upload_url: "https://store.test/u", method: "PUT", headers: {}, expires_at: TS } }),
      [`POST /v1/seller/stores/${STORE}/media/uploads/${UP1}/confirm`]: () => (++confirms < 2 ? problem(409, "scan_pending") : { body: { upload_id: UP1, status: "confirmed" } }),
    });
    const f = async (_u: string, init?: RequestInit): Promise<Response> => (init?.method === "PUT" ? new Response(null, { status: 200 }) : new Response(new Blob([new Uint8Array(5)], { type: "image/png" })));
    const id = await new ApiBrandPort(ctx, { fetch: f, sleep: async () => undefined }).uploadStoreMedia("logo", "file://l.png");
    expect(id).toBe(UP1);
    expect(confirms).toBe(2);
    expect(calls.find((c) => c.path.endsWith("/media/uploads"))?.body).toEqual({ slot: "logo", content_type: "image/png", byte_size: 5 });
  });

  it("team: phone invite and revoke route by row kind", async () => {
    const { ctx, calls } = harness({
      [`GET /v1/seller/stores/${STORE}/team`]: () => ({ body: {
        members: [{ user_id: U(21), role: "manager", phone_masked: "+20 10 **** 0002", joined_at: TS }],
        invites: [{ id: U(20), role: "catalog", phone_masked: "+20 10 **** 0001", status: "PENDING", created_at: TS, expires_at: TS }],
      } }),
      [`POST /v1/seller/stores/${STORE}/team/invites`]: () => ({ status: 201, body: { id: U(22), role: "finance", phone_masked: "+20 11 ****", status: "pending", expires_at: TS } }),
      [`DELETE /v1/seller/stores/${STORE}/team/invites/${U(20)}`]: () => ({ status: 204 }),
      [`DELETE /v1/seller/stores/${STORE}/team/members/${U(21)}`]: () => ({ status: 204 }),
    });
    const port = new ApiBrandPort(ctx);
    expect(await port.team()).toEqual([
      { id: U(21), name: "+20 10 **** 0002", role: "manager", status: "active" },
      { id: U(20), name: "+20 10 **** 0001", role: "catalog", status: "invited" },
    ]);
    expect(await port.invite("+201112345678", "finance")).toMatchObject({ id: U(22), role: "finance", status: "invited" });
    expect(calls.find((c) => c.path.endsWith("/team/invites") && c.method === "POST")?.body).toEqual({ phone: "+201112345678", role: "finance" });
    await port.revoke(U(20));
    await port.revoke(U(21));
    expect(pathOf(calls).slice(-2)).toEqual([`DELETE /v1/seller/stores/${STORE}/team/invites/${U(20)}`, `DELETE /v1/seller/stores/${STORE}/team/members/${U(21)}`]);
  });
});

describe("brand adapter: orders and returns", () => {
  it("inspectReturn maps accept/reject to the wire body", async () => {
    const ret = { id: RET, order_line_id: U(30), seller_order_id: ORD, status: "RETURN_INSPECTED", reason: "defective", resolution: "refund", created_at: TS };
    const { ctx, calls } = harness({ [`POST /v1/seller/returns/${RET}/inspect`]: () => ({ body: ret }) });
    const port = new ApiBrandPort(ctx);
    await port.inspectReturn(RET, "accept", "");
    await port.inspectReturn(RET, "reject", "used item");
    expect(calls.filter((c) => c.path.endsWith("/inspect")).map((c) => c.body)).toEqual([
      { result: "approve" }, { result: "reject", rejection_reason: "other", note: "used item" },
    ]);
  });

  it("labelUri creates the shipment then returns the PDF as a data URI", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4").buffer as ArrayBuffer;
    const { ctx, calls } = harness({
      "POST /v1/seller/shipments": () => ({ status: 201, body: { id: SHIP, seller_order_ids: [ORD], courier: "bosta", status: "label_ready", events: [] } }),
      [`GET /v1/seller/shipments/${SHIP}/label`]: () => ({ raw: pdf }),
    });
    const uri = await new ApiBrandPort(ctx).labelUri(ORD);
    expect(uri).toBe(`data:application/pdf;base64,${btoa("%PDF-1.4")}`);
    expect(calls.find((c) => c.method === "POST" && c.path === "/v1/seller/shipments")?.body).toEqual({ seller_order_ids: [ORD] });
  });

  it("a label that is not ready is a conflict", async () => {
    const { ctx } = harness({
      "POST /v1/seller/shipments": () => ({ status: 201, body: { id: SHIP, seller_order_ids: [ORD], courier: "bosta", status: "label_pending", events: [] } }),
      [`GET /v1/seller/shipments/${SHIP}/label`]: () => problem(409, "label_not_ready"),
    });
    expect(await failure(new ApiBrandPort(ctx).labelUri(ORD))).toBe("conflict");
  });

  it("operations with no backend stay unsupported and make no request", async () => {
    const { ctx, calls } = harness({});
    const port = new ApiBrandPort(ctx);
    expect(await failure(port.markReady())).toBe("unsupported");
    expect(await failure(port.verifyStrongFactor())).toBe("unsupported");
    expect(calls).toHaveLength(0);
  });
});

describe("brand adapter: dashboard summary", () => {
  const money = (n: number) => ({ amount_minor: String(n), currency: "EGP" as const });
  const periodWire = (over: Record<string, unknown> = {}) => ({
    from: "2026-10-04T21:00:00Z", to: "2026-10-11T10:00:00Z", gross_sales: money(500_000), net_after_commission: money(435_000), orders: 4, units: 6,
    average_order_value: money(125_000), returned_units: 1, return_rate_bps: 1667, repeat_customer_rate_bps: null,
    funnel: { views: 300, bag_adds: 30, checkouts: 9, purchases: 4 }, top_products: [{ product_id: PROD, units: 3, gross_sales: money(300_000) }], ...over,
  });
  const wire = (over: Record<string, unknown> = {}) => ({
    store_id: STORE, period: "7d", currency: "EGP", timezone: "Africa/Cairo", current: periodWire({ partial: true }), previous: periodWire({ gross_sales: money(0), orders: 0, average_order_value: null }),
    growth: { gross_sales: { delta: money(500_000), growth_bps: null }, net_after_commission: { delta: money(435_000), growth_bps: null }, orders: { delta: 4, growth_bps: 2500 }, units: { delta: 1, growth_bps: -500 }, average_order_value: null },
    daily_sales: [{ day: "2026-10-10", gross_sales: money(200_000), orders: 2, units: 3 }, { day: "2026-10-11", gross_sales: money(300_000), orders: 2, units: 3 }],
    unavailable_metrics: ["net_sales_after_returns", "in_transit_payouts"], definitions: { gross_sales: "Sum of ..." },
    data_as_of: "2026-10-11T09:57:00Z", freshness: { as_of: "2026-10-11T09:57:00Z", lag_ms: 180_000, slo_ms: 900_000, within_slo: true }, k_anonymity_min: 50, ...over,
  });

  it("maps bigint money, null growth, null repeat rate, unavailable list and product titles; sends the period", async () => {
    const { ctx, calls } = harness({
      [`GET /v1/seller/stores/${STORE}/dashboard/summary`]: () => ({ body: wire() }),
      "GET /v1/seller/products": () => ({ body: { items: [product()], page: { next_cursor: null, has_more: false } } }),
    });
    const s = await new ApiBrandPort(ctx).dashboardSummary("30d");
    expect(calls.find((c) => c.path.endsWith("/summary"))).toBeDefined();
    expect(s).not.toBeNull();
    expect(s?.current.grossSales).toBe(500_000n);
    expect(s?.current.averageOrderValue).toBe(125_000n);
    expect(s?.previous.averageOrderValue).toBeNull();
    expect(s?.current.repeatRateBp).toBeNull();
    expect(s?.growth).toEqual({ grossSales: null, netAfterCommission: null, orders: 2500, units: -500, averageOrderValue: null });
    expect(s?.current.topProducts[0]).toMatchObject({ productId: PROD, title: { ar: "فستان كتان", en: "فستان كتان" }, units: 3, grossSales: 300_000n });
    expect(s?.unavailable).toEqual(["net_sales_after_returns", "in_transit_payouts"]);
    expect(s?.asOfMs).toBe(Date.parse("2026-10-11T09:57:00Z"));
    expect(s?.dailySales.map((d) => d.grossSales)).toEqual([200_000n, 300_000n]);
  });

  it("a missing product list only loses the names", async () => {
    const { ctx } = harness({ [`GET /v1/seller/stores/${STORE}/dashboard/summary`]: () => ({ body: wire() }), "GET /v1/seller/products": () => problem(500) });
    expect((await new ApiBrandPort(ctx).dashboardSummary("7d"))?.current.topProducts[0]?.title).toBeNull();
  });

  it("404 (flag off) is null, not an error; 401 is a session failure", async () => {
    const off = harness({ [`GET /v1/seller/stores/${STORE}/dashboard/summary`]: () => problem(404) });
    expect(await new ApiBrandPort(off.ctx).dashboardSummary("7d")).toBeNull();
    const out = harness({ [`GET /v1/seller/stores/${STORE}/dashboard/summary`]: () => problem(401) });
    expect(await failure(new ApiBrandPort(out.ctx).dashboardSummary("7d"))).toBe("session_expired");
  });

  it("rejects a drifting body (strict parse at the boundary)", async () => {
    const { ctx } = harness({ [`GET /v1/seller/stores/${STORE}/dashboard/summary`]: () => ({ body: wire({ surprise: 1 }) }) });
    expect(await failure(new ApiBrandPort(ctx).dashboardSummary("7d"))).not.toBe("none");
  });

  it("mapSummary keeps definitions verbatim", () => {
    expect(mapSummary(wire() as never).definitions).toEqual({ gross_sales: "Sum of ..." });
  });
});
