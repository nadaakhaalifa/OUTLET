import { publicDiscountPct, publicRating, type FavoriteRepository, type StoreRepository } from "../../stores";
import type { StoreSummaryFacts, StoreSummaryPort } from "../domain/ports";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Store cards from the stores module's repositories. Rating, follower count and max verified discount follow
 * the stores module's own public rules (no rating without reviews, only integer verified discounts).
 * A store that is not shopper-visible (status, KYC, published legal identity) is omitted.
 * Note: follower counts come from FavoriteRepository.followerCounts(), which counts every store.
 */
export class StoresBackedSummaries implements StoreSummaryPort {
  constructor(
    private readonly stores: Pick<StoreRepository, "findById">,
    private readonly favorites: Pick<FavoriteRepository, "list" | "followerCounts">,
  ) {}

  async summaries(storeIds: readonly string[], viewerUserId: string): Promise<ReadonlyMap<string, StoreSummaryFacts>> {
    const out = new Map<string, StoreSummaryFacts>();
    if (storeIds.length === 0) return out;
    const [followers, mine] = await Promise.all([
      this.favorites.followerCounts(),
      UUID.test(viewerUserId) ? this.favorites.list(viewerUserId) : Promise.resolve([]),
    ]);
    const favorite = new Set(mine.map((f) => f.storeId));
    for (const id of storeIds) {
      const s = await this.stores.findById(id);
      if (s === null) continue;
      const visible = (s.status === "ACTIVE" || s.status === "PAUSED") && s.sellerKycState === "APPROVED" && s.legalIdentity !== null;
      if (!visible) continue;
      out.set(id, {
        id: s.id,
        slug: s.slug,
        name: { ar: s.nameAr, ...(s.nameEn === null ? {} : { en: s.nameEn }) },
        kind: s.kind,
        ...(s.logoUrl === null ? {} : { logoUrl: s.logoUrl }),
        ...(s.coverUrl === null ? {} : { coverUrl: s.coverUrl }),
        verifiedBadge: s.verifiedBadge,
        maxVerifiedDiscountPct: publicDiscountPct(s.stats.maxVerifiedDiscountPct),
        rating: publicRating(s.stats.ratingAvg, s.stats.ratingCount),
        ratingCount: s.stats.ratingCount,
        followerCount: followers.get(id) ?? 0,
        liveDrop: s.stats.liveDrop,
        isFavorite: favorite.has(id),
      });
    }
    return out;
  }
}
