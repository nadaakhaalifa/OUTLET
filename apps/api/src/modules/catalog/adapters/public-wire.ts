import { moneyToWire } from "@outlet/validation";
import type { PublicProduct } from "../application/products";
import type { CategoryRecord } from "../domain/ports";
import type { PublicSellerIdentity, PublicSku } from "../domain/catalog-domain";
import { sellerIdentityWire } from "./wire";

const iso = (ms: number): string => new Date(ms).toISOString();

/** OpenAPI PublicPriceBlock: no installment quote (provider quotes are per buyer and address). */
function priceBlock(sku: PublicSku) {
  const b = sku.priceBlock;
  return {
    price: moneyToWire(sku.price),
    badge: b.badge,
    reference_price: b.referencePrice === null ? null : moneyToWire(b.referencePrice),
    discount_pct: b.discountPct,
    claim_id: b.claimId,
  };
}

/**
 * Explicit allow-list for the anonymous product representation (OpenAPI PublicProduct). Every key is
 * written by hand; the source records are never spread. Deliberately absent compared with the shopper
 * `Product`: `store.is_favorite`, `skus[].barcode_gtin`, `price.installment_quote`, `delivery_eta`,
 * `video_url`. `units_left` is already null above 5 (domain rule, re-asserted here).
 */
export function publicProductWire(p: PublicProduct) {
  const v = p.view;
  const sorted = [...v.skus].sort((a, b) => (a.price.amount < b.price.amount ? -1 : a.price.amount > b.price.amount ? 1 : 0));
  const headline = sorted[0];
  if (headline === undefined) throw new Error("public product without a listed SKU");
  const first = p.images[0];
  const identity: PublicSellerIdentity | null = v.sellerIdentity;
  return {
    id: v.id,
    title: { ar: v.title.ar, ...(v.title.en !== undefined ? { en: v.title.en } : {}) },
    store: {
      id: p.store.id,
      slug: p.store.slug,
      name: { ar: p.store.nameAr, ...(p.store.nameEn !== undefined ? { en: p.store.nameEn } : {}) },
      kind: p.store.kind,
      verified_badge: p.store.verifiedBadge,
      live_drop: p.store.liveDrop,
    },
    ...(first !== undefined
      ? { image_url: first.url, ...(first.cutoutUrl !== undefined ? { cutout_url: first.cutoutUrl } : {}), ...(first.blurhash !== undefined ? { blurhash: first.blurhash } : {}) }
      : {}),
    price: priceBlock(headline),
    condition: v.condition,
    department: v.department,
    sponsored: false,
    ...(v.description !== undefined ? { description: { ar: v.description.ar, ...(v.description.en !== undefined ? { en: v.description.en } : {}) } } : {}),
    images: p.images.map((i) => ({ url: i.url, ...(i.blurhash !== undefined ? { blurhash: i.blurhash } : {}), ...(i.cutoutUrl !== undefined ? { cutout_url: i.cutoutUrl } : {}) })),
    skus: v.skus.map((s) => ({
      id: s.id,
      size_label: s.sizeLabel,
      ...(s.color !== undefined ? { color: s.color } : {}),
      available: s.available,
      units_left: s.unitsLeft !== null && s.unitsLeft >= 1 && s.unitsLeft <= 5 ? s.unitsLeft : null,
      price: priceBlock(s),
    })),
    ...(v.material !== undefined ? { material: v.material } : {}),
    ...(p.defectPhotos.length > 0 ? { defect_photos: p.defectPhotos.map((d) => d.url) } : {}),
    return_eligibility: {
      returnable: v.returnEligibility.returnable,
      ...(v.returnEligibility.windowDays !== undefined ? { window_days: v.returnEligibility.windowDays } : {}),
      ...(v.returnEligibility.reasonCode !== undefined ? { reason_code: v.returnEligibility.reasonCode } : {}),
    },
    seller_legal_identity_visible: identity !== null,
    ...(identity !== null ? { seller_legal_identity: sellerIdentityWire(identity) } : {}),
    size_chart_available: v.sizeChartAvailable,
    updated_at: iso(v.updatedAtMs),
  };
}

/**
 * Explicit allow-list for the anonymous category tree (OpenAPI PublicCategoryList). `position` is the
 * zero-based rank among siblings, ordered by slug (the taxonomy has no stored order, so this is stable
 * and deterministic). Deliberately absent compared with the seller `Category`: `product_type`,
 * `requires_size_chart`, `active`. A category whose parent is not active is re-rooted nowhere: it is
 * dropped with its subtree so the tree never has a dangling `parent_id`.
 */
export function publicCategoriesWire(all: readonly CategoryRecord[]) {
  const active = all.filter((c) => c.active);
  const ids = new Set(active.map((c) => c.id));
  const visible = active.filter((c) => c.parentId === undefined || ids.has(c.parentId));
  const rank = new Map<string, number>();
  const groups = new Map<string, CategoryRecord[]>();
  for (const c of visible) {
    const k = c.parentId ?? "";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)).forEach((c, i) => rank.set(c.id, i));
  }
  const ordered = [...visible].sort((a, b) => {
    const pa = a.parentId ?? "";
    const pb = b.parentId ?? "";
    return pa === pb ? (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) : pa < pb ? -1 : 1;
  });
  return {
    items: ordered.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: { ar: c.nameAr, ...(c.nameEn !== undefined ? { en: c.nameEn } : {}) },
      parent_id: c.parentId ?? null,
      position: rank.get(c.id) ?? 0,
      return_class: c.returnClass,
    })),
  };
}
