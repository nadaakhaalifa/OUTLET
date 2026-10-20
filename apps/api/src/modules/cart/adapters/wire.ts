import type { Money } from "../domain/bridge";
import type { BagGroupView, BagLineView, BagView, SuggestionsView } from "../application/bag";
import type { LocalizedText, StoreSummaryFacts, SuggestionFacts } from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();

export function moneyWire(m: Money): { amount: string; currency: "EGP" } {
  return { amount: m.amount.toString(), currency: m.currency };
}

const text = (t: LocalizedText) => ({ ar: t.ar, ...(t.en !== undefined ? { en: t.en } : {}) });

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

function lineWire(l: BagLineView) {
  return {
    id: l.id,
    sku_id: l.skuId,
    product_id: l.productId,
    title: text(l.title),
    ...(l.sizeLabel !== undefined ? { size_label: l.sizeLabel } : {}),
    ...(l.imageUrl !== undefined ? { image_url: l.imageUrl } : {}),
    qty: l.qty,
    unit_price: moneyWire(l.unitPrice),
    price_at_add: moneyWire(l.priceAtAdd),
    price_change: l.priceChange,
    availability: l.available ? ("available" as const) : ("unavailable" as const),
    ...(l.source !== null && l.source !== "reorder" && l.source !== "merged_guest" ? { source: l.source } : {}),
    saved_for_later: l.savedForLater,
  };
}

function groupWire(g: BagGroupView) {
  return {
    store: storeWire(g.store),
    status: g.status,
    lines: g.lines.map(lineWire),
    merchandise_subtotal: moneyWire(g.merchandiseSubtotal),
    free_delivery: {
      threshold: moneyWire(g.freeDelivery.threshold),
      remaining: moneyWire(g.freeDelivery.remaining),
      unlocked: g.freeDelivery.unlocked,
      plus_member: g.freeDelivery.plusMember,
    },
  };
}

export function cartWire(v: BagView) {
  return {
    id: v.cartId,
    groups: v.groups.map(groupWire),
    line_count: v.lineCount,
    updated_at: iso(v.updatedAtMs),
  };
}

function productWire(p: SuggestionFacts) {
  // A claim is shown only for a verified badge; everything else is forced to plain price.
  const verified = p.badge === "verified_discount" && p.referencePrice !== null && p.discountPct !== null;
  return {
    id: p.productId,
    sku_id: p.skuId,
    ...(p.sizeLabel !== undefined ? { size_label: p.sizeLabel } : {}),
    title: text(p.title),
    store: storeWire(p.store),
    ...(p.imageUrl !== undefined ? { image_url: p.imageUrl } : {}),
    ...(p.blurhash !== undefined ? { blurhash: p.blurhash } : {}),
    price: {
      price: moneyWire(p.unitPrice),
      badge: verified ? p.badge : p.badge === "verified_discount" ? ("none" as const) : p.badge,
      reference_price: verified && p.referencePrice !== null ? moneyWire(p.referencePrice) : null,
      discount_pct: verified ? p.discountPct : null,
    },
    condition: p.condition,
    sponsored: p.sponsored,
  };
}

export function suggestionsWire(v: SuggestionsView) {
  return {
    store_id: v.storeId,
    remaining: moneyWire(v.remaining),
    suggestions: v.suggestions.map(productWire),
  };
}
