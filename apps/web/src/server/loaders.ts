import { getApiClient, type DealBand, type ProductDetail, type StoreSummary } from "./api-client";

export function loadProduct(marketId: string, id: string): Promise<ProductDetail | null> {
  return getApiClient().getProduct(marketId, id);
}
export function loadStore(marketId: string, slug: string): Promise<StoreSummary | null> {
  return getApiClient().getStore(marketId, slug);
}
export function loadStores(marketId: string): Promise<readonly StoreSummary[]> {
  return getApiClient().listStores(marketId);
}
export function loadDealBands(marketId: string): Promise<readonly DealBand[]> {
  return getApiClient().listDealBands(marketId);
}
