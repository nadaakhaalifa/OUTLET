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

import { setApiClient } from "../src/server/api-client";
import { product, store, stubClient } from "./fixtures";
import { toPricing } from "../src/lib/present";

const { default: Village } = await import("../src/app/[segment]/page");
const { default: StorePage } = await import("../src/app/[segment]/stores/[slug]/page");
const { default: Deals } = await import("../src/app/[segment]/deals/page");

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
    const stores = Array.from({ length: 8 }, (_, i) => ({ slug: `store-${String(i)}`, nameAr: `متجر ${String(i)}`, nameEn: `Store ${String(i)}`, kind: "local" as const }));
    setApiClient(stubClient({ listStores: () => Promise.resolve({ stores, reason: "OK" }) }));
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
