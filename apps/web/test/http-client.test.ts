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
  it("has no directory/deals/product-detail route: honest empties", async () => {
    const c = new HttpApiClient("https://a");
    expect(await c.listStores()).toEqual({ stores: [], reason: "NO_ROUTE" });
    expect(await c.listDealBands()).toEqual([]);
    expect(await c.getProduct()).toBeNull();
  });
});
