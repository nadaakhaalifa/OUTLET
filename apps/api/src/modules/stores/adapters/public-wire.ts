import { publicDiscountPct, publicRating } from "../domain/store";
import type { PublicStoreView } from "../application/public";

function localized(ar: string, en: string | null): { ar: string; en?: string } {
  return en === null ? { ar } : { ar, en };
}

/**
 * Explicit allow-list for the anonymous store representation (OpenAPI PublicStoreSummary). Built field
 * by field, never spread from the domain record: no seller id, KYC state, health score, status,
 * `is_favorite` or any other per-user value.
 */
export function toPublicSummary(v: PublicStoreView) {
  const s = v.store;
  return {
    id: s.id,
    slug: s.slug,
    name: localized(s.nameAr, s.nameEn),
    kind: s.kind,
    ...(s.logoUrl !== null ? { logo_url: s.logoUrl } : {}),
    ...(s.coverUrl !== null ? { cover_url: s.coverUrl } : {}),
    verified_badge: s.verifiedBadge,
    max_verified_discount_pct: publicDiscountPct(s.stats.maxVerifiedDiscountPct),
    rating: publicRating(s.stats.ratingAvg, s.stats.ratingCount),
    rating_count: s.stats.ratingCount,
    follower_count: v.followerCount,
    live_drop: s.stats.liveDrop,
  };
}

/** OpenAPI PublicStore. Legal identity is the B5 supplier identity (VR-P3-12 decides indexability, not exposure). */
export function toPublicStore(v: PublicStoreView) {
  const s = v.store;
  const li = s.legalIdentity;
  return {
    ...toPublicSummary(v),
    ...(s.descriptionAr !== null ? { description: localized(s.descriptionAr, s.descriptionEn) } : {}),
    legal_identity: {
      legal_name: li === null ? "" : li.legalNameAr,
      ...(li !== null && li.commercialRegisterNo !== null ? { commercial_register_no: li.commercialRegisterNo } : {}),
      ...(li !== null && li.taxCardNo !== null ? { tax_id: li.taxCardNo } : {}),
      ...(li !== null ? { governorate: li.governorate } : {}),
    },
    free_delivery_threshold: { amount: s.freeDeliveryThresholdAmount.toString(), currency: "EGP" as const },
    status: "active" as const,
  };
}

export const PUBLIC_STORE_SUMMARY_KEYS = [
  "id", "slug", "name", "kind", "logo_url", "cover_url", "verified_badge", "max_verified_discount_pct",
  "rating", "rating_count", "follower_count", "live_drop",
] as const;
