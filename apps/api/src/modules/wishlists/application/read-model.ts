import { activeCoolOff, isShareActive } from "../domain/wishlist";
import type { CatalogProduct, CatalogReadPort, ProductSummaryView } from "../domain/ports";
import type { Money, Wishlist, WishlistItem } from "../domain/types";

export interface WishlistView {
  readonly list: Wishlist;
  readonly itemCount: number;
  readonly visibility: "private" | "shared";
}

export interface ItemView {
  readonly item: WishlistItem;
  readonly state: "active" | "delisted_ghost";
  readonly currentPrice: Money | null;
  /** Present only while the cool-off is still running. */
  readonly coolOffUntilMs: number | null;
  readonly product: ProductSummaryView | null;
}

export interface WishlistDetailView extends WishlistView {
  readonly items: readonly ItemView[];
}

export function viewOf(list: Wishlist, itemCount: number, nowMs: number): WishlistView {
  return { list, itemCount, visibility: isShareActive(list.share, nowMs) ? "shared" : "private" };
}

/**
 * Reads products and degrades to "unknown" (null) when the catalog is unavailable, so a
 * catalog outage never turns into a wrongly "delisted" item or a failed read.
 */
export async function readCatalog(
  catalog: CatalogReadPort,
  productIds: readonly string[],
): Promise<ReadonlyMap<string, CatalogProduct> | null> {
  if (productIds.length === 0) return new Map();
  try {
    return await catalog.products([...new Set(productIds)]);
  } catch {
    return null;
  }
}

export function itemView(item: WishlistItem, catalog: ReadonlyMap<string, CatalogProduct> | null, nowMs: number): ItemView {
  const coolOffUntilMs = activeCoolOff(item, nowMs);
  if (catalog === null) {
    return { item, state: "active", currentPrice: null, coolOffUntilMs, product: null };
  }
  const p = catalog.get(item.productId);
  if (p === undefined || !p.listed) {
    return { item, state: "delisted_ghost", currentPrice: null, coolOffUntilMs, product: p?.summary ?? null };
  }
  return { item, state: "active", currentPrice: p.currentPrice, coolOffUntilMs, product: p.summary };
}
