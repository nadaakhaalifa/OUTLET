import { getApiClient, type DealBand, type ProductDetail, type ProductsPage, type StoreDirectory, type StoreProfile } from "./api-client";

export function loadProduct(marketId: string, id: string): Promise<ProductDetail | null> {
  return getApiClient().getProduct(marketId, id);
}
export function loadStore(marketId: string, slug: string): Promise<StoreProfile | null> {
  return getApiClient().getStore(marketId, slug);
}
/** Typed loader for the village; returns an empty list plus the reason until apps/api serves a directory route. */
export function loadStoreDirectory(marketId: string): Promise<StoreDirectory> {
  return getApiClient().listStores(marketId);
}
export function loadStoreProducts(marketId: string, slug: string, opts?: { readonly cursor?: string; readonly limit?: number }): Promise<ProductsPage> {
  return getApiClient().listStoreProducts(marketId, slug, opts);
}
export function loadDealBands(marketId: string): Promise<readonly DealBand[]> {
  return getApiClient().listDealBands(marketId);
}
