import type { StylistStore } from "../domain/ports";

/** Minimum distinct shoppers behind any figure shown to a seller (master prompt 19.1, k-anonymity). */
export const INCLUSION_K = 50;

export interface InclusionView {
  readonly storeId: string;
  /** True when fewer than K distinct shoppers back the aggregate: every figure is then null. */
  readonly suppressed: boolean;
  readonly outfits: number | null;
  readonly distinctShoppers: number | null;
  readonly addedToBagOutfits: number | null;
}

export class GetStoreInclusion {
  constructor(private readonly store: StylistStore) {}
  async execute(storeIds: readonly string[], fromMs: number, toMs: number): Promise<readonly InclusionView[]> {
    const rows = await this.store.inclusionByStore(storeIds, fromMs, toMs);
    return rows.map((r) =>
      r.distinctShoppers >= INCLUSION_K
        ? { storeId: r.storeId, suppressed: false, outfits: r.outfits, distinctShoppers: r.distinctShoppers, addedToBagOutfits: r.addedToBagOutfits }
        : { storeId: r.storeId, suppressed: true, outfits: null, distinctShoppers: null, addedToBagOutfits: null },
    );
  }
}
