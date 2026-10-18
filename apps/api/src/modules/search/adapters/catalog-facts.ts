import {
  ProductFactsUnavailableError,
  type ListingSnapshotPort,
  type PriceBadge,
  type ProductFacts,
  type ProductFactsPort,
  type StoreSummaryPort,
} from "../domain/ports";

/**
 * Live facts for result rows. Price, availability and the price block are read from the catalog at call time
 * (which reads inventory and price-integrity); the search index is never consulted, so a stale document can
 * never put a wrong price or an out-of-stock item in front of a shopper. A % off or reference price is emitted
 * only when the catalog returns a verified claim with its reference. Enrichments owned by modules with no read
 * port here (installments, COD, store credit, size, budget, free delivery) are left absent: filters that need
 * them fail closed.
 */
export class CatalogBackedProductFacts implements ProductFactsPort {
  constructor(
    private readonly snapshots: ListingSnapshotPort,
    private readonly stores: StoreSummaryPort,
  ) {}

  async products(productIds: readonly string[], viewerUserId: string): Promise<ReadonlyMap<string, ProductFacts>> {
    try {
      const ids = [...new Set(productIds)];
      const snaps = await Promise.all(ids.map((id) => this.snapshots.snapshot(id)));
      const listed = snaps.flatMap((s) => (s !== null && s.listed ? [s] : []));
      const stores = await this.stores.summaries([...new Set(listed.map((s) => s.storeId))], viewerUserId);
      const out = new Map<string, ProductFacts>();
      for (const s of listed) {
        const store = stores.get(s.storeId);
        if (store === undefined) continue; // store not shopper-visible: hidden like a missing product
        const available = s.skus.filter((k) => k.available);
        const pool = available.length > 0 ? available : s.skus;
        const headline = [...pool].sort((a, b) => (a.price.amount < b.price.amount ? -1 : a.price.amount > b.price.amount ? 1 : 0))[0];
        if (headline === undefined) continue;
        const b = headline.priceBlock;
        const verified = b.badge === "verified_discount" && b.referencePrice !== null && b.discountPct !== null;
        const badge: PriceBadge = b.badge === "verified_discount" && !verified ? "none" : b.badge;
        out.set(s.productId, {
          productId: s.productId,
          title: s.title,
          store,
          ...(s.imageUrl === null ? {} : { imageUrl: s.imageUrl }),
          ...(s.blurhash === null ? {} : { blurhash: s.blurhash }),
          unitPrice: headline.price,
          badge,
          referencePrice: verified ? b.referencePrice : null,
          discountPct: verified ? b.discountPct : null,
          condition: s.condition,
          department: s.department,
          // Only when the brand row exists; the taxonomy has no active flag, so none is applied.
          ...(s.brand === null ? {} : { brand: { id: s.brand.id, name: { ar: s.brand.nameAr, ...(s.brand.nameEn === undefined ? {} : { en: s.brand.nameEn }) } } }),
          sponsored: false,
          purchasable: s.storeOpen && available.length > 0,
        });
      }
      return out;
    } catch {
      throw new ProductFactsUnavailableError();
    }
  }
}
