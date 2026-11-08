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

// ---- Shopper surface (auth, bag, checkout, orders, account): in-memory, TEST ONLY. Mirrors docs/api/openapi.yaml shapes. ----
function createShopperMock() {
  const ACCESS = "at-1";
  const REFRESH = "rt-1";
  const LINE = "0b7d1f4e-0000-4000-8000-0000000000c1";
  const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
  const money = (n) => ({ amount_minor: String(n), currency: "EGP" });
  const fresh = () => ({ qty: 1, bump: false, addresses: [], orders: new Map(), consents: { analytics: false, marketing_push: false, personalization: false }, deleteRequest: null, sessions: [{ id: "s1", device_id: "d1", platform: "web", ua_family: "Chrome", amr: ["otp"], created_at: "2026-11-01T10:00:00Z", last_seen_at: "2026-11-08T09:00:00Z", current: true }, { id: "s2", device_id: "d2", platform: "ios", ua_family: null, amr: ["otp"], created_at: "2026-10-01T10:00:00Z", last_seen_at: "2026-11-02T09:00:00Z", current: false }], checkoutBodies: [] });
  let st = fresh();
  const send = (res, status, body, headers = {}) => { for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.statusCode = status; res.end(body === null ? "" : JSON.stringify(body)); return true; };
  const problem = (res, status, type, extra = {}) => send(res, status, { type: `https://api.outlex.invalid/problems/${type}`, title: type, status, ...extra }, { "content-type": "application/problem+json" });
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
  const geo = { governorate: [{ id: "g1", parent_id: null, level: "governorate", code: "cai", name_ar: "القاهرة", name_en: "Cairo", active: true }], city: [{ id: "c1", parent_id: "g1", level: "city", code: "nc", name_ar: "مدينة نصر", name_en: "Nasr City", active: true }], district: [] };

  return async (req, res, url, readBody) => {
    const p = url.pathname;
    if (p === "/__test/reset") { st = fresh(); return send(res, 200, {}); }
    if (p === "/__test/bump") { st.bump = true; return send(res, 200, {}); }
    if (p === "/__test/checkouts") return send(res, 200, st.checkoutBodies);
    if (!p.startsWith("/v1/eg/")) return false;
    const path = p.slice("/v1/eg/".length);
    const body = req.method === "GET" ? {} : await readBody(req);
    if (path === "auth/age-gate") return send(res, 200, { age_gate_token: "gate-1", expires_at: new Date(Date.now() + 600_000).toISOString(), age_band: "21_plus" });
    if (path === "auth/otp/request") return send(res, 201, { challenge_id: "0b7d1f4e-0000-4000-8000-0000000000c9", expires_at: new Date(Date.now() + 300_000).toISOString(), resend_after_s: 30, channel: "sms" }, { "x-purpose": String(body.purpose) });
    if (path === "auth/otp/verify") return body.code === "123456" ? send(res, 200, pair(body.age_gate_token !== undefined)) : problem(res, 422, "invalid-otp");
    if (path === "auth/refresh") return body.refresh_token === REFRESH ? send(res, 200, pair(false)) : problem(res, 401, "invalid-refresh");
    if (path === "auth/logout") return send(res, 204, null);
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
    if (path === "me/addresses") { const a = { id: `0b7d1f4e-0000-4000-8000-00000000ad0${st.addresses.length + 1}`, country_code: "EG", recipient_name: body.recipient_name, phone_e164: body.phone_e164, fields: body.fields, geo_area_id: "c1", is_default: st.addresses.length === 0, created_at: "2026-11-08T00:00:00Z" }; st.addresses.push(a); return send(res, 201, a); }
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
    if (og) {
      const o = st.orders.get(og[1]);
      if (!o) return problem(res, 404, "not-found");
      if (og[2]) { if (body.code !== "123456") return problem(res, 422, "invalid-code"); o.confirmed = true; }
      return send(res, 200, orderBody(o));
    }
    return problem(res, 404, "not-found");
  };
}
