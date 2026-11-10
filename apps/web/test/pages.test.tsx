import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/eg-ar",
}));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers({ "x-nonce": "n0nce" })), cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

import { setApiClient } from "../src/server/client-registry";
import { detail, product, store, stubClient } from "./fixtures";
import { toPricing } from "../src/lib/present";

const { default: Village } = await import("../src/app/[segment]/page");
const { default: StorePage } = await import("../src/app/[segment]/stores/[slug]/page");
const { default: Deals } = await import("../src/app/[segment]/deals/page");
const { default: Stores } = await import("../src/app/[segment]/stores/page");
const { default: ProductPage } = await import("../src/app/[segment]/p/[id]/page");

afterEach(() => { setApiClient(null); });
const render = async (el: Promise<React.ReactElement>): Promise<string> => renderToStaticMarkup(await el);

describe("village page", () => {
  it("renders the honest empty state when the directory is empty", async () => {
    setApiClient(stubClient());
    const html = await render(Village({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(html).toContain("Pick a store. Discover a deal.");
    expect(html).toContain("No stores to show yet");
    expect(html).not.toContain("skeleton");
  });
  it("renders hero carousel and grid from real stores", async () => {
    const stores = Array.from({ length: 8 }, (_, i) => ({ id: `id${String(i)}`, slug: `store-${String(i)}`, nameAr: `متجر ${String(i)}`, nameEn: `Store ${String(i)}`, kind: "local" as const }));
    setApiClient(stubClient({ listStores: () => Promise.resolve({ stores, nextCursor: null, reason: "OK" }) }));
    const html = await render(Village({ params: Promise.resolve({ segment: "eg-ar" }) }));
    expect(html).toContain("/eg-ar/stores/store-3");
    expect(html).toContain("متجر 0");
    expect(html).toContain("Discover your next favorite store.".length ? "اكتشف متجرك المفضل الجديد." : "");
  });
});

describe("store page", () => {
  it("renders header, breadcrumb, shelf wall and server-rendered quick view from ?p=", async () => {
    setApiClient(stubClient());
    const html = await render(StorePage({ params: Promise.resolve({ segment: "eg-en", slug: "nile-outlet" }), searchParams: Promise.resolve({ p: "prod2" }) }));
    expect(html).toContain("Nile Outlet");
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("Jacket 6");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('"@type":"Store"');
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"price":"800.00"');
    expect(html).not.toContain("style=");
  });
  it("shows no quick view for an unknown ?p= and an empty state with no products", async () => {
    setApiClient(stubClient({ listStoreProducts: () => Promise.resolve({ items: [], nextCursor: null }) }));
    const html = await render(StorePage({ params: Promise.resolve({ segment: "eg-en", slug: "nile-outlet" }), searchParams: Promise.resolve({ p: "nope" }) }));
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("no products yet");
  });
  it("renders not-available when the store is missing", async () => {
    setApiClient(stubClient({ getStore: () => Promise.resolve(null) }));
    const html = await render(StorePage({ params: Promise.resolve({ segment: "eg-en", slug: "nile-outlet" }), searchParams: Promise.resolve({}) }));
    expect(html).toContain("not available right now");
  });
});

describe("deals page and price honesty", () => {
  it("shows the no-verified-discounts copy and no band when the API has none", async () => {
    setApiClient(stubClient());
    const html = await render(Deals({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(html).toContain("No verified discounts yet");
    expect(html).not.toMatch(/OFF|%/);
  });
  it("only a verified_discount claim on a public store yields evidence", () => {
    const verified = product(1, { claimType: "verified_discount", referenceAmountMinor: 200_000n, referenceCurrency: "EGP" });
    expect(toPricing(verified, store)?.verified).toBeDefined();
    expect(toPricing(verified, { discountDisplayMode: "member_only" })?.verified).toBeUndefined();
    expect(toPricing(verified, { discountDisplayMode: "hidden" })?.verified).toBeUndefined();
    expect(toPricing(product(1, { claimType: "lowest_30d", referenceAmountMinor: 200_000n, referenceCurrency: "EGP" }), store)?.verified).toBeUndefined();
    expect(toPricing(product(1, { claimType: "verified_discount" }), store)?.verified).toBeUndefined();
    expect(toPricing(product(1, { currency: "XXX" }), store)).toBeNull();
  });
});

describe("stores directory page", () => {
  const stores = Array.from({ length: 3 }, (_, i) => ({ id: `id${String(i)}`, slug: `store-${String(i)}`, nameAr: `متجر ${String(i)}`, nameEn: `Store ${String(i)}`, kind: "global" as const }));
  it("renders filters, grid and a link-based load-more cursor, and passes the filters to the API", async () => {
    const seen: unknown[] = [];
    setApiClient(stubClient({
      listStores: (_m, o) => { seen.push(o); return Promise.resolve({ stores, nextCursor: "CUR", reason: "OK" }); },
      listCategories: () => Promise.resolve([{ id: "6f1c1f0e-0000-4000-8000-000000000009", parentId: null, depth: 0, nameAr: "أزياء", nameEn: "Fashion", slug: "fashion" }]),
    }));
    const html = await render(Stores({ params: Promise.resolve({ segment: "eg-en" }), searchParams: Promise.resolve({ world: "global", cursor: "abc" }) }));
    expect(seen[0]).toMatchObject({ world: "global", cursor: "abc", limit: 18 });
    expect(html).toContain("/eg-en/stores/store-1");
    expect(html).toContain("Fashion");
    expect(html).toContain('rel="next" href="/eg-en/stores?world=global&amp;cursor=CUR"');
    expect(html).toContain('aria-current="true">Global');
  });
  it("shows an honest empty state and no load-more", async () => {
    setApiClient(stubClient());
    const html = await render(Stores({ params: Promise.resolve({ segment: "eg-en" }), searchParams: Promise.resolve({ world: "bogus", category: "not-a-uuid" }) }));
    expect(html).toContain("No stores match these filters.");
    expect(html).not.toContain("Load more");
  });
});

describe("product page", () => {
  it("renders legal identity, no % without evidence, and JSON-LD Offer", async () => {
    setApiClient(stubClient({ getProduct: () => Promise.resolve(detail()) }));
    const html = await render(ProductPage({ params: Promise.resolve({ segment: "eg-ar", id: "prod1" }) }));
    expect(html).toContain("CR-12345");
    expect(html).toContain("TC-67890");
    expect(html).toContain("القاهرة");
    expect(html).toContain("نيل للتجارة");
    expect(html).not.toMatch(/%|<s>|<del>/);
    expect(html).toContain('"@type":"Offer"');
    expect(html).toContain('"price":"800.00"');
  });
  it("omits the Offer when there is no price and the unavailable state when missing", async () => {
    setApiClient(stubClient({ getProduct: () => Promise.resolve(detail({ skus: [] })) }));
    const html = await render(ProductPage({ params: Promise.resolve({ segment: "eg-en", id: "prod1" }) }));
    expect(html).not.toContain('"@type":"Offer"');
    expect(html).toContain("No price is available");
    setApiClient(stubClient());
    expect(await render(ProductPage({ params: Promise.resolve({ segment: "eg-en", id: "prod1" }) }))).toContain("Currently unavailable");
  });
});

describe("deals page with verified items", () => {
  it("renders a band only when it has items", async () => {
    const verified = product(1, { claimType: "verified_discount", amountMinor: 40_000n, referenceAmountMinor: 200_000n, referenceCurrency: "EGP" });
    setApiClient(stubClient({ listDeals: (_m, band) => Promise.resolve(band === "59_50" ? [verified] : []) }));
    const html = await render(Deals({ params: Promise.resolve({ segment: "eg-en" }) }));
    expect(html).toContain("59%–50% OFF");
    expect(html).not.toContain("70%–60%");
    expect(html).not.toContain("49%–40%");
    expect(html).toContain("/eg-en/p/prod1");
    expect(html).not.toContain("No verified discounts yet");
  });
});
