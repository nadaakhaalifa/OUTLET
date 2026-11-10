import { describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));
import { ApiError, HttpApiClient, type Fetcher } from "../src/server/http-api-client";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const wireStore = {
  id: "a", slug: "nile-outlet", display_name_ar: "نيل", display_name_en: null, tagline_ar: null, kind: "local", status: "ACTIVE", verified_badge: false,
  followers_count: 3, discount_display_mode: "public", canonical_path: "/stores/nile-outlet",
};
const wireProduct = {
  product_id: "p1", store_slug: "nile-outlet", title_ar: "جاكيت", image: null, condition_grade_code: "open_box", defect_count: 0,
  price: { current_price: { amount_minor: "80000", currency: "EGP" }, claim_type: "verified_discount", reference_price: { amount_minor: "200000", currency: "EGP" }, price_proof_path: "/v1/eg/proof/p1" },
  canonical_path: "/p/p1",
};

describe("HttpApiClient", () => {
  it("tags store reads and never caches product (price/stock) reads", async () => {
    const calls: { url: string; init: Parameters<Fetcher>[1] }[] = [];
    const fetcher: Fetcher = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(url.includes("/products") ? json({ items: [wireProduct], next_cursor: null }) : json(wireStore));
    };
    const c = new HttpApiClient("https://api.example/", fetcher);
    const s = await c.getStore("eg", "nile-outlet");
    expect(s).toMatchObject({ slug: "nile-outlet", nameAr: "نيل", nameEn: null, followersCount: 3 });
    const page = await c.listStoreProducts("eg", "nile-outlet", { limit: 50 });
    expect(page.items[0]?.price).toMatchObject({ amountMinor: 80_000n, claimType: "verified_discount", referenceAmountMinor: 200_000n });
    expect(calls[0]?.url).toBe("https://api.example/v1/eg/stores/nile-outlet");
    expect(calls[0]?.init.next?.tags).toEqual(["store:nile-outlet", "market:eg"]);
    expect(calls[0]?.init.cache).toBeUndefined();
    expect(calls[1]?.url).toBe("https://api.example/v1/eg/stores/nile-outlet/products?limit=50");
    expect(calls[1]?.init.cache).toBe("no-store");
  });
  it("maps 404 to null/empty, other failures to ApiError, and bad bodies to a parse error", async () => {
    const c404 = new HttpApiClient("https://a", () => Promise.resolve(json({}, 404)));
    expect(await c404.getStore("eg", "x")).toBeNull();
    expect(await c404.listStoreProducts("eg", "x")).toEqual({ items: [], nextCursor: null });
    await expect(new HttpApiClient("https://a", () => Promise.resolve(json({}, 503))).getStore("eg", "x")).rejects.toBeInstanceOf(ApiError);
    await expect(new HttpApiClient("https://a", () => Promise.resolve(json({ nope: 1 }))).getStore("eg", "x")).rejects.toThrow();
  });
  it("reads the stores directory (market-tagged, 60 s), categories and maps keyset cursors", async () => {
    const calls: { url: string; init: Parameters<Fetcher>[1] }[] = [];
    const media = { media_id: "m1", url: "https://cdn.example/s.jpg", width: 10, height: 20 };
    const card = {
      id: "s1", slug: "nile-outlet", display_name_ar: "نيل", display_name_en: "Nile", tagline_ar: null, tagline_en: null, kind: "global", verified_badge: true,
      storefront: { template_code: "t", palette: {}, published_version: 1 }, live_drop: false, followers_count: 1, discount_display_mode: "public", art: media, canonical_path: "/stores/nile-outlet",
    };
    const cat = { id: "c1", parent_id: null, code: "fashion", path: "fashion", depth: 0, vertical: "fashion", name: "أزياء", slug: "fashion", name_ar: "أزياء", name_en: "Fashion" };
    const fetcher: Fetcher = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(url.includes("/categories") ? json({ items: [cat], next_cursor: null }) : json({ items: [card], next_cursor: "nxt" }));
    };
    const c = new HttpApiClient("https://api.example", fetcher);
    const dir = await c.listStores("eg", { world: "global", categoryId: "c1", cursor: "abc", limit: 18 });
    expect(dir).toMatchObject({ reason: "OK", nextCursor: "nxt", stores: [{ slug: "nile-outlet", kind: "global", art: { src: "https://cdn.example/s.jpg", width: 10, height: 20 } }] });
    expect(calls[0]?.url).toBe("https://api.example/v1/eg/stores?world=global&category_id=c1&cursor=abc&limit=18");
    expect(calls[0]?.init.next).toEqual({ tags: ["market:eg"], revalidate: 60 });
    expect(await c.listCategories("eg")).toEqual([{ id: "c1", parentId: null, depth: 0, nameAr: "أزياء", nameEn: "Fashion", slug: "fashion" }]);
    expect(calls[1]?.init.next?.tags).toEqual(["market:eg"]);
    await expect(new HttpApiClient("https://a", () => Promise.resolve(json({ items: [{}], next_cursor: null }))).listStores("eg")).rejects.toThrow();
    expect(await new HttpApiClient("https://a", () => Promise.resolve(json({}, 404))).listStores("eg")).toEqual({ stores: [], nextCursor: null, reason: "NO_ROUTE" });
  });
  it("reads product detail and deals with no-store", async () => {
    const calls: { url: string; init: Parameters<Fetcher>[1] }[] = [];
    const price = { current_price: { amount_minor: "80000", currency: "EGP" }, claim_type: "plain", price_proof_path: "/v1/eg/proof/p1" };
    const detail = {
      id: "p1", store: { ...wireStore, legal_identity: { legal_name_ar: "نيل للتجارة", legal_name_en: null, commercial_register_no: "123", tax_card_no: "456", governorate_name_ar: "القاهرة" } },
      brand_name: null, status: "PUBLISHED", title_ar: "جاكيت", title_en: null, description_ar: "وصف", description_en: null,
      condition_grade: { code: "open_box", label_ar: "علبة مفتوحة", label_en: "Open box", schema_org_condition: "https://schema.org/UsedCondition" },
      defect_card: null, skus: [{ sku_id: "k1", size_label: "M", price, availability: "low_stock" }], canonical_path: "/p/p1",
    };
    const fetcher: Fetcher = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(url.includes("/deals") ? json({ items: [wireProduct], next_cursor: null }) : json(detail));
    };
    const c = new HttpApiClient("https://api.example", fetcher);
    const p = await c.getProduct("eg", "p1");
    expect(p).toMatchObject({ id: "p1", legal: { commercialRegisterNo: "123", taxCardNo: "456", governorateNameAr: "القاهرة" }, skus: [{ sizeLabel: "M", availability: "low_stock" }] });
    expect(calls[0]?.init.cache).toBe("no-store");
    const deals = await c.listDeals("eg", "70_60");
    expect(deals).toHaveLength(1);
    expect(calls[1]?.url).toBe("https://api.example/v1/eg/deals?band=70_60");
    expect(calls[1]?.init.cache).toBe("no-store");
    expect(await new HttpApiClient("https://a", () => Promise.resolve(json({}, 404))).getProduct("eg", "x")).toBeNull();
    await expect(new HttpApiClient("https://a", () => Promise.resolve(json({ id: "x" }))).getProduct("eg", "x")).rejects.toThrow();
  });
});
