import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedLocale } from "@outlet/i18n";

vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/ar-eg/stores" }));

import { SiteHeader } from "../src/components/SiteHeader";
import type { CategoryNode } from "../src/server/api-client";
import { UnconfiguredApiClient } from "../src/server/api-client";
import { getApiClient, setApiClient } from "../src/server/client-registry";
import { HttpApiClient, type Fetcher } from "../src/server/http-api-client";
import { readEnv } from "../src/server/env";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ar: ResolvedLocale = { marketId: "EG", locale: "ar-EG" } as ResolvedLocale;
const en: ResolvedLocale = { marketId: "EG", locale: "en-EG" } as ResolvedLocale;
const roots: CategoryNode[] = [
  { id: "c1", parentId: null, depth: 0, nameAr: "أزياء", nameEn: "Fashion", slug: "fashion" },
  { id: "c2", parentId: null, depth: 0, nameAr: "أحذية", nameEn: null, slug: "shoes" },
];

describe("SiteHeader", () => {
  it("Arabic: uses Arabic names, links chips under the locale base (axe-core is not a dependency of apps/web; a11y of TopNav is covered in packages/ui-web)", () => {
    render(<SiteHeader resolved={ar} roots={roots} />);
    const fashion = screen.getByRole("link", { name: "أزياء" });
    expect(fashion.getAttribute("href")).toMatch(/\/stores\?category=c1$/);
    expect(screen.getByRole("link", { name: "أحذية" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Fashion" })).toBeNull();
  });
  it("English: prefers the English name and falls back to Arabic when it is missing", () => {
    render(<SiteHeader resolved={en} roots={roots} />);
    expect(screen.getByRole("link", { name: "Fashion" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "أحذية" })).toBeTruthy();
  });
  it("with no categories only the 'all' chip is present", () => {
    render(<SiteHeader resolved={en} roots={[]} />);
    expect(screen.queryByRole("link", { name: "Fashion" })).toBeNull();
    expect(screen.getAllByRole("link").some((a) => (a.getAttribute("href") ?? "").endsWith("/stores"))).toBe(true);
  });
});

describe("client registry", () => {
  afterEach(() => { setApiClient(null); vi.unstubAllEnvs(); });
  it("builds an HTTP client when API_URL is set, and caches the instance", () => {
    vi.stubEnv("API_URL", "https://api.example.test");
    setApiClient(null);
    const a = getApiClient();
    expect(a).toBeInstanceOf(HttpApiClient);
    expect(getApiClient()).toBe(a);
  });
  it("falls back to the Unconfigured client (fail closed) when API_URL is unset", () => {
    vi.stubEnv("API_URL", "");
    setApiClient(null);
    expect(getApiClient()).toBeInstanceOf(UnconfiguredApiClient);
  });
});

describe("web env", () => {
  it("defaults", () => {
    expect(readEnv({})).toEqual({ SITE_URL: "http://localhost:3000", CSP_TRUSTED_TYPES: "off" });
  });
  it("reads set values; empty SITE_URL and API_URL are treated as unset", () => {
    expect(readEnv({ SITE_URL: "https://s.test", CSP_TRUSTED_TYPES: "on", API_URL: "https://a.test" })).toEqual({ SITE_URL: "https://s.test", CSP_TRUSTED_TYPES: "on", API_URL: "https://a.test" });
    expect(readEnv({ SITE_URL: "", API_URL: "" })).toEqual({ SITE_URL: "http://localhost:3000", CSP_TRUSTED_TYPES: "off" });
  });
  it("rejects malformed values", () => {
    expect(() => readEnv({ SITE_URL: "nope" })).toThrow();
    expect(() => readEnv({ API_URL: "nope" })).toThrow();
    expect(() => readEnv({ CSP_TRUSTED_TYPES: "x" })).toThrow();
  });
  it("reads process.env by default", () => {
    vi.stubEnv("SITE_URL", "https://env.test");
    expect(readEnv().SITE_URL).toBe("https://env.test");
    vi.unstubAllEnvs();
  });
});

describe("HttpApiClient branches", () => {
  const wireStore = { id: "a", slug: "s", display_name_ar: "ن", kind: "local", status: "ACTIVE", verified_badge: false, followers_count: 0, discount_display_mode: "public", canonical_path: "/stores/s" };
  const card = (art: unknown) => ({ ...wireStore, verified_badge: true, storefront: { template_code: "t", palette: {}, published_version: 1 }, live_drop: false, art });
  const price = { current_price: { amount_minor: "100", currency: "EGP" }, claim_type: "plain", price_proof_path: "/p" };

  it("uses the global fetch by default and strips trailing slashes", async () => {
    const f = vi.fn(() => Promise.resolve(json(wireStore)));
    vi.stubGlobal("fetch", f);
    const s = await new HttpApiClient("https://api.example///").getStore("eg", "s");
    expect(s?.slug).toBe("s");
    expect(f).toHaveBeenCalledWith("https://api.example/v1/eg/stores/s", expect.objectContaining({ headers: { accept: "application/json" } }));
    vi.unstubAllGlobals();
  });
  it("maps store art: missing, with partial dimensions, and with none", async () => {
    const fetcher: Fetcher = () => Promise.resolve(json({ items: [card(null), card({ media_id: "m", url: "u1" }), card({ media_id: "m", url: "u2", width: 5 }), card({ media_id: "m", url: "u3", height: 6 })], next_cursor: null }));
    const dir = await new HttpApiClient("https://a", fetcher).listStores("eg");
    expect(dir.stores[0]).not.toHaveProperty("art");
    expect(dir.stores[1]?.art).toEqual({ src: "u1" });
    expect(dir.stores[2]?.art).toEqual({ src: "u2", width: 5 });
    expect(dir.stores[3]?.art).toEqual({ src: "u3", height: 6 });
  });
  it("sends no query string when no options are given", async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = (u) => { urls.push(u); return Promise.resolve(json({ items: [], next_cursor: null })); };
    const c = new HttpApiClient("https://a", fetcher);
    await c.listStores("eg");
    await c.listStoreProducts("eg", "s");
    await c.listStoreProducts("eg", "s", { cursor: "c1" });
    expect(urls).toEqual(["https://a/v1/eg/stores", "https://a/v1/eg/stores/s/products", "https://a/v1/eg/stores/s/products?cursor=c1"]);
  });
  it("follows category cursors, stops at a 404 page, and is bounded at 4 pages", async () => {
    const cat = (id: string) => ({ id, parent_id: null, code: id, path: id, depth: 0, vertical: "f", name: id, slug: id, name_ar: id, name_en: null });
    const urls: string[] = [];
    let n = 0;
    const endless: Fetcher = (u) => { urls.push(u); n += 1; return Promise.resolve(json({ items: [cat(`c${String(n)}`)], next_cursor: `n${String(n)}` })); };
    const all = await new HttpApiClient("https://a", endless).listCategories("eg");
    expect(all).toHaveLength(4);
    expect(urls[0]).toContain("?limit=50");
    expect(urls[1]).toContain("&cursor=n1");
    let k = 0;
    const notFoundSecond: Fetcher = () => { k += 1; return Promise.resolve(k === 1 ? json({ items: [cat("x")], next_cursor: "z" }) : json({}, 404)); };
    expect(await new HttpApiClient("https://a", notFoundSecond).listCategories("eg")).toHaveLength(1);
    expect(await new HttpApiClient("https://a", () => Promise.resolve(json({}, 404))).listCategories("eg")).toEqual([]);
  });
  it("maps a defect card with items, SKU availability default, and a reference-less price", async () => {
    const photo = { media_id: "m", url: "https://cdn/p.jpg", alt_ar: "ع" };
    const detail = {
      id: "p1", store: { ...wireStore, legal_identity: { legal_name_ar: "ا", commercial_register_no: "1", tax_card_no: "2", governorate_name_ar: "ج" } },
      status: "PUBLISHED", title_ar: "ت", description_ar: "و",
      condition_grade: { code: "minor_defect", label_ar: "ع", schema_org_condition: "https://schema.org/DamagedCondition" },
      defect_card: { id: "d", version: 1, grade_code: "minor_defect", summary_ar: "ملخص", affects_function: false, defect_count: 1, inspected_by: "hub",
        items: [{ id: "i", defect_type_code: "stain", label_ar: "بقعة", location_ar: "كم", severity: "minor", affects_function: false, photo, position: 0 }] },
      skus: [{ sku_id: "k", price }], canonical_path: "/p/p1",
    };
    const p = await new HttpApiClient("https://a", () => Promise.resolve(json(detail))).getProduct("eg", "p1");
    expect(p?.defectCard).toMatchObject({ gradeCode: "minor_defect", summaryAr: "ملخص", summaryEn: null, defectCount: 1, items: [{ labelAr: "بقعة", labelEn: null, locationAr: "كم", photo: { url: "https://cdn/p.jpg", width: null, height: null, altAr: "ع", altEn: null } }] });
    expect(p?.skus[0]).toMatchObject({ sizeLabel: null, availability: "in_stock" });
    expect(p?.skus[0]?.price).not.toHaveProperty("referenceAmountMinor");
    expect(p?.brandName).toBeNull();
  });
  it("deals: 404 is an empty list, 5xx is an error", async () => {
    expect(await new HttpApiClient("https://a", () => Promise.resolve(json({}, 404))).listDeals("eg", "70_60")).toEqual([]);
    await expect(new HttpApiClient("https://a", () => Promise.resolve(json({}, 500))).listDeals("eg", "70_60")).rejects.toMatchObject({ status: 500, name: "ApiError" });
  });
  it("product summaries with an image map its dimensions and default availability", async () => {
    const item = { product_id: "p", store_slug: "s", title_ar: "ت", image: { media_id: "m", url: "u", width: 1, height: 2 }, condition_grade_code: "x", defect_count: 0, price, canonical_path: "/p/p" };
    const page = await new HttpApiClient("https://a", () => Promise.resolve(json({ items: [item], next_cursor: null }))).listStoreProducts("eg", "s");
    expect(page.items[0]).toMatchObject({ image: { url: "u", width: 1, height: 2 }, availability: "in_stock", conditionLabelAr: null, colourCode: null });
  });
});
