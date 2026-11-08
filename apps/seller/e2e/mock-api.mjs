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
    Object.assign(control, JSON.parse((await readBody(req)).toString() || "{}"));
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
