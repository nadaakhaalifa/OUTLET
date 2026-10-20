import type { Money } from "../domain/bridge";
import type { SearchOutcome } from "../application/search";
import type { LocalizedText, ProductFacts, SavedSearchRecord, StoreSummaryFacts } from "../domain/ports";
import { FacetCountsWireSchema, filterToWire } from "../domain/schema";

const iso = (ms: number): string => new Date(ms).toISOString();
const text = (t: LocalizedText) => ({ ar: t.ar, ...(t.en !== undefined ? { en: t.en } : {}) });
const moneyWire = (m: Money): { amount: string; currency: "EGP" } => ({ amount: m.amount.toString(), currency: m.currency });

export function storeWire(s: StoreSummaryFacts) {
  return {
    id: s.id,
    slug: s.slug,
    name: text(s.name),
    kind: s.kind,
    ...(s.logoUrl !== undefined ? { logo_url: s.logoUrl } : {}),
    ...(s.coverUrl !== undefined ? { cover_url: s.coverUrl } : {}),
    verified_badge: s.verifiedBadge,
    max_verified_discount_pct: s.maxVerifiedDiscountPct,
    rating: s.rating,
    rating_count: s.ratingCount,
    follower_count: s.followerCount,
    live_drop: s.liveDrop,
    is_favorite: s.isFavorite,
  };
}

/** A % off or reference price is emitted only for a verified badge with evidence (spec 5, 9). */
export function productWire(f: ProductFacts, sponsored: boolean) {
  const verified = f.badge === "verified_discount" && f.referencePrice !== null && f.discountPct !== null;
  return {
    id: f.productId,
    title: text(f.title),
    store: storeWire(f.store),
    ...(f.imageUrl !== undefined ? { image_url: f.imageUrl } : {}),
    ...(f.blurhash !== undefined ? { blurhash: f.blurhash } : {}),
    price: {
      price: moneyWire(f.unitPrice),
      badge: verified ? f.badge : f.badge === "verified_discount" ? ("none" as const) : f.badge,
      reference_price: verified && f.referencePrice !== null ? moneyWire(f.referencePrice) : null,
      discount_pct: verified ? f.discountPct : null,
    },
    condition: f.condition,
    ...(f.department !== undefined ? { department: f.department } : {}),
    ...(f.brand !== undefined ? { brand: { id: f.brand.id, name: text(f.brand.name) } } : {}),
    sponsored,
  };
}

export function searchResultsWire(o: SearchOutcome) {
  return {
    items: o.items.map((i) => productWire(i.facts, i.sponsored)),
    page: { next_cursor: o.nextCursor, has_more: o.nextCursor !== null },
    total_estimate: o.totalEstimate,
    applied_filters: filterToWire(o.appliedFilter),
    relaxed_filter: o.relaxedFilters.length > 0 ? o.relaxedFilters.join(",") : null,
    did_you_mean: o.didYouMean,
    degraded: o.degraded,
    ...(o.facetCounts !== undefined && !o.degraded
      ? {
          facet_counts: FacetCountsWireSchema.parse({
            category_ids: o.facetCounts.categories,
            store_ids: o.facetCounts.stores,
          }),
        }
      : {}),
  };
}

export function savedSearchWire(r: SavedSearchRecord) {
  return {
    id: r.id,
    name: r.name,
    ...(r.query !== null ? { query: r.query } : {}),
    filter: filterToWire(r.filter),
    alert_enabled: r.alertEnabled,
    last_run_at: r.lastRunAtMs === null ? null : iso(r.lastRunAtMs),
    created_at: iso(r.createdAtMs),
  };
}
