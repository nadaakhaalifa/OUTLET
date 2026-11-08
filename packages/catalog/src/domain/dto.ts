/** Zod schemas for the catalog DTOs in docs/api/openapi.yaml (wire shape, snake_case). */
import { z } from "zod";
import { LISTING_STATUSES } from "./listing-state.js";

const uuid = z.uuid();
const text = (max = 500) => z.string().max(max);
const nonEmpty = (max = 500) => z.string().trim().min(1).max(max);
const iso = z.iso.datetime({ offset: true });

export const MoneyDto = z.strictObject({ amount_minor: z.string().regex(/^-?[0-9]{1,19}$/), currency: z.string().regex(/^[A-Z]{3}$/) });
export type MoneyDto = z.infer<typeof MoneyDto>;

export const MediaRef = z.strictObject({
  media_id: z.string(),
  url: z.string(),
  width: z.number().int().nullable().optional(),
  height: z.number().int().nullable().optional(),
  blurhash: z.string().nullable().optional(),
  alt_ar: z.string().nullable().optional(),
  alt_en: z.string().nullable().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const Pagination = {
  limit: z.number().int().min(1).max(50),
};

// ------------------------------------------------------------------ categories, grades
export const Category = z.strictObject({
  id: uuid,
  parent_id: uuid.nullable().optional(),
  code: text(),
  path: text(),
  depth: z.number().int().min(0),
  vertical: text(),
  name: text(),
  slug: text(),
});
export type Category = z.infer<typeof Category>;
export const CategoryPage = z.strictObject({ items: z.array(Category).max(50), next_cursor: text(512).nullable() });

export const ConditionGrade = z.strictObject({
  code: text(),
  label_ar: nonEmpty(),
  label_en: text().nullable().optional(),
  schema_org_condition: text(),
});
export type ConditionGrade = z.infer<typeof ConditionGrade>;

// ------------------------------------------------------------------ defects
const severity = z.enum(["minor", "major"]);
const bp = z.number().int().min(0).max(10000);

export const DefectItemInput = z
  .strictObject({
    defect_type_code: text(),
    location_ar: nonEmpty(),
    location_en: text().optional(),
    size_mm: z.number().int().min(0).optional(),
    severity,
    affects_function: z.boolean(),
    photo_media_id: uuid,
    hotspot_media_id: uuid.optional(),
    hotspot_x_bp: bp.optional(),
    hotspot_y_bp: bp.optional(),
    note_ar: text().optional(),
    note_en: text().optional(),
  })
  .refine((i) => (i.hotspot_x_bp === undefined) === (i.hotspot_y_bp === undefined), { message: "hotspot needs both x and y" });
export type DefectItemInput = z.infer<typeof DefectItemInput>;

export const DefectCardInput = z.strictObject({
  summary_ar: text().optional(),
  summary_en: text().optional(),
  affects_function: z.boolean(),
  items: z.array(DefectItemInput).max(30),
});
export type DefectCardInput = z.infer<typeof DefectCardInput>;

export const DefectItem = z.strictObject({
  id: uuid,
  defect_type_code: text(),
  label_ar: nonEmpty(),
  label_en: text().nullable().optional(),
  location_ar: nonEmpty(),
  location_en: text().nullable().optional(),
  size_mm: z.number().int().min(0).nullable().optional(),
  severity,
  affects_function: z.boolean(),
  photo: MediaRef,
  hotspot_x_bp: bp.nullable().optional(),
  hotspot_y_bp: bp.nullable().optional(),
  note_ar: text().nullable().optional(),
  note_en: text().nullable().optional(),
  position: z.number().int(),
});
export type DefectItem = z.infer<typeof DefectItem>;

export const DefectCard = z.strictObject({
  id: uuid,
  version: z.number().int(),
  grade_code: text(),
  stock_reason: text().nullable().optional(),
  summary_ar: text().nullable().optional(),
  summary_en: text().nullable().optional(),
  affects_function: z.boolean(),
  defect_count: z.number().int(),
  inspected_by: z.enum(["seller", "hub"]),
  inspected_at: iso.nullable().optional(),
  published_at: iso.nullable().optional(),
  items: z.array(DefectItem).max(50),
});
export type DefectCard = z.infer<typeof DefectCard>;

export const PassportInspection = z.strictObject({ version: z.number().int(), inspected_by: z.enum(["seller", "hub"]), inspected_at: iso });
export const UNIT_STATUSES = ["IN_STOCK", "RESERVED", "SOLD", "RETURNED", "RELISTED", "WRITTEN_OFF", "DONATED"] as const;
export const DefectPassport = z.strictObject({
  passport_code: text(),
  unit_status: z.enum(UNIT_STATUSES),
  product_id: uuid,
  title_ar: nonEmpty(),
  title_en: text().nullable().optional(),
  store_slug: text(),
  store_display_name_ar: nonEmpty(),
  condition_grade: ConditionGrade,
  defect_card: DefectCard,
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  inspection_history: z.array(PassportInspection).max(50),
  product_path: text().nullable().optional(),
});
export type DefectPassport = z.infer<typeof DefectPassport>;

// ------------------------------------------------------------------ stores
export const SellerLegalIdentity = z.strictObject({
  legal_name_ar: nonEmpty(),
  legal_name_en: z.string().nullable().optional(),
  commercial_register_no: z.string().min(1),
  tax_card_no: z.string().min(1),
  governorate_name_ar: nonEmpty(),
});
export type SellerLegalIdentity = z.infer<typeof SellerLegalIdentity>;

export const DISCOUNT_MODES = ["public", "member_only", "hidden"] as const;
export const StorefrontPublic = z.strictObject({
  template_code: z.string(),
  palette: z.record(z.string(), z.unknown()),
  published_version: z.number().int(),
});

export const StoreDetail = z.strictObject({
  id: uuid,
  slug: text(),
  display_name_ar: nonEmpty(),
  display_name_en: text().nullable().optional(),
  tagline_ar: text().nullable().optional(),
  tagline_en: text().nullable().optional(),
  kind: z.enum(["local", "global"]),
  status: z.enum(["ACTIVE", "VACATION"]),
  verified_badge: z.boolean(),
  price_trust_score: z.number().int().nullable().optional(),
  followers_count: z.number().int(),
  ships_from_country: z.string().regex(/^[A-Z]{2}$/),
  storefront: StorefrontPublic,
  legal_identity: SellerLegalIdentity,
  discount_display_mode: z.enum(DISCOUNT_MODES),
  canonical_path: text(),
});
export type StoreDetail = z.infer<typeof StoreDetail>;

export const STORE_STATUSES = ["DRAFT", "PENDING_REVIEW", "ACTIVE", "VACATION", "SUSPENDED", "CLOSED"] as const;
export const SellerStore = z.strictObject({
  id: uuid,
  seller_id: uuid,
  slug: text(),
  display_name_ar: nonEmpty(),
  display_name_en: text().nullable().optional(),
  tagline_ar: text().nullable().optional(),
  tagline_en: text().nullable().optional(),
  kind: z.enum(["local", "global"]),
  ships_from_country: z.string().regex(/^[A-Z]{2}$/),
  primary_category_id: uuid.nullable().optional(),
  status: z.enum(STORE_STATUSES),
  verified_badge: z.boolean(),
  health_score: z.number().int().nullable().optional(),
  price_trust_score: z.number().int().nullable().optional(),
  discount_display_mode: z.enum(DISCOUNT_MODES),
  followers_count: z.number().int(),
  launched_at: iso.nullable().optional(),
  /** Optimistic-lock version (ETag / If-Match). Not in the OpenAPI body; carried as the ETag. */
  version: z.number().int(),
});
export type SellerStore = z.infer<typeof SellerStore>;

export const StorePatch = z.strictObject({
  display_name_ar: nonEmpty().optional(),
  display_name_en: text().optional(),
  tagline_ar: text().optional(),
  tagline_en: text().optional(),
  primary_category_id: uuid.optional(),
  discount_display_mode: z.enum(DISCOUNT_MODES).optional(),
});
export type StorePatch = z.infer<typeof StorePatch>;

/** Store creation by seller staff (not an OpenAPI body today; mirrors SellerStore). */
export const StoreCreateInput = z.strictObject({
  seller_id: uuid,
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60),
  display_name_ar: nonEmpty(),
  display_name_en: text().optional(),
  tagline_ar: text().optional(),
  tagline_en: text().optional(),
  kind: z.enum(["local", "global"]),
  ships_from_country: z.string().regex(/^[A-Z]{2}$/),
  primary_category_id: uuid.optional(),
});
export type StoreCreateInput = z.infer<typeof StoreCreateInput>;

// ------------------------------------------------------------------ products
export const ProductDraftInput = z.strictObject({ condition_grade_code: text(), primary_category_id: uuid });
export type ProductDraftInput = z.infer<typeof ProductDraftInput>;

export const PhotosConditionInput = z.strictObject({
  media: z
    .array(
      z.strictObject({
        media_id: uuid,
        role: z.enum(["main", "gallery", "condition", "packaging", "video"]),
        position: z.number().int().min(0),
        alt_ar: z.string().optional(),
        alt_en: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
  condition_grade_code: text(),
  stock_reason: text().optional(),
});
export type PhotosConditionInput = z.infer<typeof PhotosConditionInput>;

export const DetailsInput = z.strictObject({
  title_ar: nonEmpty(),
  title_en: text().optional(),
  description_ar: nonEmpty(5000),
  description_en: text(5000).optional(),
  brand_id: uuid.optional(),
  primary_category_id: uuid,
  category_ids: z.array(uuid).max(50).optional(),
  attributes: z.record(z.string(), z.unknown()),
  size_chart_id: uuid.optional(),
  warranty_months: z.number().int().min(0).optional(),
  warranty_kind: z.enum(["seller", "brand", "none"]).optional(),
  included_accessories_ar: text().optional(),
  origin_country: z.string().regex(/^[A-Z]{2}$/).optional(),
});
export type DetailsInput = z.infer<typeof DetailsInput>;

export const SkuInput = z.strictObject({
  seller_sku: nonEmpty(),
  gtin: text().optional(),
  option_values: z.record(z.string(), z.unknown()),
  price: MoneyDto,
});
export type SkuInput = z.infer<typeof SkuInput>;

export const SkuPatch = z.strictObject({
  gtin: text().optional(),
  option_values: z.record(z.string(), z.unknown()).optional(),
  price: MoneyDto.optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
});
export type SkuPatch = z.infer<typeof SkuPatch>;

export const ProductMedia = z.strictObject({
  id: z.string(),
  role: z.enum(["main", "gallery", "condition", "defect", "packaging", "video"]),
  position: z.number().int(),
  media: MediaRef,
  defect_item_id: z.string().nullable().optional(),
});

/** Catalog never shows a "was" price: reference fields are absent unless Price Watch verified (claim_type verified_discount). */
export const PriceDisplay = z.strictObject({
  current_price: MoneyDto,
  claim_type: z.enum(["verified_discount", "lowest_30d", "launch_price", "plain"]),
  reference_price: MoneyDto.optional(),
  display_discount_bp: bp.optional(),
  member_discount_bp: bp.optional(),
  evidence_checked_at: z.string().optional(),
  price_proof_path: z.string(),
});

/** availability is owned by inventory and overlaid by the BFF; catalog never invents stock, so it is optional here. */
export const SkuOffer = z.strictObject({
  sku_id: z.string(),
  option_values: z.record(z.string(), z.unknown()),
  size_label: z.string().nullable().optional(),
  price: PriceDisplay,
  availability: z.enum(["in_stock", "low_stock", "out_of_stock"]).optional(),
  low_stock_qty: z.number().int().optional(),
});
export type SkuOffer = z.infer<typeof SkuOffer>;

export const SellerSku = z.strictObject({
  id: z.string(),
  seller_sku: z.string().nullable().optional(),
  gtin: z.string().nullable().optional(),
  option_values: z.record(z.string(), z.unknown()),
  size_label: z.string().nullable().optional(),
  price: MoneyDto,
  status: z.string(),
  version: z.number().int(),
});
export type SellerSku = z.infer<typeof SellerSku>;

export const SELLER_STATUSES = LISTING_STATUSES;
export const SellerProduct = z.strictObject({
  id: uuid,
  status: z.enum(SELLER_STATUSES),
  title_ar: z.string().nullable().optional(),
  title_en: z.string().nullable().optional(),
  description_ar: z.string().nullable().optional(),
  description_en: z.string().nullable().optional(),
  brand_id: uuid.nullable().optional(),
  primary_category_id: uuid.nullable().optional(),
  category_ids: z.array(uuid).max(50),
  condition_grade_code: z.string().nullable().optional(),
  stock_reason: z.string().nullable().optional(),
  defect_card: DefectCard.nullable().optional(),
  attributes: z.record(z.string(), z.unknown()),
  colour_code: z.string().nullable().optional(),
  size_chart_id: uuid.nullable().optional(),
  warranty_months: z.number().int().nullable().optional(),
  warranty_kind: z.string().nullable().optional(),
  included_accessories_ar: z.string().nullable().optional(),
  origin_country: z.string().nullable().optional(),
  media: z.array(ProductMedia).max(50),
  skus: z.array(SellerSku).max(50),
  published_at: iso.nullable().optional(),
  updated_at: iso,
  /** Optimistic-lock version (ETag / If-Match). */
  version: z.number().int(),
});
export type SellerProduct = z.infer<typeof SellerProduct>;

export const SellerProductSummary = z.strictObject({
  id: uuid,
  status: z.string(),
  title_ar: z.string().nullable().optional(),
  condition_grade_code: z.string().nullable().optional(),
  sku_count: z.number().int(),
  updated_at: iso,
});
export const SellerProductSummaryPage = z.strictObject({ items: z.array(SellerProductSummary).max(50), next_cursor: text(512).nullable() });

export const PublishResult = z.strictObject({
  product_id: uuid,
  status: z.enum(["PUBLISHED", "IN_REVIEW", "DRAFT"]),
  blocked_reasons: z.array(text()).max(50),
});
export type PublishResult = z.infer<typeof PublishResult>;

export const ProductCard = z.strictObject({
  product_id: uuid,
  sku_id: uuid,
  store_id: uuid,
  store_slug: text(),
  title_ar: nonEmpty(),
  title_en: text().nullable().optional(),
  image: MediaRef.nullable(),
  condition_grade_code: text(),
  defect_count: z.number().int(),
  price: PriceDisplay,
  availability: z.enum(["in_stock", "low_stock", "out_of_stock"]).optional(),
  canonical_path: text(),
});
export type ProductCard = z.infer<typeof ProductCard>;
export const ProductCardPage = z.strictObject({ items: z.array(ProductCard).max(50), next_cursor: text(512).nullable() });
export type ProductCardPage = z.infer<typeof ProductCardPage>;

export const ProductDetail = z.strictObject({
  id: uuid,
  store: StoreDetail,
  brand_id: uuid.nullable().optional(),
  brand_name: z.string().nullable().optional(),
  primary_category_id: uuid,
  status: z.enum(["PUBLISHED", "SOLD_OUT", "PAUSED"]),
  title_ar: nonEmpty(),
  title_en: z.string().nullable().optional(),
  description_ar: nonEmpty(5000),
  description_en: z.string().nullable().optional(),
  condition_grade: ConditionGrade,
  stock_reason: z.string().nullable().optional(),
  defect_card: DefectCard.nullable().optional(),
  attributes: z.record(z.string(), z.unknown()),
  colour_code: z.string().nullable().optional(),
  skus: z.array(SkuOffer).max(50),
  canonical_path: text(),
  published_at: iso,
});
export type ProductDetail = z.infer<typeof ProductDetail>;
