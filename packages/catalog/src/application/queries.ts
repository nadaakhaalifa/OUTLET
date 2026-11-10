import { tsText } from "./cursor.js";

/**
 * SQL for the hot listing queries. Exported so the EXPLAIN tests run the exact statements the services run.
 * Parameters are positional: see each builder. Every statement orders by a keyset (timestamp, id) backed by an index.
 */

/** $1 store, [$2 status], [$cursorT, $cursorId], last = limit. */
export const sellerListSql = (o: { status: boolean; cursor: boolean }): string => {
  let n = 1;
  const where = ["p.store_id = $1"];
  if (o.status) where.push(`p.status = $${String(++n)}`);
  if (o.cursor) {
    where.push(`(p.updated_at, p.id) < ($${String(n + 1)}::timestamptz, $${String(n + 2)}::uuid)`);
    n += 2;
  }
  return `SELECT p.id, p.status, p.title_ar, p.condition_grade_code, p.updated_at, ${tsText("p.updated_at")} AS cur_t,
       (SELECT count(*) FROM skus s WHERE s.product_id = p.id)::int AS sku_count
  FROM products p WHERE ${where.join(" AND ")} ORDER BY p.updated_at DESC, p.id DESC LIMIT $${String(n + 1)}`;
};

const CARD_COLS = `l.id, l.store_ref, l.store ->> 'slug' AS store_slug, l.title_ar, l.title_en, l.main_media_id, l.main_media_alt_ar, l.condition_grade_code,
       l.defect_count, l.min_price_minor::text AS min_price_minor, l.currency, l.variants -> 0 ->> 'sku_id' AS sku_id, ${tsText("l.published_at")} AS cur_t`;

/** $1 store id, [$2 cursorT, $3 cursorId], last = limit. Index catalog_public_listings_store_idx. */
export const storeListingsSql = (o: { cursor: boolean }): string =>
  `SELECT ${CARD_COLS} FROM catalog_public_listings l WHERE l.store_ref = $1 AND l.status = 'PUBLISHED'${
    o.cursor ? " AND (l.published_at, l.id) < ($2::timestamptz, $3::uuid)" : ""
  } ORDER BY l.published_at DESC, l.id DESC LIMIT $${o.cursor ? "4" : "2"}`;

/** $1 market, $2 category id, [$3 cursorT, $4 cursorId], last = limit. Index catalog_public_listings_category_idx. */
export const categoryListingsSql = (o: { cursor: boolean }): string =>
  `SELECT ${CARD_COLS} FROM catalog_public_listings l WHERE l.market_id = $1 AND l.primary_category_id = $2 AND l.status = 'PUBLISHED'${
    o.cursor ? " AND (l.published_at, l.id) < ($3::timestamptz, $4::uuid)" : ""
  } ORDER BY l.published_at DESC, l.id DESC LIMIT $${o.cursor ? "5" : "3"}`;

export const LISTING_DETAIL_SQL = `SELECT id, store, status, title_ar, title_en, description_ar, description_en, brand_id, brand_name, primary_category_id,
       condition_grade, stock_reason, colour_code, defect_card, attributes, variants, published_at
  FROM catalog_public_listings WHERE id = $1 AND market_id = $2`;

export const PASSPORT_SQL = `SELECT product_id, title_ar, title_en, store_slug, store_name_ar, unit_status, condition_grade, defect_card, content_hash, inspections
  FROM catalog_public_passports WHERE token_hash = $1 AND market_id = $2`;
