import type { Queryable } from "@outlet/db";
import { PUBLIC_STATUSES } from "../domain/listing-state.js";
import { PRODUCT_COLS, defectCardDto, loadCard, loadGrade, loadMedia, loadSkus, loadStoreWithSeller, storeDetailDto } from "./data.js";
import type { ProductRow } from "./data.js";
import type { Env } from "./env.js";

/**
 * Published read model writers. Called inside the same transaction as the source change, with the store context bound,
 * so the public tables can never drift from the tenant tables (RLS audit rationale: see migration 0010 header).
 */
export const projectStore = async (env: Env, tx: Queryable, storeId: string): Promise<void> => {
  const s = await loadStoreWithSeller(tx, storeId);
  if (s === undefined || (s.status !== "ACTIVE" && s.status !== "VACATION")) {
    await tx.query("DELETE FROM catalog_public_stores WHERE id = $1", [storeId]);
    await tx.query("DELETE FROM catalog_public_listings WHERE store_ref = $1", [storeId]);
    return;
  }
  const detail = storeDetailDto(env.marketId, s);
  await tx.query(
    `INSERT INTO catalog_public_stores (id, market_id, slug, display_name_ar, display_name_en, tagline_ar, tagline_en, kind, status, verified_badge,
                                       ships_from_country, followers_count, discount_display_mode, price_trust_score, legal_identity, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)
     ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, display_name_ar = EXCLUDED.display_name_ar, display_name_en = EXCLUDED.display_name_en,
       tagline_ar = EXCLUDED.tagline_ar, tagline_en = EXCLUDED.tagline_en, status = EXCLUDED.status, verified_badge = EXCLUDED.verified_badge,
       followers_count = EXCLUDED.followers_count, discount_display_mode = EXCLUDED.discount_display_mode, price_trust_score = EXCLUDED.price_trust_score,
       legal_identity = EXCLUDED.legal_identity, updated_at = EXCLUDED.updated_at`,
    [s.id, env.marketId, s.slug, s.display_name_ar, s.display_name_en, s.tagline_ar, s.tagline_en, s.kind, detail.status, s.verified_badge,
     s.ships_from_country, s.followers_count, s.discount_display_mode, s.price_trust_score, JSON.stringify(detail.legal_identity), env.now()],
  );
  await tx.query("UPDATE catalog_public_listings SET store = $2::jsonb WHERE store_ref = $1", [storeId, JSON.stringify(detail)]);
};

/** Upserts the public row of a product when it is shopper-visible, otherwise removes it. */
export const projectListing = async (env: Env, tx: Queryable, productId: string): Promise<void> => {
  const p = (await tx.query<ProductRow>(`SELECT ${PRODUCT_COLS} FROM products WHERE id = $1`, [productId])).rows[0];
  const remove = async (): Promise<void> => {
    await tx.query("DELETE FROM catalog_public_listings WHERE id = $1", [productId]);
  };
  if (p === undefined || !PUBLIC_STATUSES.includes(p.status) || p.published_at === null) return remove();
  const store = await loadStoreWithSeller(tx, p.store_id);
  if (store === undefined || (store.status !== "ACTIVE" && store.status !== "VACATION")) return remove();
  const skus = (await loadSkus(tx, productId)).filter((s) => s.status === "active").sort((a, b) => (BigInt(a.price_minor) < BigInt(b.price_minor) ? -1 : BigInt(a.price_minor) > BigInt(b.price_minor) ? 1 : a.id.localeCompare(b.id)));
  const first = skus[0];
  if (first === undefined) return remove();
  const grade = await loadGrade(tx, p.condition_grade_code);
  if (grade === undefined) return remove();
  const cardRows = p.defect_card_id === null ? undefined : await loadCard(tx, p.defect_card_id);
  const media = (await loadMedia(tx, productId)).find((m) => m.role === "main");
  const brand = p.brand_id === null ? undefined : (await tx.query<{ name: string }>("SELECT name FROM brands WHERE id = $1", [p.brand_id])).rows[0];
  const minPrice = skus.reduce((m, s) => (BigInt(s.price_minor) < m ? BigInt(s.price_minor) : m), BigInt(first.price_minor));
  const variants = skus.map((s) => ({ sku_id: s.id, option_values: s.option_values, size_label: s.size_label, price_minor: s.price_minor, currency: s.currency }));
  const card = cardRows === undefined ? null : defectCardDto(env, cardRows.card, cardRows.items);
  await tx.query(
    `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, title_en, description_ar, description_en, brand_id, brand_name,
        primary_category_id, condition_grade_code, condition_grade, stock_reason, colour_code, main_media_id, main_media_alt_ar, defect_count,
        min_price_minor, currency, attributes, variants, defect_card, version, published_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,$25,$26,$27)
     ON CONFLICT (id) DO UPDATE SET store = EXCLUDED.store, status = EXCLUDED.status, title_ar = EXCLUDED.title_ar, title_en = EXCLUDED.title_en,
        description_ar = EXCLUDED.description_ar, description_en = EXCLUDED.description_en, brand_id = EXCLUDED.brand_id, brand_name = EXCLUDED.brand_name,
        primary_category_id = EXCLUDED.primary_category_id, condition_grade_code = EXCLUDED.condition_grade_code, condition_grade = EXCLUDED.condition_grade,
        stock_reason = EXCLUDED.stock_reason, colour_code = EXCLUDED.colour_code, main_media_id = EXCLUDED.main_media_id, main_media_alt_ar = EXCLUDED.main_media_alt_ar,
        defect_count = EXCLUDED.defect_count, min_price_minor = EXCLUDED.min_price_minor, currency = EXCLUDED.currency, attributes = EXCLUDED.attributes,
        variants = EXCLUDED.variants, defect_card = EXCLUDED.defect_card, version = EXCLUDED.version, published_at = EXCLUDED.published_at, updated_at = EXCLUDED.updated_at`,
    [p.id, p.store_id, env.marketId, JSON.stringify(storeDetailDto(env.marketId, store)), p.status, p.title_ar, p.title_en, p.description_ar, p.description_en,
     p.brand_id, brand?.name ?? null, p.primary_category_id, p.condition_grade_code,
     JSON.stringify({ code: grade.code, label_ar: grade.label_ar, label_en: grade.label_en, schema_org_condition: grade.schema_org_condition }),
     p.stock_reason, p.colour_code, media?.media_id ?? null, media?.alt_ar ?? null, card?.defect_count ?? 0, minPrice.toString(), first.currency,
     JSON.stringify(p.attributes), JSON.stringify(variants), card === null ? null : JSON.stringify(card), p.version, p.published_at, p.updated_at],
  );
};
