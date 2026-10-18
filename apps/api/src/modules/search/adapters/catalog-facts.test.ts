import { describe, expect, it } from "vitest";
import { ProductFactsUnavailableError, type StoreSummaryFacts, type StoreSummaryPort } from "../domain/ports";
import { InMemorySearchIndex } from "./in-memory";
import { CatalogBackedProductFacts } from "./catalog-facts";
import { P, S, doc } from "../test/index-contract";
import { FakeSnapshots, listed, unlisted } from "../test/snapshot-fixtures";

const store: StoreSummaryFacts = {
  id: S(1), slug: "s", name: { ar: "متجر" }, kind: "local", verifiedBadge: false, maxVerifiedDiscountPct: null,
  rating: null, ratingCount: 0, followerCount: 0, liveDrop: false, isFavorite: false,
};
const stores = (visible = true): StoreSummaryPort => ({ summaries: async (ids) => new Map(visible ? ids.map((i) => [i, store] as const) : []) });
const egp = (n: bigint) => ({ amount: n, currency: "EGP" as const });
const VIEWER = "00000000-0000-4000-8000-0000000000aa";

describe("CatalogBackedProductFacts", () => {
  it("never reads price or stock from the index: a stale index doc cannot change the facts", async () => {
    // The provider has no index dependency at all; prove it with a deliberately wrong index next to it.
    const index = new InMemorySearchIndex();
    await index.upsert(doc(1, { priceAmount: 1n, inStock: true }));
    const snaps = new FakeSnapshots();
    snaps.set(listed(1, { skus: [{ ...listed(1).skus[0]!, price: egp(150_000n), available: false }] }));
    const f = await new CatalogBackedProductFacts(snaps, stores()).products([P(1)], VIEWER);
    const row = f.get(P(1));
    expect(row?.unitPrice.amount).toBe(150_000n);
    expect(row?.purchasable).toBe(false);
    expect(Object.keys(new CatalogBackedProductFacts(snaps, stores()))).toEqual(["snapshots", "stores"]);
  });

  it("a product with no evidence shows no strike-through and no percentage", async () => {
    const snaps = new FakeSnapshots();
    snaps.set(listed(1));
    const row = (await new CatalogBackedProductFacts(snaps, stores()).products([P(1)], VIEWER)).get(P(1));
    expect(row).toMatchObject({ badge: "none", referencePrice: null, discountPct: null, purchasable: true });
  });

  it("a verified badge without its reference is downgraded; a complete one passes through", async () => {
    const snaps = new FakeSnapshots();
    const sku = listed(1).skus[0]!;
    snaps.set(listed(1, { skus: [{ ...sku, priceBlock: { badge: "verified_discount", referencePrice: null, discountPct: 30, claimId: "c" } }] }));
    snaps.set(listed(2, { skus: [{ ...sku, priceBlock: { badge: "verified_discount", referencePrice: egp(200_000n), discountPct: 25, claimId: "c" } }] }));
    const f = await new CatalogBackedProductFacts(snaps, stores()).products([P(1), P(2)], VIEWER);
    expect(f.get(P(1))).toMatchObject({ badge: "none", referencePrice: null, discountPct: null });
    expect(f.get(P(2))).toMatchObject({ badge: "verified_discount", discountPct: 25 });
  });

  it("brand appears only when the brand row exists", async () => {
    const snaps = new FakeSnapshots();
    snaps.set(listed(1));
    snaps.set(listed(2, { brandId: null, brand: null }));
    snaps.set(listed(3, { brandId: "00000000-0000-4000-d000-0000000000ee", brand: null }));
    const f = await new CatalogBackedProductFacts(snaps, stores()).products([P(1), P(2), P(3)], VIEWER);
    expect(f.get(P(1))?.brand).toEqual({ id: "00000000-0000-4000-d000-000000000001", name: { ar: "أكمي", en: "Acme" } });
    expect(f.get(P(2))?.brand).toBeUndefined();
    expect(f.get(P(3))?.brand).toBeUndefined();
  });

  it("omits unlisted, missing and hidden-store products; fails closed when the catalog throws", async () => {
    const snaps = new FakeSnapshots();
    snaps.set(listed(1));
    snaps.set(unlisted(2, 4));
    const ok = await new CatalogBackedProductFacts(snaps, stores()).products([P(1), P(2), P(3)], VIEWER);
    expect([...ok.keys()]).toEqual([P(1)]);
    expect((await new CatalogBackedProductFacts(snaps, stores(false)).products([P(1)], VIEWER)).size).toBe(0);
    const boom = { snapshot: async () => { throw new Error("db"); } };
    await expect(new CatalogBackedProductFacts(boom, stores()).products([P(1)], VIEWER)).rejects.toBeInstanceOf(ProductFactsUnavailableError);
  });

  it("enrichments owned by other modules stay absent so their filters fail closed", async () => {
    const snaps = new FakeSnapshots();
    snaps.set(listed(1));
    const row = (await new CatalogBackedProductFacts(snaps, stores()).products([P(1)], VIEWER)).get(P(1));
    for (const k of ["installmentsAvailable", "codAvailable", "payableWithStoreCredit", "inMySize", "freeDeliveryEligible", "fitsRemainingBudget"] as const) {
      expect(row?.[k]).toBeUndefined();
    }
    expect(row?.sponsored).toBe(false);
  });
});
