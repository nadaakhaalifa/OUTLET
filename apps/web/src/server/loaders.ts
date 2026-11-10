import { DEAL_BANDS, type CategoryNode, type DealShelf, type ProductDetail, type ProductsPage, type StoreDirectory, type StoreProfile, type StoreQuery } from "./api-client";
import { getApiClient } from "./client-registry";

export function loadProduct(marketId: string, id: string): Promise<ProductDetail | null> {
  return getApiClient().getProduct(marketId, id);
}
export function loadStore(marketId: string, slug: string): Promise<StoreProfile | null> {
  return getApiClient().getStore(marketId, slug);
}
/** Keyset page of the stores directory (market-tagged, revalidated every 60 s). */
export function loadStoreDirectory(marketId: string, opts?: StoreQuery): Promise<StoreDirectory> {
  return getApiClient().listStores(marketId, opts);
}
/** Top-level categories only (the chips); the full tree stays available via the client. */
export async function loadRootCategories(marketId: string): Promise<readonly CategoryNode[]> {
  return (await getApiClient().listCategories(marketId)).filter((c) => c.depth === 0);
}
export function loadStoreProducts(marketId: string, slug: string, opts?: { readonly cursor?: string; readonly limit?: number }): Promise<ProductsPage> {
  return getApiClient().listStoreProducts(marketId, slug, opts);
}
/** The three verified-discount bands. A band with no items is dropped, never rendered as an empty header. */
export async function loadDealShelves(marketId: string): Promise<readonly DealShelf[]> {
  const client = getApiClient();
  const shelves = await Promise.all(DEAL_BANDS.map(async (band) => ({ band, items: await client.listDeals(marketId, band.code) })));
  return shelves.filter((s) => s.items.length > 0);
}
