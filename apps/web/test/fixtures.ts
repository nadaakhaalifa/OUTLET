import type { ApiClient, ProductSummary, StoreProfile } from "../src/server/api-client";

/** Real-shaped fixtures, TESTS ONLY. */
export const store: StoreProfile = {
  id: "0b7d1f4e-0000-4000-8000-000000000001", slug: "nile-outlet", nameAr: "نيل أوتليت", nameEn: "Nile Outlet", taglineAr: "ملابس بأسعار مخفضة", taglineEn: "Clearance clothing",
  kind: "local", status: "ACTIVE", verifiedBadge: true, followersCount: 12, discountDisplayMode: "public", canonicalPath: "/stores/nile-outlet",
};

export function product(i: number, over: Partial<ProductSummary["price"]> = {}): ProductSummary {
  return {
    id: `prod${String(i)}`, storeSlug: "nile-outlet", titleAr: `جاكيت ${String(i)}`, titleEn: `Jacket ${String(i)}`,
    image: { url: `https://cdn.example/p${String(i)}.jpg`, width: 400, height: 500, altAr: null, altEn: `Jacket ${String(i)} photo` },
    conditionGradeCode: "open_box", defectCount: 1,
    price: { amountMinor: 80_000n, currency: "EGP", claimType: "plain", priceProofPath: `/v1/eg/proof/${String(i)}`, ...over },
    availability: "in_stock", canonicalPath: `/p/prod${String(i)}`,
  };
}

export function stubClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    listStores: () => Promise.resolve({ stores: [], reason: "UNCONFIGURED" as const }),
    getStore: () => Promise.resolve(store),
    listStoreProducts: () => Promise.resolve({ items: Array.from({ length: 7 }, (_, i) => product(i)), nextCursor: null }),
    getProduct: () => Promise.resolve(null),
    listDealBands: () => Promise.resolve([]),
    ...over,
  };
}
