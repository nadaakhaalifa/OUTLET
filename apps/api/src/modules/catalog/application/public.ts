import type { CatalogDeps, PublicProduct } from "./products";
import { GetPublicProduct } from "./products";

/**
 * Non-UUID on purpose: StoresProfileReader skips the favourites lookup for it, so nothing per-user is
 * read and `StoreProfile.isFavorite` is always false. The anonymous wire drops the field anyway.
 */
export const ANONYMOUS_PRODUCT_VIEWER = "anonymous";

export const PRODUCT_SITEMAP_PAGE_SIZE = 500;
export const PRODUCT_SITEMAP_MAX_PAGE = 1000;

export type AnonymousProductResult =
  | { readonly kind: "ok"; readonly product: PublicProduct }
  | { readonly kind: "gone" }
  | { readonly kind: "not_found" };

/**
 * Anonymous product read (spec P3-06). Visible only when the product is `active`, its store is ACTIVE
 * (not on vacation, suspended or unapproved) and it still has at least one listed SKU. A delisted
 * product of a public store is 410; everything else that is not public is indistinguishable from a
 * missing id (404), including every product of a non-public store.
 */
export class GetAnonymousProduct {
  private readonly read: GetPublicProduct;
  constructor(private readonly deps: CatalogDeps) {
    this.read = new GetPublicProduct(deps);
  }

  async execute(productId: string): Promise<AnonymousProductResult> {
    const product = await this.deps.products.findById(productId);
    if (product === null) return { kind: "not_found" };
    const store = await this.deps.stores.profile(product.storeId, ANONYMOUS_PRODUCT_VIEWER);
    if (store === null || !store.visible || store.paused === true) return { kind: "not_found" };
    if (product.status === "delisted") return { kind: "gone" };
    if (product.status !== "active") return { kind: "not_found" };
    const found = await this.read.execute(productId, ANONYMOUS_PRODUCT_VIEWER);
    if (found === null) return { kind: "not_found" };
    if (found.view.skus.length === 0) return { kind: "gone" };
    return { kind: "ok", product: found };
  }
}

export interface ProductSitemapItem {
  readonly id: string;
  readonly updatedAtMs: number;
}

export class ListProductSitemap {
  constructor(private readonly deps: Pick<CatalogDeps, "products" | "stores">) {}

  /** 1-based page over active products ordered by id. Products of non-public stores are skipped. */
  async execute(page: number): Promise<{ readonly items: readonly ProductSitemapItem[]; readonly hasMore: boolean }> {
    const offset = (page - 1) * PRODUCT_SITEMAP_PAGE_SIZE;
    const stubs = await this.deps.products.listActiveStubs(offset, PRODUCT_SITEMAP_PAGE_SIZE + 1);
    const pageStubs = stubs.slice(0, PRODUCT_SITEMAP_PAGE_SIZE);
    const publicStore = new Map<string, boolean>();
    const items: ProductSitemapItem[] = [];
    for (const s of pageStubs) {
      let ok = publicStore.get(s.storeId);
      if (ok === undefined) {
        const p = await this.deps.stores.profile(s.storeId, ANONYMOUS_PRODUCT_VIEWER);
        ok = p !== null && p.visible && p.paused !== true;
        publicStore.set(s.storeId, ok);
      }
      if (ok) items.push({ id: s.id, updatedAtMs: s.updatedAtMs });
    }
    return { items, hasMore: stubs.length > PRODUCT_SITEMAP_PAGE_SIZE };
  }
}
