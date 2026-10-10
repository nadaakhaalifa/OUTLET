import type { ColumnType, Generated } from "kysely";
import type { PlatformTables } from "../../../../platform/db";

/**
 * Hand-written row types for migration 0012 (ADR-0020 option A). `catalog-columns` below is the
 * exhaustive map the drift test compares to information_schema.
 * bigint reads back as string; pass money as `amount.toString()`.
 */
type Ts = ColumnType<Date, Date | string, Date | string>;

export interface BrandsTable {
  id: Generated<string>;
  slug: string;
  name_ar: string;
  name_en: string | null;
  origin: Generated<"local" | "global">;
  authorization_required: Generated<boolean>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CategoriesTable {
  id: Generated<string>;
  parent_id: string | null;
  slug: string;
  name_ar: string;
  name_en: string | null;
  product_type: string;
  tax_category_code: string | null;
  return_class: Generated<"standard" | "hygiene" | "personalized" | "non_returnable">;
  requires_size_chart: Generated<boolean>;
  sort_order: Generated<number>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ProductsTable {
  id: string;
  store_id: string;
  brand_id: string | null;
  category_id: string;
  title_ar: string;
  title_en: string | null;
  description_ar: string | null;
  description_en: string | null;
  condition: "new_with_tags" | "new_without_tags" | "sample" | "minor_defect";
  status: Generated<"draft" | "active" | "paused" | "auto_paused_price_parity" | "delisted">;
  material: string | null;
  size_chart_id: string | null;
  offer_group_id: string | null;
  facets: Generated<unknown>;
  modest: Generated<boolean>;
  version: Generated<number>;
  published_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface SkusTable {
  id: string;
  product_id: string;
  store_id: string;
  seller_sku: string | null;
  gtin: string | null;
  color_code: Generated<string>;
  size_label: string;
  list_price_amount: ColumnType<string, string, string>;
  currency: Generated<string>;
  status: Generated<"active" | "paused" | "sold_out" | "delisted">;
  weight_grams: number | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: Generated<Date>;
}

export interface ProductMediaTable {
  id: Generated<string>;
  product_id: string;
  store_id: string;
  sku_id: string | null;
  media_asset_id: string;
  kind: Generated<"image" | "video">;
  position: number;
  blurhash: string | null;
  image_version: Generated<number>;
  created_at: Generated<Date>;
}

export interface ProductDefectsTable {
  id: Generated<string>;
  product_id: string;
  store_id: string;
  sku_id: string | null;
  description_ar: string | null;
  description_en: string | null;
  media_asset_id: string;
  created_at: Generated<Date>;
}

export interface CatalogImportsTable {
  id: string;
  store_id: string;
  actor_id: string;
  upload_id: string;
  status: "queued" | "validating" | "dry_run_complete" | "applying" | "completed" | "failed";
  dry_run: boolean;
  rows_total: number;
  rows_ok: number;
  rows_failed: number;
  created_at: Ts;
  updated_at: Generated<Date>;
}

export interface CatalogImportErrorsTable {
  id: Generated<string>;
  import_id: string;
  store_id: string;
  row_number: number;
  column_name: string | null;
  code: string;
}

export interface CatalogImportProductsTable {
  import_id: string;
  store_id: string;
  product_ref: string;
  product_id: string | null;
  created_at: Generated<Date>;
}

export interface CatalogTables {
  brands: BrandsTable;
  categories: CategoriesTable;
  products: ProductsTable;
  skus: SkusTable;
  product_media: ProductMediaTable;
  product_defects: ProductDefectsTable;
  catalog_imports: CatalogImportsTable;
  catalog_import_errors: CatalogImportErrorsTable;
  catalog_import_products: CatalogImportProductsTable;
}

export type CatalogDb = PlatformTables & CatalogTables;

const cols = <T>(m: Record<keyof T, true>): readonly string[] => Object.keys(m).sort();

export const CATALOG_COLUMNS: Record<keyof CatalogTables, readonly string[]> = {
  brands: cols<BrandsTable>({ id: true, slug: true, name_ar: true, name_en: true, origin: true, authorization_required: true, active: true, created_at: true, updated_at: true }),
  categories: cols<CategoriesTable>({ id: true, parent_id: true, slug: true, name_ar: true, name_en: true, product_type: true, tax_category_code: true, return_class: true, requires_size_chart: true, sort_order: true, active: true, created_at: true, updated_at: true }),
  products: cols<ProductsTable>({ id: true, store_id: true, brand_id: true, category_id: true, title_ar: true, title_en: true, description_ar: true, description_en: true, condition: true, status: true, material: true, size_chart_id: true, offer_group_id: true, facets: true, modest: true, version: true, published_at: true, created_at: true, updated_at: true }),
  skus: cols<SkusTable>({ id: true, product_id: true, store_id: true, seller_sku: true, gtin: true, color_code: true, size_label: true, list_price_amount: true, currency: true, status: true, weight_grams: true, created_at: true, updated_at: true }),
  product_media: cols<ProductMediaTable>({ id: true, product_id: true, store_id: true, sku_id: true, media_asset_id: true, kind: true, position: true, blurhash: true, image_version: true, created_at: true }),
  product_defects: cols<ProductDefectsTable>({ id: true, product_id: true, store_id: true, sku_id: true, description_ar: true, description_en: true, media_asset_id: true, created_at: true }),
  catalog_imports: cols<CatalogImportsTable>({ id: true, store_id: true, actor_id: true, upload_id: true, status: true, dry_run: true, rows_total: true, rows_ok: true, rows_failed: true, created_at: true, updated_at: true }),
  catalog_import_errors: cols<CatalogImportErrorsTable>({ id: true, import_id: true, store_id: true, row_number: true, column_name: true, code: true }),
  catalog_import_products: cols<CatalogImportProductsTable>({ import_id: true, store_id: true, product_ref: true, product_id: true, created_at: true }),
};
