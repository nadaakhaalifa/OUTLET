/** DEVELOPMENT / TEST FIXTURE for the catalog port. Synthetic data only. */
import type { Money } from "../domain/bridge";
import {
  CatalogUnavailableError,
  type CatalogPort,
  type SkuFacts,
  type StoreFacts,
  type StoreSummaryFacts,
  type SuggestionFacts,
} from "../domain/ports";

export function storeSummary(id: string, over: Partial<StoreSummaryFacts> = {}): StoreSummaryFacts {
  return {
    id,
    slug: `store-${id.slice(-4)}`,
    name: { ar: "متجر تجريبي", en: "Synthetic store" },
    kind: "local",
    verifiedBadge: false,
    maxVerifiedDiscountPct: null,
    rating: null,
    ratingCount: 0,
    followerCount: 0,
    liveDrop: false,
    isFavorite: false,
    ...over,
  };
}

export class FakeCatalog implements CatalogPort {
  private readonly skuMap = new Map<string, SkuFacts>();
  private readonly storeMap = new Map<string, StoreFacts>();
  private readonly candidates = new Map<string, SuggestionFacts[]>();
  failing = false;
  calls = 0;

  addStore(storeId: string, over: Partial<StoreFacts> & { summary?: Partial<StoreSummaryFacts> } = {}): void {
    const { summary, ...rest } = over;
    this.storeMap.set(storeId, {
      summary: storeSummary(storeId, summary),
      open: true,
      freeDeliveryThreshold: null,
      standardDeliveryFee: { amount: 4_500n, currency: "EGP" },
      ...rest,
    });
  }

  setStoreOpen(storeId: string, open: boolean): void {
    const s = this.storeMap.get(storeId);
    if (s !== undefined) this.storeMap.set(storeId, { ...s, open });
  }

  setStoreThreshold(storeId: string, threshold: Money | null): void {
    const s = this.storeMap.get(storeId);
    if (s !== undefined) this.storeMap.set(storeId, { ...s, freeDeliveryThreshold: threshold });
  }

  addSku(facts: SkuFacts): void {
    this.skuMap.set(facts.skuId, facts);
  }

  setPrice(skuId: string, unitPrice: Money): void {
    const s = this.skuMap.get(skuId);
    if (s !== undefined) this.skuMap.set(skuId, { ...s, unitPrice });
  }

  setAvailable(skuId: string, available: boolean): void {
    const s = this.skuMap.get(skuId);
    if (s !== undefined) this.skuMap.set(skuId, { ...s, available });
  }

  delist(skuId: string): void {
    this.skuMap.delete(skuId);
  }

  setCandidates(storeId: string, items: SuggestionFacts[]): void {
    this.candidates.set(storeId, items);
  }

  private guard(): void {
    this.calls += 1;
    if (this.failing) throw new CatalogUnavailableError();
  }

  async skus(ids: readonly string[]): Promise<ReadonlyMap<string, SkuFacts>> {
    this.guard();
    return new Map(ids.flatMap((id) => (this.skuMap.has(id) ? [[id, this.skuMap.get(id) as SkuFacts] as const] : [])));
  }

  async stores(ids: readonly string[]): Promise<ReadonlyMap<string, StoreFacts>> {
    this.guard();
    return new Map(ids.flatMap((id) => (this.storeMap.has(id) ? [[id, this.storeMap.get(id) as StoreFacts] as const] : [])));
  }

  async freeDeliveryCandidates(q: {
    storeId: string;
    excludeSkuIds: readonly string[];
    limit: number;
  }): Promise<readonly SuggestionFacts[]> {
    this.guard();
    return (this.candidates.get(q.storeId) ?? []).filter((c) => !q.excludeSkuIds.includes(c.skuId)).slice(0, q.limit);
  }
}
