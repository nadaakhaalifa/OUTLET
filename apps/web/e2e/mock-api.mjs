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

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/health") return void res.end("{}");
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
