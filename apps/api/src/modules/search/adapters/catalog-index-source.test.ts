import { createProduct } from "@outlet/domain";
import { describe, expect, it } from "vitest";
import { SEED, createCatalogDevFixtures, createCatalogDevListingSnapshots, type CatalogDevFixtures } from "../../catalog";
import { CatalogBackedProductFacts } from "./catalog-facts";
import { CatalogIndexSource } from "./catalog-index-source";

const STORE = "00000000-0000-4000-a000-000000000001";
const egp = (n: bigint) => ({ amount: n, currency: "EGP" as const });
let seq = 0;
const newId = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function seed(f: CatalogDevFixtures, over: { brandId?: string; status?: "active" | "draft" | "delisted"; stock?: number } = {}) {
  f.stores.set({
    id: STORE, slug: "s", nameAr: "متجر", kind: "global", verifiedBadge: false, liveDrop: false, isFavorite: false,
    legal: { approved: true, legalName: "x", commercialRegisterNo: "1", taxCardNo: "2", governorate: "Cairo" }, visible: true,
  });
  const p = createProduct(
    { title: { ar: "فستان كتان أبيض", en: "White linen dress" }, categoryId: SEED.categoryDresses, ...(over.brandId === undefined ? {} : { brandId: over.brandId }), condition: "new_with_tags", imageUploadIds: [], defectPhotoUploadIds: [], skus: [{ sizeLabel: "M", color: "white", price: egp(129_900n) }] },
    { storeId: STORE, nowMs: 1_800_000_000_000, newId },
  );
  const product = { ...p, status: over.status ?? "active" } as typeof p;
  await f.products.insert(product);
  f.stock.set(product.skus[0]!.id, { onHand: over.stock ?? 3, available: over.stock ?? 3 });
  return product;
}

describe("CatalogIndexSource and facts over the catalog dev fixtures", () => {
  const clock = { nowMs: () => 1_800_000_000_000 };
  it("an unknown product is absent; a non-uuid id is absent", async () => {
    const src = new CatalogIndexSource(createCatalogDevListingSnapshots(createCatalogDevFixtures(), clock));
    expect(await src.load("00000000-0000-4000-b000-0000000000ff")).toEqual({ kind: "absent" });
    expect(await src.load("not-a-uuid")).toEqual({ kind: "absent" });
  });

  it("an active product maps with brand_id, world, real price and stock; no evidence means no discount", async () => {
    const f = createCatalogDevFixtures();
    const p = await seed(f, { brandId: SEED.brandAcme });
    const r = await new CatalogIndexSource(createCatalogDevListingSnapshots(f, clock)).load(p.id);
    expect(r.kind).toBe("listed");
    if (r.kind !== "listed") return;
    expect(r.version).toBe(p.version);
    expect(r.doc).toMatchObject({ brandId: SEED.brandAcme, world: "global", priceAmount: 129_900n, inStock: true, verifiedDiscountPct: null, categoryIds: [SEED.categoryDresses] });
    expect(r.doc.searchText).toContain("أكمي");
  });

  it("a draft or delisted product is unlisted; sold-out stays listed but not in stock", async () => {
    const f = createCatalogDevFixtures();
    const snaps = createCatalogDevListingSnapshots(f, clock);
    const d = await seed(f, { status: "draft" });
    expect(await new CatalogIndexSource(snaps).load(d.id)).toMatchObject({ kind: "unlisted" });
    const f2 = createCatalogDevFixtures();
    const s = await seed(f2, { stock: 0 });
    const r = await new CatalogIndexSource(createCatalogDevListingSnapshots(f2, clock)).load(s.id);
    expect(r.kind === "listed" && r.doc.inStock).toBe(false);
  });

  it("facts read live stock from inventory, not from any index, and show no % off without evidence", async () => {
    const f = createCatalogDevFixtures();
    const p = await seed(f, { brandId: SEED.brandAcme });
    const snaps = createCatalogDevListingSnapshots(f, clock);
    const facts = new CatalogBackedProductFacts(snaps, { summaries: async (ids) => new Map(ids.map((i) => [i, { id: i, slug: "s", name: { ar: "متجر" }, kind: "global" as const, verifiedBadge: false, maxVerifiedDiscountPct: null, rating: null, ratingCount: 0, followerCount: 0, liveDrop: false, isFavorite: false }])) });
    const sku = p.skus[0]!.id;
    expect((await facts.products([p.id], "v")).get(p.id)).toMatchObject({ purchasable: true, badge: "none", referencePrice: null, discountPct: null, brand: { id: SEED.brandAcme, name: { ar: "أكمي", en: "Acme" } } });
    f.stock.set(sku, { onHand: 0, available: 0 });
    expect((await facts.products([p.id], "v")).get(p.id)?.purchasable).toBe(false);
  });
});
