// TEST-ONLY stateful mock of apps/api's seller routes (real response shapes, in-memory state). Never used outside Playwright.
import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

const CATEGORY = "00000000-0000-4000-8000-0000000c0011";
const STORE = "0b7d1f4e-0000-4000-8000-000000000001";
const products = new Map();
const control = { storeActive: true, passkey: true };
const log = [];

// --- orders and inventory (in-memory; reset through /__control {"reset": true})
const ORDER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const SKU_1 = "5a000000-0000-4000-8000-000000000001";
const SKU_2 = "5a000000-0000-4000-8000-000000000002";
const orders = new Map();
const stock = new Map();
const levelOf = (id) => {
  const l = stock.get(id);
  return { sku_id: id, location_id: "10c00000-0000-4000-8000-000000000001", seller_sku: l.sku, size_label: l.size, product_title_ar: l.title, on_hand: l.onHand, committed: 0, available: l.onHand, low_stock: l.onHand <= 3, version: l.version, updated_at: new Date().toISOString() };
};
const money = (v) => ({ amount_minor: String(v), currency: "EGP" });
const ACTIONS = { PAID: ["accept", "reject"], CONFIRMED_COD: ["accept", "reject"], ACCEPTED: ["pack"], PACKED: ["ship"] };
const orderView = (o) => ({
  id: o.id, status: o.status, version: o.version, items_subtotal: money(129900), seller_discount: money(0), platform_discount: money(0), shipping: money(0), vat: money(15900), total: money(129900),
  commission_bp_snapshot: 1400, commission: money(18186), payment_kind: "prepaid", accept_by: o.accept_by, dispatch_by: o.dispatch_by, delivered_at: null, return_window_ends_at: null,
  lines: [{ id: "bbbbbbbb-0000-4000-8000-000000000001", sku_id: SKU_1, product_id: "cccccccc-0000-4000-8000-000000000001", title_ar_snapshot: "فستان صيفي", title_en_snapshot: null, condition_grade_snapshot: "new_with_imperfections", qty: 1, unit_price: money(129900), platform_discount: money(0), seller_discount: money(0), vat_rate_bp: 1400, vat: money(15900), claim_type_snapshot: "plain", status: "active" }],
  delivery: { recipient_name: "منى أحمد", phone_masked: "+20••••••••78", address: { governorate_code: "CAI", city_code: "NASR", district_code: null, street: "شارع مصطفى النحاس", building: "12", floor: "3", apartment: "7", landmark: null }, access_until: null },
  available_actions: ACTIONS[o.status] ?? [], created_at: o.created_at, server_time: new Date().toISOString(),
});
const resetOrders = () => {
  orders.clear();
  stock.clear();
  orders.set(ORDER_A, { id: ORDER_A, status: "PAID", version: 1, accept_by: new Date(Date.now() + 20 * 3600_000).toISOString(), dispatch_by: null, created_at: new Date(Date.now() - 3600_000).toISOString() });
  stock.set(SKU_1, { sku: "SKU-1", size: "M", title: "فستان صيفي", onHand: 10, version: 1 });
  stock.set(SKU_2, { sku: "SKU-2", size: "L", title: "حذاء رياضي", onHand: 2, version: 1 });
};
resetOrders();

const reasonsOf = (p) => {
  const r = [];
  if (!p.title_ar) r.push("TITLE_AR_REQUIRED");
  if (!p.description_ar) r.push("DESCRIPTION_AR_REQUIRED");
  if (!p.media.some((m) => m.role === "main")) r.push("MAIN_PHOTO_REQUIRED");
  if (p.skus.length === 0) r.push("NO_ACTIVE_VARIANT");
  if (["open_box", "new_with_imperfections", "refurbished"].includes(p.condition_grade_code)) {
    if (!p.defect_card) r.push("DEFECT_CARD_REQUIRED");
    if (!p.media.some((m) => m.role === "condition")) r.push("CONDITION_PHOTO_REQUIRED");
  }
  if (!control.storeActive) r.push("STORE_NOT_ACTIVE");
  return r;
};
const view = (p) => ({ ...p, updated_at: new Date().toISOString() });
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const problem = (res, status, code, errors) => send(res, status, { type: `urn:outlex:problem:${code}`, title: code, status, code, request_id: "e2e", ...(errors ? { errors } : {}) });
const readBody = (req) => new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
const version = (req) => Number(/(\d+)/.exec(req.headers["if-match"] ?? "")?.[1] ?? NaN);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  if (path === "/health") return send(res, 200, { ok: true });
  if (path === "/__control") {
    const patch = JSON.parse((await readBody(req)).toString() || "{}");
    if (patch.reset === true) resetOrders();
    delete patch.reset;
    Object.assign(control, patch);
    return send(res, 200, control);
  }
  if (path === "/__log") return send(res, 200, log);
  const m = /^\/v1\/eg\/seller\/(.*)$/.exec(path);
  if (!m) return problem(res, 404, "not-found");
  const rest = m[1];
  if (req.headers.authorization !== "Bearer e2e-token") return problem(res, 401, "unauthenticated");
  if (req.headers["x-store-id"] !== STORE) return problem(res, 404, "not-found");
  if (!control.passkey) return problem(res, 403, "passkey-required");
  log.push(`${req.method} ${rest}`);

  const sendOrder = (o) => send(res, 200, orderView(o));
  if (req.method === "GET" && rest === "orders") {
    const status = url.searchParams.get("status");
    const items = [...orders.values()].filter((o) => status === null || o.status === status).map((o) => ({ id: o.id, status: o.status, total: money(129900), accept_by: o.accept_by, dispatch_by: o.dispatch_by, created_at: o.created_at, available_actions: ACTIONS[o.status] ?? [] }));
    return send(res, 200, { items, next_cursor: null, server_time: new Date().toISOString() });
  }
  const om = /^orders\/([0-9a-f-]{36})(?:\/(accept|reject|pack))?$/.exec(rest);
  if (om) {
    const o = orders.get(om[1]);
    if (!o) return problem(res, 404, "not-found");
    if (req.method === "GET" && om[2] === undefined) return sendOrder(o);
    if (req.method === "POST" && om[2] !== undefined) {
      await readBody(req);
      const next = { accept: ["PAID", "ACCEPTED"], reject: ["PAID", "REJECTED_BY_SELLER"], pack: ["ACCEPTED", "PACKED"] }[om[2]];
      if (o.status !== next[0] && !(om[2] !== "pack" && o.status === "CONFIRMED_COD")) return problem(res, 409, "invalid-transition");
      o.status = next[1];
      o.version += 1;
      if (om[2] === "accept") o.dispatch_by = new Date(Date.now() + 48 * 3600_000).toISOString();
      return sendOrder(o);
    }
  }
  if (req.method === "POST" && rest === "shipments") {
    const body = JSON.parse((await readBody(req)).toString());
    const o = orders.get(body.seller_order_ids?.[0]);
    if (!o) return problem(res, 404, "not-found");
    if (o.status !== "PACKED") return problem(res, 409, "invalid-transition");
    o.status = "SHIPPED";
    o.version += 1;
    return send(res, 201, { id: o.id, seller_order_id: o.id, status: "CREATED", courier_code: "mock", awb: "MOCK00000001", label_url: null, created_at: new Date().toISOString() });
  }
  if (req.method === "GET" && rest === "inventory") {
    const sku = url.searchParams.get("sku_id");
    const ids = [...stock.keys()].filter((id) => sku === null || id === sku);
    return send(res, 200, { items: ids.map(levelOf), next_cursor: null });
  }
  if (req.method === "POST" && rest === "inventory/adjustments") {
    const body = JSON.parse((await readBody(req)).toString());
    const l = stock.get(body.sku_id) ?? (stock.set(body.sku_id, { sku: "SKU-NEW", size: null, title: "منتج جديد", onHand: 0, version: 0 }), stock.get(body.sku_id));
    if (body.expected_version !== undefined && body.expected_version !== l.version) return problem(res, 409, "version-conflict");
    if (l.onHand + body.delta < 0) return problem(res, 409, "insufficient-stock");
    l.onHand += body.delta;
    l.version += 1;
    return send(res, 201, levelOf(body.sku_id));
  }
  if (req.method === "GET" && rest === "categories") {
    return send(res, 200, { items: [{ id: CATEGORY, parent_id: null, code: "women_dresses", path: "fashion/women/dresses", depth: 2, vertical: "fashion", name: "فساتين", slug: "fasateen", name_ar: "فساتين", name_en: "Dresses" }], next_cursor: null });
  }
  if (req.method === "GET" && rest.startsWith("attribute-sets/")) {
    return send(res, 200, {
      category_id: CATEGORY,
      attributes: [
        { code: "colour", data_type: "enum", unit: null, required: true, options: [{ code: "black", label_ar: "أسود", label_en: "Black" }] },
        { code: "size_run", data_type: "size_run", unit: "cm", required: true, options: [] },
      ],
      defect_types: [{ code: "stain", label_ar: "بقعة أو تغير لون", label_en: "Stain", default_severity: "minor" }],
    });
  }
  if (req.method === "POST" && rest === "products") {
    await readBody(req);
    const body = JSON.parse(String((await Promise.resolve(null)) ?? "{}") || "{}");
    void body;
    const id = randomUUID();
    const p = { id, version: 1, status: "DRAFT", title_ar: null, description_ar: null, primary_category_id: CATEGORY, condition_grade_code: "new_with_tags", stock_reason: null, attributes: {}, category_ids: [CATEGORY], media: [], skus: [], defect_card: null };
    products.set(id, p);
    return send(res, 201, view(p));
  }
  if (req.method === "GET" && rest.startsWith("products") && !rest.includes("/")) {
    return send(res, 200, { items: [...products.values()].map((p) => ({ id: p.id, status: p.status, title_ar: p.title_ar, condition_grade_code: p.condition_grade_code, sku_count: p.skus.length, updated_at: new Date().toISOString() })), next_cursor: null });
  }
  const pm = /^products\/([0-9a-f-]{36})(?:\/(readiness|media|defect-cards|publish))?$/.exec(rest);
  const p = pm ? products.get(pm[1]) : undefined;
  if (!p) return problem(res, 404, "not-found");
  const sub = pm[2];
  if (req.method === "GET" && sub === undefined) return send(res, 200, view(p));
  if (req.method === "GET" && sub === "readiness") return send(res, 200, { product_id: p.id, status: "DRAFT", blocked_reasons: reasonsOf(p) });
  if (req.method === "POST" && sub === "media") {
    const raw = await readBody(req);
    if (raw.length === 0) return problem(res, 400, "file-required");
    return send(res, 201, { media_id: randomUUID(), kind: "product", status: "ready", width: 96, height: 96, url: "/media/x" });
  }
  if (req.method === "PATCH" && sub === undefined) {
    const body = JSON.parse((await readBody(req)).toString());
    if (version(req) !== p.version) return problem(res, 409, "version-conflict");
    if (body.condition) {
      p.condition_grade_code = body.condition.condition_grade_code;
      p.media = body.condition.media.map((x, i) => ({ id: String(i), role: x.role, position: x.position, media: { media_id: x.media_id, url: `/media/${x.media_id}` } }));
    }
    if (body.details) Object.assign(p, { title_ar: body.details.title_ar, description_ar: body.details.description_ar, attributes: body.details.attributes });
    if (body.price) p.skus = [{ id: randomUUID(), price: body.price.price, status: "active", version: 1 }];
    p.version += 1;
    return send(res, 200, view(p));
  }
  if (req.method === "POST" && sub === "defect-cards") {
    const body = JSON.parse((await readBody(req)).toString());
    if (version(req) !== p.version) return problem(res, 409, "version-conflict");
    p.defect_card = { summary_ar: body.summary_ar, items: body.items };
    p.version += 1;
    return send(res, 201, { defect_card: p.defect_card });
  }
  if (req.method === "POST" && sub === "publish") {
    await readBody(req);
    const r = reasonsOf(p);
    if (r.length > 0) return problem(res, 409, "activation-blocked", r.map((code) => ({ path: "/", code })));
    p.status = "PUBLISHED";
    p.version += 1;
    return send(res, 200, { product_id: p.id, status: "PUBLISHED", blocked_reasons: [] });
  }
  return problem(res, 405, "method-not-allowed");
}).listen(3201, () => console.log("seller mock api on 3201"));
