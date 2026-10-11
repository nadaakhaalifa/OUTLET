import { moneyToWire } from "@outlet/validation";
import { sha256Hex } from "@outlet/idempotency";
import type { Issue, PriceBlockInput, Product, PublicSellerIdentity, PublicSku } from "../domain/catalog-domain";
import type { PublicProduct } from "../application/products";
import type { ImportRecord, StockLevel } from "../domain/ports";
import { errorReportDataUri } from "../application/imports";

const iso = (ms: number): string => new Date(ms).toISOString();

export function priceBlockWire(sku: PublicSku) {
  const b = sku.priceBlock;
  return {
    price: moneyToWire(sku.price),
    badge: b.badge,
    reference_price: b.referencePrice === null ? null : moneyToWire(b.referencePrice),
    discount_pct: b.discountPct,
    claim_id: b.claimId,
    installment_quote: null,
  };
}

/** Explicit allow-list of the four B5 fields. Never spread the source record. */
export function sellerIdentityWire(i: PublicSellerIdentity) {
  return {
    legal_name: i.legalName,
    commercial_register_no: i.commercialRegisterNo,
    tax_card_no: i.taxCardNo,
    governorate: i.governorate,
  };
}

export function publicProductWire(p: PublicProduct) {
  const v = p.view;
  // Headline price: the cheapest listed SKU, with its own block. Nothing is invented.
  const headline = [...v.skus].sort((a, b) => (a.price.amount < b.price.amount ? -1 : a.price.amount > b.price.amount ? 1 : 0))[0];
  const first = p.images[0];
  return {
    id: v.id,
    title: v.title,
    store: {
      id: p.store.id,
      slug: p.store.slug,
      name: { ar: p.store.nameAr, ...(p.store.nameEn !== undefined ? { en: p.store.nameEn } : {}) },
      kind: p.store.kind,
      verified_badge: p.store.verifiedBadge,
      live_drop: p.store.liveDrop,
      is_favorite: p.store.isFavorite,
    },
    ...(first !== undefined ? { image_url: first.url, ...(first.blurhash !== undefined ? { blurhash: first.blurhash } : {}) } : {}),
    price:
      headline === undefined
        ? { price: moneyToWire({ amount: 0n, currency: "EGP" }), badge: "none", reference_price: null, discount_pct: null, claim_id: null, installment_quote: null }
        : priceBlockWire(headline),
    condition: v.condition,
    sponsored: false,
    ...(v.description !== undefined ? { description: v.description } : {}),
    images: p.images.map((i) => ({ url: i.url, ...(i.blurhash !== undefined ? { blurhash: i.blurhash } : {}) })),
    skus: v.skus.map((s) => ({
      id: s.id,
      size_label: s.sizeLabel,
      ...(s.color !== undefined ? { color: s.color } : {}),
      ...(s.gtin !== undefined ? { barcode_gtin: s.gtin } : {}),
      available: s.available,
      units_left: s.unitsLeft,
      price: priceBlockWire(s),
    })),
    ...(v.material !== undefined ? { material: v.material } : {}),
    ...(p.defectPhotos.length > 0 ? { defect_photos: p.defectPhotos.map((d) => d.url) } : {}),
    return_eligibility: {
      returnable: v.returnEligibility.returnable,
      ...(v.returnEligibility.windowDays !== undefined ? { window_days: v.returnEligibility.windowDays } : {}),
      ...(v.returnEligibility.reasonCode !== undefined ? { reason_code: v.returnEligibility.reasonCode } : {}),
    },
    seller_legal_identity_visible: v.sellerLegalIdentityVisible,
    ...(v.sellerIdentity !== null ? { seller_legal_identity: sellerIdentityWire(v.sellerIdentity) } : {}),
    size_chart_available: v.sizeChartAvailable,
    updated_at: iso(v.updatedAtMs),
  };
}

function claimState(b: PriceBlockInput | undefined): "none" | "verified_discount" | "lowest_30d" | "launch_price" {
  return b === undefined ? "none" : b.badge;
}

export function sellerProductWire(
  p: Product,
  levels: ReadonlyMap<string, StockLevel>,
  blocks?: ReadonlyMap<string, PriceBlockInput>,
) {
  const firstSku = p.skus[0];
  return {
    id: p.id,
    status: p.status,
    title: p.title,
    ...(p.description !== undefined ? { description: p.description } : {}),
    category_id: p.categoryId,
    ...(p.brandId !== undefined ? { brand_id: p.brandId } : {}),
    condition: p.condition,
    ...(p.material !== undefined ? { material: p.material } : {}),
    image_upload_ids: p.imageUploadIds,
    defect_photo_upload_ids: p.defectPhotoUploadIds,
    ...(p.sizeChartId !== undefined ? { size_chart_id: p.sizeChartId } : {}),
    skus: p.skus.map((s) => {
      const l = levels.get(s.id);
      return {
        id: s.id,
        ...(s.sellerSku !== undefined ? { seller_sku: s.sellerSku } : {}),
        ...(s.gtin !== undefined ? { barcode_gtin: s.gtin } : {}),
        size_label: s.sizeLabel,
        ...(s.color !== undefined ? { color: s.color } : {}),
        price: moneyToWire(s.price),
        on_hand: l?.onHand ?? 0,
        available: l?.available ?? 0,
      };
    }),
    price_claim_state: claimState(firstSku === undefined ? undefined : blocks?.get(firstSku.id)),
    updated_at: iso(p.updatedAtMs),
  };
}

/** Strong validator for seller reads and If-Match: version plus the stock the body shows. */
export function sellerEtag(p: Product, levels: ReadonlyMap<string, StockLevel>): string {
  const stock = p.skus.map((s) => `${s.id}:${levels.get(s.id)?.onHand ?? 0}:${levels.get(s.id)?.available ?? 0}`).join(",");
  return `"${sha256Hex(`catalog.seller.v1|${p.id}|${p.version}|${stock}`).slice(0, 32)}"`;
}

export function publicEtag(wire: unknown): string {
  return `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
}

export function importWire(r: ImportRecord) {
  return {
    id: r.id,
    status: r.status,
    dry_run: r.dryRun,
    rows_total: r.rowsTotal,
    rows_ok: r.rowsOk,
    rows_failed: r.rowsFailed,
    error_report_url: errorReportDataUri(r.errors),
    created_at: iso(r.createdAtMs),
  };
}

export function issuesToViolations(issues: readonly Issue[]): { pointer: string; code: string }[] {
  return issues.map((i) => ({ pointer: i.pointer, code: i.code }));
}
