import type { IndexSource, IndexSourcePort, IndexedProduct, ListingSnapshot, ListingSnapshotPort } from "../domain/ports";

type Listed = Extract<ListingSnapshot, { listed: true }>;

/**
 * Maps the catalog's current listing to the search read-model row. Everything here comes from the catalog
 * (price and stock from their owners through it). Fields no module reports yet stay at their honest neutral:
 * no rating, not sponsored, free delivery not asserted.
 */
export function toIndexedProduct(s: Listed): IndexedProduct {
  const available = s.skus.filter((k) => k.available);
  const pool = available.length > 0 ? available : s.skus;
  const headline = [...pool].sort((a, b) => (a.price.amount < b.price.amount ? -1 : a.price.amount > b.price.amount ? 1 : 0))[0];
  if (headline === undefined) throw new Error("listed snapshot without SKUs");
  const block = headline.priceBlock;
  // A % off is indexed only with the full verified evidence the catalog already enforces; anything else is null.
  const verified = block.badge === "verified_discount" && block.referencePrice !== null && block.discountPct !== null ? block.discountPct : null;
  const colors = [...new Set(s.skus.flatMap((k) => (k.color === null ? [] : [k.color])))];
  const brandNames = s.brand === null ? [] : [s.brand.nameAr, ...(s.brand.nameEn === undefined ? [] : [s.brand.nameEn])];
  const searchText = [s.title.ar, ...(s.title.en === undefined ? [] : [s.title.en]), ...brandNames, ...(s.material === null ? [] : [s.material]), ...colors].join(" ");
  return {
    productId: s.productId,
    storeId: s.storeId,
    world: s.storeKind,
    titleAr: s.title.ar,
    titleEn: s.title.en ?? null,
    searchText,
    priceAmount: headline.price.amount,
    colors,
    materials: s.material === null ? [] : [s.material],
    condition: s.condition,
    department: s.department,
    categoryIds: [s.categoryId],
    brandId: s.brandId,
    verifiedDiscountPct: verified,
    lowest30d: block.badge === "lowest_30d",
    freeDeliveryEligible: false,
    rating: null,
    sponsored: false,
    inStock: s.storeOpen && available.length > 0,
    listedAtMs: s.publishedAtMs ?? s.createdAtMs,
  };
}

export class CatalogIndexSource implements IndexSourcePort {
  constructor(private readonly snapshots: ListingSnapshotPort) {}

  async load(productId: string): Promise<IndexSource> {
    const s = await this.snapshots.snapshot(productId);
    if (s === null) return { kind: "absent" };
    if (!s.listed) return { kind: "unlisted", version: s.version };
    return { kind: "listed", version: s.version, doc: toIndexedProduct(s) };
  }
}
