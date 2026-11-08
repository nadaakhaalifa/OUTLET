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

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/health") return void res.end("{}");
  if (url.pathname === "/v1/eg/stores/nile-outlet") return void res.end(JSON.stringify(store));
  if (url.pathname === "/v1/eg/stores/nile-outlet/products") return void res.end(JSON.stringify({ items, next_cursor: null }));
  res.statusCode = 404;
  res.end(JSON.stringify({ title: "not found" }));
}).listen(3101);
