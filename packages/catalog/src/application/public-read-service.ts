import type { Queryable } from "@outlet/db";
import { ProductCardPage, ProductDetail } from "../domain/dto.js";
import type { StoreDetail } from "../domain/dto.js";
import { notFound } from "../domain/errors.js";
import { decodeCursor, encodeCursor, pageLimit } from "./cursor.js";
import { asPublic, makeEnv, toIso } from "./env.js";
import type { CatalogDeps, Env } from "./env.js";
import { LISTING_DETAIL_SQL, categoryListingsSql, storeListingsSql } from "./queries.js";
import { StoreService } from "./store-service.js";

interface CardRow {
  id: string;
  store_ref: string;
  store_slug: string;
  title_ar: string;
  title_en: string | null;
  main_media_id: string | null;
  main_media_alt_ar: string | null;
  condition_grade_code: string;
  defect_count: number;
  min_price_minor: string;
  currency: string;
  sku_id: string | null;
  cur_t: string;
}

interface DetailRow {
  id: string;
  store: StoreDetail;
  status: "PUBLISHED" | "SOLD_OUT" | "PAUSED";
  title_ar: string;
  title_en: string | null;
  description_ar: string;
  description_en: string | null;
  brand_id: string | null;
  brand_name: string | null;
  primary_category_id: string;
  condition_grade: { code: string; label_ar: string; label_en: string; schema_org_condition: string };
  stock_reason: string | null;
  colour_code: string | null;
  defect_card: unknown;
  attributes: Record<string, unknown>;
  variants: { sku_id: string; option_values: Record<string, unknown>; size_label: string | null; price_minor: string; currency: string }[];
  published_at: Date;
}

export interface PageOpts {
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * Shopper-facing reads. They touch only the published read model (no tenant context, no joins into tenant tables),
 * select only the columns the DTO needs, and never run a query per row: a page is exactly one statement.
 */
export class PublicCatalogService {
  private readonly env: Env;
  private readonly stores: StoreService;
  constructor(deps: CatalogDeps) {
    this.env = makeEnv(deps);
    this.stores = new StoreService(deps);
  }

  getStoreBySlug(slug: string): Promise<StoreDetail> {
    return this.stores.getStoreBySlug(slug);
  }

  /** One page of shelf cards for a store, newest first (published_at desc, id desc), max 50. */
  async listStoreListings(storeId: string, opts: PageOpts = {}): Promise<ReturnType<typeof ProductCardPage.parse>> {
    return await asPublic(this.env, (tx) => this.storeCards(tx, storeId, opts));
  }

  async listCategoryListings(categoryId: string, opts: PageOpts = {}): Promise<ReturnType<typeof ProductCardPage.parse>> {
    const limit = pageLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    return await asPublic(this.env, async (tx) => {
      const params: unknown[] = [this.env.marketId, categoryId];
      if (cur !== undefined) params.push(cur.t, cur.id);
      params.push(limit + 1);
      return this.page(await tx.query<CardRow>(categoryListingsSql({ cursor: cur !== undefined }), params), limit);
    });
  }

  /** Store page = exactly two statements (store by slug, first listings page) in one transaction. */
  async getStorePage(slug: string, opts: PageOpts = {}): Promise<{ store: StoreDetail; listings: ReturnType<typeof ProductCardPage.parse> }> {
    return await asPublic(this.env, async (tx) => {
      const store = await this.stores.storeBySlug(tx, slug);
      return { store, listings: await this.storeCards(tx, store.id, opts) };
    });
  }

  /** Product detail from the read model: one statement. Missing, unpublished or other-market ids are not_found. */
  async getListing(id: string): Promise<ReturnType<typeof ProductDetail.parse>> {
    return await asPublic(this.env, async (tx) => {
      const r = (await tx.query<DetailRow>(LISTING_DETAIL_SQL, [id, this.env.marketId])).rows[0];
      if (r === undefined) throw notFound("listing");
      const market = this.env.marketId.toLowerCase();
      return ProductDetail.parse({
        id: r.id,
        store: r.store,
        brand_id: r.brand_id,
        brand_name: r.brand_name,
        primary_category_id: r.primary_category_id,
        status: r.status,
        title_ar: r.title_ar,
        title_en: r.title_en,
        description_ar: r.description_ar,
        description_en: r.description_en,
        condition_grade: r.condition_grade,
        stock_reason: r.stock_reason,
        defect_card: r.defect_card,
        attributes: r.attributes,
        colour_code: r.colour_code,
        skus: r.variants.map((v) => ({
          sku_id: v.sku_id,
          option_values: v.option_values,
          size_label: v.size_label,
          // The catalog never invents a reference price: plain price only; Price Watch overlays verified claims.
          price: { current_price: { amount_minor: v.price_minor, currency: v.currency }, claim_type: "plain", price_proof_path: `/${market}/products/${r.id}/price-evidence` },
        })),
        canonical_path: `/${market}/products/${r.id}`,
        published_at: toIso(r.published_at),
      });
    });
  }

  private async storeCards(tx: Queryable, storeId: string, opts: PageOpts): Promise<ReturnType<typeof ProductCardPage.parse>> {
    const limit = pageLimit(opts.limit);
    const cur = decodeCursor(opts.cursor);
    const params: unknown[] = [storeId];
    if (cur !== undefined) params.push(cur.t, cur.id);
    params.push(limit + 1);
    return this.page(await tx.query<CardRow>(storeListingsSql({ cursor: cur !== undefined }), params), limit);
  }

  private page(r: { rows: CardRow[] }, limit: number): ReturnType<typeof ProductCardPage.parse> {
    const market = this.env.marketId.toLowerCase();
    const rows = r.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return ProductCardPage.parse({
      items: rows.map((x) => ({
        product_id: x.id,
        sku_id: x.sku_id,
        store_id: x.store_ref,
        store_slug: x.store_slug,
        title_ar: x.title_ar,
        title_en: x.title_en,
        image: x.main_media_id === null ? null : { media_id: x.main_media_id, url: this.env.mediaUrl(x.main_media_id), alt_ar: x.main_media_alt_ar },
        condition_grade_code: x.condition_grade_code,
        defect_count: x.defect_count,
        price: { current_price: { amount_minor: x.min_price_minor, currency: x.currency }, claim_type: "plain", price_proof_path: `/${market}/products/${x.id}/price-evidence` },
        canonical_path: `/${market}/products/${x.id}`,
      })),
      next_cursor: r.rows.length > limit && last !== undefined ? encodeCursor({ t: last.cur_t, id: last.id }) : null,
    });
  }
}
