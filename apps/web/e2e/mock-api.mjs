// TEST-ONLY mock of apps/api (real response shapes, fixture content). Never used outside Playwright.
import { createServer } from "node:http";
import { URL } from "node:url";

const store = {
  id: "0b7d1f4e-0000-4000-8000-000000000001", slug: "nile-outlet", display_name_ar: "نيل أوتليت", display_name_en: "Nile Outlet", tagline_ar: "ملابس بأسعار مخفضة", tagline_en: "Clearance clothing",
  kind: "local", status: "ACTIVE", verified_badge: true, followers_count: 12, discount_display_mode: "public", canonical_path: "/stores/nile-outlet",
};
const items = Array.from({ length: 24 }, (_, i) => ({
  product_id: `prod${i}`, sku_id: `sku${i}`, store_id: store.id, store_slug: store.slug, title_ar: `جاكيت ${i}`, title_en: `Jacket ${i}`, image: null,
  condition_grade_code: "open_box", defect_count: 0, availability: "in_stock", canonical_path: `/p/prod${i}`,
  price: { current_price: { amount_minor: "80000", currency: "EGP" }, claim_type: "plain", price_proof_path: `/v1/eg/proof/${i}` },
}));

const catId = "6f1c1f0e-0000-4000-8000-000000000009";
const card = (slug, ar, en, kind) => ({
  id: `0b7d1f4e-0000-4000-8000-0000000001${slug.length}`, slug, display_name_ar: ar, display_name_en: en, tagline_ar: null, tagline_en: null, kind, verified_badge: false,
  storefront: { template_code: "default", palette: {}, published_version: 1 }, live_drop: false, followers_count: 0, discount_display_mode: "public", art: null, canonical_path: `/stores/${slug}`,
});
const stores = [
  card("nile-outlet", "نيل أوتليت", "Nile Outlet", "local"),
  ...Array.from({ length: 19 }, (_, i) => card(`store-${String(i).padStart(2, "0")}`, `متجر ${i}`, `Store ${i}`, i % 2 === 0 ? "global" : "local")),
].sort((a, b) => (a.slug < b.slug ? -1 : 1));
const categories = [
  { id: catId, parent_id: null, code: "fashion", path: "fashion", depth: 0, vertical: "fashion", name: "أزياء", slug: "fashion", name_ar: "أزياء", name_en: "Fashion" },
];
const legal = { legal_name_ar: "نيل للتجارة ش.م.م", legal_name_en: "Nile Trading LLC", commercial_register_no: "CR-12345", tax_card_no: "TC-67890", governorate_name_ar: "القاهرة" };
const detail = {
  id: "prod0", store: { ...store, ships_from_country: "EG", storefront: { template_code: "default", palette: {}, published_version: 1 }, legal_identity: legal }, brand_name: null,
  primary_category_id: catId, status: "PUBLISHED", title_ar: "جاكيت 0", title_en: "Jacket 0", description_ar: "جاكيت شتوي بحالة ممتازة", description_en: "Winter jacket in excellent condition",
  condition_grade: { code: "open_box", label_ar: "علبة مفتوحة", label_en: "Open box", schema_org_condition: "https://schema.org/NewCondition" },
  defect_card: null, attributes: {}, colour_code: null, canonical_path: "/p/prod0", published_at: "2026-01-01T00:00:00Z",
  skus: [{ sku_id: "sku0", option_values: {}, size_label: "M", price: items[0].price, availability: "in_stock" }],
};
const verifiedDeal = {
  ...items[1], price: { current_price: { amount_minor: "40000", currency: "EGP" }, claim_type: "verified_discount", reference_price: { amount_minor: "100000", currency: "EGP" }, price_proof_path: "/v1/eg/proof/1" },
};

const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { resolve(b === "" ? {} : JSON.parse(b)); } catch { resolve({}); } }); });
const handleShopper = createShopperMock();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/health") return void res.end("{}");
  if (await handleShopper(req, res, url, readBody)) return;
  if (url.pathname === "/v1/eg/stores") {
    const world = url.searchParams.get("world") ?? "both";
    const after = url.searchParams.get("cursor");
    const limit = Number(url.searchParams.get("limit") ?? "20");
    const rows = stores.filter((s) => (world === "both" || s.kind === world) && (after === null || s.slug > after));
    const page = rows.slice(0, limit);
    return void res.end(JSON.stringify({ items: page, next_cursor: rows.length > limit ? page[page.length - 1].slug : null }));
  }
  if (url.pathname === "/v1/eg/categories") return void res.end(JSON.stringify({ items: categories, next_cursor: null }));
  if (url.pathname === "/v1/eg/products/prod0") return void res.end(JSON.stringify(detail));
  if (url.pathname === "/v1/eg/deals") return void res.end(JSON.stringify({ items: url.searchParams.get("band") === "70_60" ? [verifiedDeal] : [], next_cursor: null }));
  if (url.pathname === "/v1/eg/stores/nile-outlet") return void res.end(JSON.stringify(store));
  if (url.pathname === "/v1/eg/stores/nile-outlet/products") return void res.end(JSON.stringify({ items, next_cursor: null }));
  res.statusCode = 404;
  res.end(JSON.stringify({ title: "not found" }));
}).listen(3101);

// ---- Shopper surface (auth, bag, checkout, orders, account): in-memory, TEST ONLY. Mirrors the SERVED API (apps/api, openapi.generated.yaml): device registration, strict bodies, UUIDv7 keys, urn problem types. ----
function createShopperMock() {
  const ACCESS = "at-1";
  const REFRESH = "rt-1";
  const LINE = "0b7d1f4e-0000-4000-8000-0000000000c1";
  const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
  const money = (n) => ({ amount_minor: String(n), currency: "EGP" });
  const fresh = () => ({ qty: 1, bump: false, addresses: [], orders: new Map(), consents: { analytics: false, marketing_push: false, personalization: false }, deleteRequest: null, seeded: new Map(), returns: [], uploads: new Set(), sessions: [{ id: "s1", device_id: "d1", platform: "web", ua_family: "Chrome", amr: ["otp"], created_at: "2026-11-01T10:00:00Z", last_seen_at: "2026-11-08T09:00:00Z", current: true }, { id: "s2", device_id: "d2", platform: "ios", ua_family: null, amr: ["otp"], created_at: "2026-10-01T10:00:00Z", last_seen_at: "2026-11-02T09:00:00Z", current: false }], checkoutBodies: [] });
  let st = fresh();
  const send = (res, status, body, headers = {}) => { for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.statusCode = status; res.end(body === null ? "" : JSON.stringify(body)); return true; };
  const problem = (res, status, type, extra = {}, headers = {}) => send(res, status, { type: `urn:outlex:problem:${type}`, title: type, status, ...extra }, { "content-type": "application/problem+json", ...headers });
  const devices = new Set();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const strict = (body, allowed, required) => Object.keys(body).every((k) => allowed.includes(k)) && required.every((k) => body[k] !== undefined);
  const ageOf = (dob) => { const [y, m, d] = dob.split("-").map(Number); const n = new Date(); let a = n.getUTCFullYear() - y; if (n.getUTCMonth() + 1 < m || (n.getUTCMonth() + 1 === m && n.getUTCDate() < d)) a -= 1; return a; };
  const pair = (isNew) => ({ access_token: ACCESS, access_expires_at: new Date(Date.now() + 600_000).toISOString(), refresh_token: REFRESH, refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(), token_type: "Bearer", amr: ["otp"], user_id: "0b7d1f4e-0000-4000-8000-0000000000aa", is_new_user: isNew });
  const itemsTotal = () => st.qty * 80_000 + (st.bump ? 4_000 : 0);
  const cartBody = () => ({
    id: "0b7d1f4e-0000-4000-8000-0000000000f1", currency: "EGP", version: 1, items_subtotal: money(st.qty * 80_000), notices: [],
    groups: [{ store_id: STORE, store_slug: "nile-outlet", display_name_ar: "نيل أوتليت", subtotal: money(st.qty * 80_000), free_delivery_threshold: money(200_000), remaining_for_free_delivery: money(Math.max(0, 200_000 - st.qty * 80_000)),
      lines: [{ id: LINE, sku_id: "sku0", product_id: "prod0", store_id: STORE, qty: st.qty, price_at_add: money(90_000), current_price: { current_price: money(80_000), claim_type: "plain", price_proof_path: "/v1/eg/proof/0" }, defect_ack_required: false, saved_for_later: false, available: true, added_at: "2026-11-01T10:00:00Z" }] }],
  });
  const quoteBody = (method) => {
    const items = itemsTotal();
    const shipping = items >= 200_000 ? 0 : 6_000;
    const fees = method === "cod" ? [{ code: "cod_fee", amount: money(2_500) }] : [];
    const total = items + shipping + (method === "cod" ? 2_500 : 0);
    return {
      quote_token: st.bump ? "qt-bumped" : "qt-1", expires_at: new Date(Date.now() + 600_000).toISOString(), currency: "EGP",
      stores: [{ store_id: STORE, items_subtotal: money(items), seller_discount: money(0), platform_discount: money(0), shipping: money(shipping), parcels: [{ store_id: STORE, courier_service_code: "std", chargeable_weight_g: 500, fee: money(shipping), days_min: 2, days_max: 4, free_delivery_applied: shipping === 0 }] }],
      items_subtotal: money(items), discount: money(0), shipping: money(shipping), vat_included: money(Math.round((total * 14) / 114)), store_credit: money(0), total: money(total), verified_savings: money(0), fees,
      payment_options: [{ method: "card", available: true }, { method: "cod", available: true }, { method: "bnpl", available: false, reason_key: "age" }], cod_allowed: true, cod_requires_confirmation: true, notices: [],
    };
  };
  const orderBody = (o) => {
    o.polls += 1;
    const status = o.method === "card" ? (o.polls >= 2 ? "PAID" : "PENDING_PAYMENT") : "CONFIRMED_COD";
    const q = o.quote;
    return {
      id: o.id, status, currency: "EGP", items_subtotal: q.items_subtotal, discount: q.discount, shipping: q.shipping, vat: q.vat_included, store_credit: q.store_credit, total: q.total, payment_method: o.method, payment_status: status === "PAID" ? "captured" : "pending",
      client_action: o.method === "cod" && !o.confirmed ? { kind: "cod_confirmation" } : null, seller_orders: [{ id: "so-1", store_display_name_ar: "نيل أوتليت", status, total: q.total }],
    };
  };
  const SEED = { cancellable: "0b7d1f4e-0000-4000-8000-0000000000e8", delivered: "0b7d1f4e-0000-4000-8000-0000000000e9" };
  const seedOrder = (id, soId, over) => ({
    id, status: "PAID", currency: "EGP", items_subtotal: money(80_000), discount: money(0), shipping: money(6_000), vat: money(10_500), store_credit: money(0), total: money(86_000), payment_method: "card", payment_status: "captured", client_action: null,
    seller_orders: [{ id: soId, store_id: STORE, store_display_name_ar: "نيل أوتليت", status: "PAID", items_subtotal: money(80_000), shipping: money(6_000), vat: money(10_500), total: money(86_000),
      lines: [{ id: `${soId.slice(0, -2)}a1`, sku_id: "sku0", product_id: "prod0", title_ar_snapshot: "جاكيت", title_en_snapshot: "Jacket", condition_grade_snapshot: "open_box", qty: 1, unit_price: money(80_000), platform_discount: money(0), seller_discount: money(0), vat_rate_bp: 1400, vat: money(9_824), claim_type_snapshot: "plain", status: "PAID" }],
      shipment: null, delivered_at: null, return_window_ends_at: null, cancellable: false, returnable: false, tax_documents: [], ...over }],
  });
  const seedOrders = () => {
    st.seeded.set(SEED.cancellable, seedOrder(SEED.cancellable, "0b7d1f4e-0000-4000-8000-0000000000a8", { cancellable: true }));
    st.seeded.set(SEED.delivered, seedOrder(SEED.delivered, "0b7d1f4e-0000-4000-8000-0000000000a9", {
      status: "DELIVERED", returnable: true, delivered_at: "2026-11-06T10:00:00Z", return_window_ends_at: "2026-11-20T10:00:00Z",
      shipment: { shipment_id: "0b7d1f4e-0000-4000-8000-0000000000aa", status: "DELIVERED", courier_code: "bosta", awb: "AWB123", delivered_at: "2026-11-06T10:00:00Z", events: [{ normalized_status: "PICKED_UP", location_text: "Cairo hub", occurred_at: "2026-11-05T10:00:00Z" }, { normalized_status: "DELIVERED", location_text: null, occurred_at: "2026-11-06T10:00:00Z" }] },
    }));
  };
  const geo = { governorate: [{ id: "g1", parent_id: null, level: "governorate", code: "cai", name_ar: "القاهرة", name_en: "Cairo", active: true }], city: [{ id: "c1", parent_id: "g1", level: "city", code: "nc", name_ar: "مدينة نصر", name_en: "Nasr City", active: true }], district: [] };

  return async (req, res, url, readBody) => {
    const p = url.pathname;
    if (p === "/__test/reset") { st = fresh(); return send(res, 200, {}); }
    if (p === "/__test/bump") { st.bump = true; return send(res, 200, {}); }
    if (p === "/__test/seed-orders") { seedOrders(); return send(res, 200, { cancellable: SEED.cancellable, delivered: SEED.delivered }); }
    if (p === "/__test/returns") return send(res, 200, st.returns);
    if (p === "/__test/checkouts") return send(res, 200, st.checkoutBodies);
    if (!p.startsWith("/v1/eg/")) return false;
    const path = p.slice("/v1/eg/".length);
    const body = req.method === "GET" ? {} : await readBody(req);
    if (path === "auth/devices") {
      if (!strict(body, ["install_id", "platform"], ["install_id", "platform"]) || !UUID.test(body.install_id)) return problem(res, 400, "invalid-body");
      const id = `0b7d1f4e-0000-4000-8000-${String(devices.size + 1).padStart(12, "d")}`.replace(/d/g, "0");
      devices.add(id);
      return send(res, 201, { device_id: id });
    }
    const deviceId = req.headers["x-device-id"];
    if (/^(auth|me|cart|checkout|order-groups)(\/|$)/.test(path)) {
      if (typeof deviceId !== "string" || !devices.has(deviceId)) return problem(res, 400, deviceId === undefined ? "device-id-required" : "invalid-device");
    }
    if (req.method !== "GET" && !UUID7.test(String(req.headers["idempotency-key"] ?? ""))) return problem(res, 400, "idempotency-key-invalid");
    if (path === "auth/otp/request") {
      if (!strict(body, ["phone_e164", "channel", "purpose"], ["phone_e164", "channel", "purpose"])) return problem(res, 400, "invalid-body");
      if (body.phone_e164 === "+201000000429") return problem(res, 429, "rate-limited", {}, { "retry-after": "42" });
      return send(res, 201, { challenge_id: "0b7d1f4e-0000-4000-8000-0000000000c9", expires_at: new Date(Date.now() + 300_000).toISOString(), resend_after_s: 30, channel: "sms" });
    }
    if (path === "auth/otp/verify") {
      if (!strict(body, ["challenge_id", "phone_e164", "code", "dob"], ["challenge_id", "phone_e164", "code"])) return problem(res, 400, "invalid-body");
      if (body.dob !== undefined && ageOf(body.dob) < 18) return problem(res, 403, "under-age");
      return body.code === "123456" ? send(res, 200, pair(body.dob !== undefined)) : problem(res, 400, "otp-invalid");
    }
    if (path === "auth/refresh") {
      if (!strict(body, ["refresh_token"], [])) return problem(res, 400, "invalid-body");
      return body.refresh_token === REFRESH ? send(res, 200, pair(false)) : problem(res, 401, "refresh-rejected");
    }
    if (path === "auth/logout") return req.headers.authorization === `Bearer ${ACCESS}` ? send(res, 204, null) : problem(res, 401, "unauthenticated");
    if (/^(products|stores|categories|deals|village)(\/|$)/.test(path)) return false;
    if (path === "geo-areas") return send(res, 200, { items: geo[url.searchParams.get("level") ?? "governorate"] ?? [], next_cursor: null });
    if (req.headers.authorization !== `Bearer ${ACCESS}`) return problem(res, 401, "unauthenticated");
    if (path === "me") return send(res, 200, { id: "0b7d1f4e-0000-4000-8000-0000000000aa", market_id: "EG", status: "active", locale: "ar-EG", age_band: "21_plus", limited_capacity: false, phone_masked: "+2010****678", store_memberships: [] });
    if (path === "me/sessions") return send(res, 200, { items: st.sessions, next_cursor: null });
    if (path.startsWith("me/sessions/") && req.method === "DELETE") { st.sessions = st.sessions.filter((x) => x.id !== path.split("/")[2]); return send(res, 204, null); }
    const consentList = () => Object.entries(st.consents).map(([code, granted]) => ({ purpose_code: code, purpose_version: 1, granted, text_ar: `موافقة ${code}`, text_en: `Consent: ${code}` }));
    if (path === "me/privacy/consents" && req.method === "GET") return send(res, 200, { items: consentList(), next_cursor: null });
    if (path === "me/privacy/consents") { for (const c of body.changes ?? []) st.consents[c.purpose_code] = c.granted; return send(res, 200, { items: consentList() }); }
    if (path === "me/privacy/requests") return send(res, 200, { items: st.deleteRequest ? [st.deleteRequest] : [], next_cursor: null });
    if (path === "me/privacy/delete" && req.method === "POST") { st.deleteRequest = { id: "pr-1", kind: "delete", status: "COOLING", due_at: "2026-12-08T00:00:00Z", cooling_until: "2026-11-22T00:00:00Z", created_at: "2026-11-08T00:00:00Z" }; return send(res, 202, st.deleteRequest); }
    if (path === "me/privacy/delete") { st.deleteRequest = null; return send(res, 204, null); }
    if (path === "me/wallet") return send(res, 200, { currency: "EGP", balances: [], total_available: money(0) });
    if (path === "me/addresses" && req.method === "GET") return send(res, 200, { items: st.addresses, next_cursor: null });
    if (path === "me/addresses") { const a = { id: `0b7d1f4e-0000-4000-8000-00000000ad0${st.addresses.length + 1}`, country_code: "EG", recipient_name: body.recipient_name, phone_e164: body.phone_e164, fields: body.fields, geo_area_id: "c1", is_default: st.addresses.length === 0, cod_eligible: Boolean(body.fields?.landmark), created_at: "2026-11-08T00:00:00Z" }; st.addresses.push(a); return send(res, 201, a); }
    const ad = /^me\/addresses\/([^/]+)$/.exec(path);
    if (ad) {
      const a = st.addresses.find((x) => x.id === ad[1]);
      if (!a) return problem(res, 404, "not-found");
      if (req.method === "DELETE") { st.addresses = st.addresses.filter((x) => x.id !== a.id); if (a.is_default && st.addresses[0]) st.addresses[0].is_default = true; return send(res, 204, null); }
      if (!strict(body, ["country_code", "label", "recipient_name", "phone_e164", "fields", "pin", "is_default"], ["country_code", "recipient_name", "phone_e164", "fields"])) return problem(res, 400, "invalid-body");
      if (body.is_default === true) for (const x of st.addresses) x.is_default = false;
      Object.assign(a, { recipient_name: body.recipient_name, phone_e164: body.phone_e164, fields: body.fields, cod_eligible: Boolean(body.fields.landmark), ...(body.is_default === true ? { is_default: true } : {}) });
      return send(res, 200, a);
    }
    if (path === "order-groups" && req.method === "GET") {
      const rows = [...st.seeded.values()].map((o) => ({ id: o.id, status: o.status, total: money(86_000), store_count: 1, placed_at: "2026-11-04T10:00:00Z" }));
      const cursor = url.searchParams.get("cursor");
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const page = rows.slice(cursor === null ? 0 : Number(cursor), (cursor === null ? 0 : Number(cursor)) + limit);
      const next = (cursor === null ? 0 : Number(cursor)) + limit;
      return send(res, 200, { items: page, next_cursor: next < rows.length ? String(next) : null });
    }
    const cancelM = /^order-groups\/([^/]+)\/seller-orders\/([^/]+)\/cancel$/.exec(path);
    if (cancelM) {
      const o = st.seeded.get(cancelM[1]);
      if (!o || o.seller_orders[0].id !== cancelM[2]) return problem(res, 404, "not-found");
      if (!strict(body, ["reason_code", "refund_preference"], ["reason_code"])) return problem(res, 400, "invalid-body");
      if (!o.seller_orders[0].cancellable) return problem(res, 409, "not-cancellable");
      o.status = "CANCELLED"; o.seller_orders[0] = { ...o.seller_orders[0], status: "CANCELLED", cancellable: false };
      return send(res, 200, o);
    }
    const retNew = /^seller-orders\/([^/]+)\/returns$/.exec(path);
    if (retNew && req.method === "POST") {
      if (!strict(body, ["lines", "reason_code", "method", "resolution", "refund_preference", "evidence_media_ids"], ["lines", "reason_code", "method", "resolution"])) return problem(res, 400, "invalid-body");
      const o = [...st.seeded.values()].find((x) => x.seller_orders[0].id === retNew[1]);
      if (!o) return problem(res, 404, "not-found");
      if (!o.seller_orders[0].returnable) return problem(res, 422, "return-window-closed");
      if (["defective", "undisclosed_defect", "not_as_described"].includes(body.reason_code) && !(body.evidence_media_ids?.length > 0)) return problem(res, 422, "evidence-required");
      if ((body.evidence_media_ids ?? []).some((id) => !st.uploads.has(id))) return problem(res, 404, "not-found");
      const r = { id: `0b7d1f4e-0000-4000-8000-00000000ce0${st.returns.length + 1}`, seller_order_id: retNew[1], status: "REQUESTED", reason_code: body.reason_code, fault: "none", window_basis: "no_reason", delivered_at_snapshot: "2026-11-06T10:00:00Z", window_ends_at: "2026-11-20T10:00:00Z", method: body.method, resolution: body.resolution, lines: body.lines.map((l, i) => ({ id: `0b7d1f4e-0000-4000-8000-00000000cf0${i + 1}`, order_line_id: l.order_line_id, qty: l.qty })), received_at: null, inspection_due_at: null, refund_due_at: null, created_at: "2026-11-08T09:00:00Z", evidence: body.evidence_media_ids ?? [] };
      st.returns.push(r);
      return send(res, 201, r);
    }
    if (path === "returns" && req.method === "GET") return send(res, 200, { items: st.returns, next_cursor: null });
    const retM = /^returns\/([^/]+)(\/(cancel|dispute))?$/.exec(path);
    if (retM) {
      const r = st.returns.find((x) => x.id === retM[1]);
      if (!r) return problem(res, 404, "not-found");
      if (retM[3] === "cancel") { r.status = "CANCELLED"; return send(res, 200, r); }
      if (retM[3] === "dispute") { if (!strict(body, ["statement", "media_ids"], ["statement"]) || body.statement.length < 10) return problem(res, 400, "invalid-body"); r.status = "DISPUTED"; return send(res, 201, { id: "dsp-1", return_id: r.id, status: "OPEN" }); }
      return send(res, 200, r);
    }
    if (path === "media/uploads") {
      if (!strict(body, ["purpose", "mime", "bytes", "sha256"], ["purpose", "mime", "bytes", "sha256"]) || !/^[0-9a-f]{64}$/.test(body.sha256)) return problem(res, 400, "invalid-body");
      const id = `0b7d1f4e-0000-4000-8000-00000000fe0${st.uploads.size + 1}`;
      st.uploads.add(id);
      return send(res, 201, { media_id: id, upload_url: `https://uploads.example.test/put/${id}`, upload_headers: { "content-type": body.mime }, expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    const mc = /^media\/([^/]+)\/complete$/.exec(path);
    if (mc) return st.uploads.has(mc[1]) ? send(res, 200, { id: mc[1], status: "SCANNING" }) : problem(res, 404, "not-found");
    if (path === "cart") return send(res, 200, cartBody());
    if (path === `cart/lines/${LINE}` && req.method === "PATCH") { if (body.qty === 9) return problem(res, 409, "stock-shortfall"); st.qty = body.qty; return send(res, 200, cartBody()); }
    if (path === `cart/lines/${LINE}` && req.method === "DELETE") { st.qty = 0; return send(res, 200, { ...cartBody(), groups: [], items_subtotal: money(0) }); }
    if (path === "checkout/quote") return send(res, 200, quoteBody(body.payment_method));
    if (path === "checkout") {
      st.checkoutBodies.push({ ...body, idempotency_key: req.headers["idempotency-key"] });
      const q = quoteBody(body.payment_method);
      if (q.total.amount_minor !== body.client_total?.amount_minor && body.accept_price_change !== true) return problem(res, 409, "price-changed", { quote: q });
      const id = `0b7d1f4e-0000-4000-8000-0000000000e${st.orders.size + 1}`;
      st.orders.set(id, { id, method: body.payment_method, quote: q, polls: 0, confirmed: false });
      const cod = body.payment_method === "cod";
      return send(res, 201, { order_group_id: id, status: cod ? "CONFIRMED_COD" : "PENDING_PAYMENT", client_action: cod ? { kind: "cod_confirmation" } : { kind: "redirect", url: `http://localhost:3100/eg-en/orders/${id}?paid=1` }, reservation_expires_at: new Date(Date.now() + 600_000).toISOString() });
    }
    const og = /^order-groups\/([^/]+)(\/cod-confirmation)?$/.exec(path);
    if (og && st.seeded.has(og[1])) return send(res, 200, st.seeded.get(og[1]));
    if (og) {
      const o = st.orders.get(og[1]);
      if (!o) return problem(res, 404, "not-found");
      if (og[2]) { if (body.code !== "123456") return problem(res, 422, "invalid-code"); o.confirmed = true; }
      return send(res, 200, orderBody(o));
    }
    return problem(res, 404, "not-found");
  };
}
