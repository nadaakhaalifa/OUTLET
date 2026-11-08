import type { Queryable } from "@outlet/db";
import type { AttributeDef, AttributeType } from "../domain/attributes.js";
import type { DefectCard, MediaRef, StoreDetail } from "../domain/dto.js";
import type { ListingStatus } from "../domain/listing-state.js";
import { CatalogError, notFound } from "../domain/errors.js";
import { toIso } from "./env.js";
import type { Env } from "./env.js";

// ------------------------------------------------------------------ row shapes (explicit column lists, never SELECT *)
export interface ProductRow {
  id: string;
  store_id: string;
  brand_id: string | null;
  primary_category_id: string;
  status: ListingStatus;
  title_ar: string;
  title_en: string | null;
  description_ar: string;
  description_en: string | null;
  condition_grade_code: string;
  stock_reason: string | null;
  defect_card_id: string | null;
  attributes: Record<string, unknown>;
  colour_code: string | null;
  size_chart_id: string | null;
  warranty_months: number | null;
  warranty_kind: string | null;
  included_accessories_ar: string | null;
  origin_country: string | null;
  version: number;
  published_at: Date | null;
  updated_at: Date;
}
export const PRODUCT_COLS = `id, store_id, brand_id, primary_category_id, status, title_ar, title_en, description_ar, description_en,
  condition_grade_code, stock_reason, defect_card_id, attributes, colour_code, size_chart_id, warranty_months, warranty_kind,
  included_accessories_ar, origin_country, version, published_at, updated_at`;

export interface SkuRow {
  id: string;
  seller_sku: string;
  gtin: string | null;
  option_values: Record<string, unknown>;
  size_label: string | null;
  price_minor: string;
  currency: string;
  status: string;
  version: number;
}
export const SKU_COLS = "id, seller_sku, gtin, option_values, size_label, price_minor::text AS price_minor, currency, status, version";

export interface GradeRow {
  code: string;
  label_ar: string;
  label_en: string;
  schema_org_condition: string;
  requires_defect_card: boolean;
  requires_condition_photo: boolean;
  active: boolean;
}
export const GRADE_COLS = "code, label_ar, label_en, schema_org_condition, requires_defect_card, requires_condition_photo, active";

export interface CardRow {
  id: string;
  version: number;
  grade_code: string;
  stock_reason: string | null;
  summary_ar: string;
  summary_en: string | null;
  affects_function: boolean;
  defect_count: number;
  inspected_by: "seller" | "hub";
  inspected_at: Date;
  published_at: Date | null;
}
export const CARD_COLS = "id, version, grade_code, stock_reason, summary_ar, summary_en, affects_function, defect_count, inspected_by, inspected_at, published_at";

export interface ItemRow {
  id: string;
  defect_type_code: string;
  label_ar: string;
  label_en: string;
  location_ar: string;
  location_en: string | null;
  size_mm: number | null;
  severity: "minor" | "major";
  affects_function: boolean;
  photo_media_id: string;
  hotspot_x_bp: number | null;
  hotspot_y_bp: number | null;
  note_ar: string | null;
  note_en: string | null;
  position: number;
}

export interface MediaRow {
  id: string;
  media_id: string;
  role: string;
  position: number;
  alt_ar: string | null;
  alt_en: string | null;
}

// ------------------------------------------------------------------ loaders
export const loadAttributeSet = async (tx: Queryable, categoryId: string): Promise<AttributeDef[]> => {
  const r = await tx.query<{ code: string; data_type: AttributeType; enum_values: { code: string }[] | null; required: boolean }>(
    `SELECT ai.attribute_code AS code, ad.data_type, ad.enum_values, ai.required
       FROM (SELECT a.attribute_set_id AS sid
               FROM categories c
               JOIN categories a ON a.attribute_set_id IS NOT NULL AND (c.path = a.path OR starts_with(c.path, a.path || '/'))
              WHERE c.id = $1 ORDER BY a.depth DESC LIMIT 1) s
       JOIN attribute_set_items ai ON ai.attribute_set_id = s.sid
       JOIN attribute_definitions ad ON ad.code = ai.attribute_code
      ORDER BY ai.attribute_code`,
    [categoryId],
  );
  return r.rows.map((x) => ({ code: x.code, dataType: x.data_type, enumCodes: (x.enum_values ?? []).map((v) => v.code), required: x.required }));
};

export const categoryUsable = async (tx: Queryable, marketId: string, categoryId: string): Promise<boolean> => {
  const r = await tx.query<{ ok: number }>(
    `SELECT 1 AS ok FROM categories c JOIN market_categories mc ON mc.category_id = c.id AND mc.market_id = $2 AND mc.active
      WHERE c.id = $1 AND c.active`,
    [categoryId, marketId],
  );
  return r.rows.length === 1;
};

export const loadGrade = async (tx: Queryable, code: string): Promise<GradeRow | undefined> =>
  (await tx.query<GradeRow>(`SELECT ${GRADE_COLS} FROM condition_grades WHERE code = $1`, [code])).rows[0];

export const loadSkus = async (tx: Queryable, productId: string): Promise<SkuRow[]> =>
  (await tx.query<SkuRow>(`SELECT ${SKU_COLS} FROM skus WHERE product_id = $1 ORDER BY created_at, id`, [productId])).rows;

export const loadMedia = async (tx: Queryable, productId: string): Promise<MediaRow[]> =>
  (await tx.query<MediaRow>("SELECT id, media_id, role, position, alt_ar, alt_en FROM product_media WHERE product_id = $1 ORDER BY position", [productId])).rows;

export const loadCard = async (tx: Queryable, cardId: string): Promise<{ card: CardRow; items: ItemRow[] } | undefined> => {
  const c = (await tx.query<CardRow>(`SELECT ${CARD_COLS} FROM defect_cards WHERE id = $1`, [cardId])).rows[0];
  if (c === undefined) return undefined;
  const items = (
    await tx.query<ItemRow>(
      `SELECT i.id, i.defect_type_code, t.label_ar, t.label_en, i.location_ar, i.location_en, i.size_mm, i.severity, i.affects_function,
              i.photo_media_id, i.hotspot_x_bp, i.hotspot_y_bp, i.note_ar, i.note_en, i.position
         FROM defect_items i JOIN defect_types t ON t.code = i.defect_type_code
        WHERE i.defect_card_id = $1 ORDER BY i.position`,
      [cardId],
    )
  ).rows;
  return { card: c, items };
};

export interface StoreSellerRow {
  id: string;
  seller_id: string;
  slug: string;
  display_name_ar: string;
  display_name_en: string | null;
  tagline_ar: string | null;
  tagline_en: string | null;
  kind: "local" | "global";
  status: string;
  verified_badge: boolean;
  ships_from_country: string;
  followers_count: number;
  discount_display_mode: "public" | "member_only" | "hidden";
  price_trust_score: number | null;
  updated_at: Date;
  seller_status: string;
  legal_name_ar: string | null;
  legal_name_en: string | null;
  commercial_register_no: string | null;
  tax_card_no: string | null;
  governorate_name_ar: string | null;
}
export const loadStoreWithSeller = async (tx: Queryable, storeId: string): Promise<StoreSellerRow | undefined> =>
  (
    await tx.query<StoreSellerRow>(
      `SELECT s.id, s.seller_id, s.slug, s.display_name_ar, s.display_name_en, s.tagline_ar, s.tagline_en, s.kind, s.status, s.verified_badge,
              s.ships_from_country, s.followers_count, s.discount_display_mode, s.price_trust_score, s.updated_at,
              sel.status AS seller_status, sel.legal_name_ar, sel.legal_name_en, sel.commercial_register_no, sel.tax_card_no, sel.governorate_name_ar
         FROM stores s JOIN sellers sel ON sel.id = s.seller_id WHERE s.id = $1`,
      [storeId],
    )
  ).rows[0];

export interface LockedProduct {
  status: ListingStatus;
  version: number;
  condition_grade_code: string;
  stock_reason: string | null;
  defect_card_id: string | null;
  title_ar: string;
}

/** Row lock plus optimistic check (C6). Missing or foreign id is not_found (RLS hides other stores); stale version is a typed conflict. */
export const lockProduct = async (tx: Queryable, id: string, expectedVersion?: number): Promise<LockedProduct> => {
  const r = (
    await tx.query<LockedProduct>("SELECT status, version, condition_grade_code, stock_reason, defect_card_id, title_ar FROM products WHERE id = $1 FOR UPDATE", [id])
  ).rows[0];
  if (r === undefined) throw notFound("listing");
  if (expectedVersion !== undefined && r.version !== expectedVersion) {
    throw new CatalogError("conflict", "stale listing version", [`current=${String(r.version)}`, `expected=${String(expectedVersion)}`]);
  }
  return r;
};

// ------------------------------------------------------------------ mappers
export const mediaRef = (env: Env, mediaId: string, alt?: { ar: string | null; en: string | null }): MediaRef => ({
  media_id: mediaId,
  url: env.mediaUrl(mediaId),
  alt_ar: alt?.ar ?? null,
  alt_en: alt?.en ?? null,
});

export const defectCardDto = (env: Env, card: CardRow, items: readonly ItemRow[]): DefectCard => ({
  id: card.id,
  version: card.version,
  grade_code: card.grade_code,
  stock_reason: card.stock_reason,
  summary_ar: card.summary_ar,
  summary_en: card.summary_en,
  affects_function: card.affects_function,
  defect_count: card.defect_count,
  inspected_by: card.inspected_by,
  inspected_at: toIso(card.inspected_at),
  published_at: card.published_at === null ? null : toIso(card.published_at),
  items: items.map((i) => ({
    id: i.id,
    defect_type_code: i.defect_type_code,
    label_ar: i.label_ar,
    label_en: i.label_en,
    location_ar: i.location_ar,
    location_en: i.location_en,
    size_mm: i.size_mm,
    severity: i.severity,
    affects_function: i.affects_function,
    photo: mediaRef(env, i.photo_media_id),
    hotspot_x_bp: i.hotspot_x_bp,
    hotspot_y_bp: i.hotspot_y_bp,
    note_ar: i.note_ar,
    note_en: i.note_en,
    position: i.position,
  })),
});

export const storeDetailDto = (marketId: string, s: StoreSellerRow): StoreDetail => ({
  id: s.id,
  slug: s.slug,
  display_name_ar: s.display_name_ar,
  display_name_en: s.display_name_en,
  tagline_ar: s.tagline_ar,
  tagline_en: s.tagline_en,
  kind: s.kind,
  status: s.status === "VACATION" ? "VACATION" : "ACTIVE",
  verified_badge: s.verified_badge,
  price_trust_score: s.price_trust_score,
  followers_count: s.followers_count,
  ships_from_country: s.ships_from_country,
  // Storefront builder is a separate module; defaults until it publishes a version.
  storefront: { template_code: "default", palette: {}, published_version: 0 },
  legal_identity: {
    legal_name_ar: s.legal_name_ar ?? "",
    legal_name_en: s.legal_name_en,
    commercial_register_no: s.commercial_register_no ?? "",
    tax_card_no: s.tax_card_no ?? "",
    governorate_name_ar: s.governorate_name_ar ?? "",
  },
  discount_display_mode: s.discount_display_mode,
  canonical_path: `/${marketId.toLowerCase()}/stores/${s.slug}`,
});
