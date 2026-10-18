import type { Money } from "../money";

/** Wire form is the persisted form (ADR-0018). */
export const CONDITIONS = ["new_with_tags", "new_without_tags", "sample", "minor_defect"] as const;
export type Condition = (typeof CONDITIONS)[number];

/**
 * Shopper department (Home boxes: Women / Men / Kids). Accessories is deliberately a category, not
 * a department. `unisex` is the default for products that have no explicit department.
 */
export const DEPARTMENTS = ["women", "men", "kids", "unisex"] as const;
export type Department = (typeof DEPARTMENTS)[number];
export const DEFAULT_DEPARTMENT: Department = "unisex";

export const LISTING_STATUSES = ["draft", "active", "paused", "auto_paused_price_parity", "delisted"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const RETURN_CLASSES = ["standard", "hygiene", "personalized", "non_returnable"] as const;
export type ReturnClass = (typeof RETURN_CLASSES)[number];

/**
 * Arabic is always present; `en` is optional on the type only because legacy rows predate the bilingual rule.
 * Publishing / activating requires both (see names.ts).
 */
export interface LocalizedText {
  readonly ar: string;
  readonly en?: string;
}

export interface Issue {
  /** JSON pointer style path into the draft, for example `/skus/0/price`. */
  readonly pointer: string;
  readonly code: IssueCode;
}

export const ISSUE_CODES = [
  "arabic_text_required",
  "text_too_long",
  "text_invalid_characters",
  "condition_invalid",
  "defect_photo_required",
  "sku_required",
  "too_many_skus",
  "size_label_invalid",
  "duplicate_variant",
  "price_out_of_range",
  "gtin_invalid",
  "seller_sku_invalid",
  "stock_out_of_range",
  "image_limit_exceeded",
  "category_not_found",
  "category_inactive",
  "brand_not_found",
  "upload_not_found",
  "unknown_column",
  "missing_column",
  "invalid_value",
  "product_ref_invalid",
  "product_columns_mismatch",
  "product_group_invalid",
  "csv_malformed",
  "csv_too_large",
  "too_many_rows",
  "too_many_columns",
  "cell_too_long",
  "no_rows",
  "not_publishable",
  "title_en_missing",
  "title_ar_missing",
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface SkuDraft {
  readonly sellerSku?: string;
  readonly gtin?: string;
  readonly sizeLabel: string;
  readonly color?: string;
  readonly price: Money;
  readonly initialStock?: number;
}

export interface ProductDraft {
  readonly title: LocalizedText;
  readonly description?: LocalizedText;
  readonly categoryId: string;
  readonly brandId?: string;
  readonly condition: Condition;
  readonly department?: Department;
  readonly material?: string;
  readonly imageUploadIds: readonly string[];
  readonly defectPhotoUploadIds: readonly string[];
  readonly sizeChartId?: string;
  readonly skus: readonly SkuDraft[];
}

export const LIMITS = {
  titleMax: 200,
  descriptionMax: 2000,
  materialMax: 120,
  sizeLabelMax: 20,
  colorMax: 40,
  sellerSkuMax: 64,
  skusMax: 100,
  imagesMax: 12,
  defectPhotosMax: 12,
  stockMax: 100_000,
  /** EGP 9,999,999.99 in piastres. */
  priceMaxPiastres: 999_999_999n,
} as const;
