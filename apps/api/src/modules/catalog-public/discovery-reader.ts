import { decodeCursor, encodeCursor, notFound, validation } from "@outlet/catalog";
import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { CategoriesQuery, CategoryEntryPage, QuickProductCardPage, StoreCardPage, StoresQuery } from "./dto.js";
import { CategoryEntryPage as CategoryEntryPageSchema, QuickProductCardPage as QuickPageSchema, StoreCardPage as StorePageSchema } from "./dto.js";

export interface ReaderDeps {
  readonly client: RoleSqlClient<"outlet_app">;
  /** markets.id upper-cased (the value of market_id columns). */
  readonly marketId: string;
  readonly mediaUrl?: (mediaId: string) => string;
}

export interface DiscoveryPort {
  listStores(q: Pick<StoresQuery, "world" | "category_id" | "q" | "cursor" | "limit">): Promise<StoreCardPage>;
  listCategories(q: Pick<CategoriesQuery, "parent_id" | "cursor" | "limit">, locale: "ar" | "en"): Promise<CategoryEntryPage>;
  listStoreProducts(slug: string, q: { cursor?: string; limit: number }): Promise<QuickProductCardPage>;
}

interface StoreRow {
  id: string;
  slug: string;
  display_name_ar: string;
  display_name_en: string | null;
  tagline_ar: string | null;
  tagline_en: string | null;
  kind: "local" | "global";
  verified_badge: boolean;
  followers_count: number;
  discount_display_mode: "public" | "member_only" | "hidden";
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  code: string;
  path: string;
  depth: number;
  vertical: string;
  name_ar: string;
  name_en: string | null;
  slug_ar: string;
  slug_en: string | null;
}

interface CardRow {
  id: string;
  store_ref: string;
  store_slug: string;
  title_ar: string;
  title_en: string | null;
  main_media_id: string | null;
  main_media_alt_ar: string | null;
  condition_grade_code: string;
  condition_label_ar: string | null;
  condition_label_en: string | null;
  colour_code: string | null;
  defect_count: number;
  min_price_minor: string;
  currency: string;
  sku_id: string | null;
  cur_t: string;
}

const SLUG_CURSOR = /^[a-z0-9-]{3,60}$/;
const PATH_CURSOR = /^[a-z0-9_/]{1,200}$/;

const encodeText = (v: string): string => Buffer.from(v).toString("base64url");
const decodeText = (raw: string | undefined, shape: RegExp): string | undefined => {
  if (raw === undefined) return undefined;
  const v = Buffer.from(raw, "base64url").toString("utf8");
  if (!shape.test(v)) throw validation("invalid cursor");
  return v;
};

/** Escapes LIKE metacharacters so user text is a literal substring. */
const likeContains = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const CARD_TS = `to_char(l.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Shopper discovery reads (store directory, category tree, store shelf with quick-view fields). They touch only the published
 * read model and reference data under the anonymous user context; a page is a constant number of statements.
 */
export class DiscoveryReader implements DiscoveryPort {
  private readonly mediaUrl: (id: string) => string;
  constructor(private readonly deps: ReaderDeps) {
    this.mediaUrl = deps.mediaUrl ?? ((id) => `/media/${id}`);
  }

  private run<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.deps.client, { kind: "user", marketId: this.deps.marketId }, fn);
  }

  /** One statement. Slug-ordered keyset (slug is unique per market). The category filter is real: stores with a published listing in it. */
  listStores(q: Pick<StoresQuery, "world" | "category_id" | "q" | "cursor" | "limit">): Promise<StoreCardPage> {
    const after = decodeText(q.cursor, SLUG_CURSOR);
    const market = this.deps.marketId.toLowerCase();
    return this.run(async (tx) => {
      const r = await tx.query<StoreRow>(
        `SELECT s.id, s.slug, s.display_name_ar, s.display_name_en, s.tagline_ar, s.tagline_en, s.kind, s.verified_badge, s.followers_count, s.discount_display_mode
           FROM catalog_public_stores s
          WHERE s.market_id = $1
            AND ($2::text IS NULL OR s.kind = $2)
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM catalog_public_listings l WHERE l.store_ref = s.id AND l.status = 'PUBLISHED' AND l.primary_category_id = $3))
            AND ($4::text IS NULL OR s.display_name_ar ILIKE $4 ESCAPE '\\' OR s.display_name_en ILIKE $4 ESCAPE '\\')
            AND ($5::text IS NULL OR s.slug > $5)
          ORDER BY s.slug LIMIT $6`,
        [this.deps.marketId, q.world === undefined || q.world === "both" ? null : q.world, q.category_id ?? null, q.q === undefined ? null : likeContains(q.q), after ?? null, q.limit + 1],
      );
      const rows = r.rows.slice(0, q.limit);
      const last = rows[rows.length - 1];
      return StorePageSchema.parse({
        items: rows.map((s) => ({
          ...s,
          storefront: { template_code: "default", palette: {}, published_version: 0 },
          live_drop: false,
          art: null,
          canonical_path: `/${market}/stores/${s.slug}`,
        })),
        next_cursor: r.rows.length > q.limit && last !== undefined ? encodeText(last.slug) : null,
      });
    });
  }

  /** One statement: the market's visible categories in tree-walk (path) order with both labels; Arabic always exists. */
  listCategories(q: Pick<CategoriesQuery, "parent_id" | "cursor" | "limit">, locale: "ar" | "en"): Promise<CategoryEntryPage> {
    const after = decodeText(q.cursor, PATH_CURSOR);
    return this.run(async (tx) => {
      const r = await tx.query<CategoryRow>(
        `SELECT c.id, c.parent_id, c.code, c.path, c.depth, c.vertical, la.name AS name_ar, le.name AS name_en, la.slug AS slug_ar, le.slug AS slug_en
           FROM categories c
           JOIN market_categories mc ON mc.category_id = c.id AND mc.market_id = $1 AND mc.active
           JOIN category_labels la ON la.category_id = c.id AND la.locale = 'ar'
           LEFT JOIN category_labels le ON le.category_id = c.id AND le.locale = 'en'
          WHERE c.active AND ($2::uuid IS NULL OR c.parent_id = $2) AND ($3::text IS NULL OR c.path > $3)
          ORDER BY c.path LIMIT $4`,
        [this.deps.marketId, q.parent_id ?? null, after ?? null, q.limit + 1],
      );
      const rows = r.rows.slice(0, q.limit);
      const last = rows[rows.length - 1];
      return CategoryEntryPageSchema.parse({
        items: rows.map((c) => ({
          id: c.id,
          parent_id: c.parent_id,
          code: c.code,
          path: c.path,
          depth: c.depth,
          vertical: c.vertical,
          name: locale === "en" && c.name_en !== null ? c.name_en : c.name_ar,
          slug: locale === "en" && c.slug_en !== null ? c.slug_en : c.slug_ar,
          name_ar: c.name_ar,
          name_en: c.name_en,
        })),
        next_cursor: r.rows.length > q.limit && last !== undefined ? encodeText(last.path) : null,
      });
    });
  }

  /** Two statements (store by slug, one page of cards). Only columns that exist in the read model; warranty is not one of them. */
  listStoreProducts(slug: string, q: { cursor?: string; limit: number }): Promise<QuickProductCardPage> {
    const cur = decodeCursor(q.cursor);
    const market = this.deps.marketId.toLowerCase();
    return this.run(async (tx) => {
      const store = (await tx.query<{ id: string }>("SELECT id FROM catalog_public_stores WHERE market_id = $1 AND slug = $2", [this.deps.marketId, slug])).rows[0];
      if (store === undefined) throw notFound("store");
      const params: unknown[] = [store.id];
      if (cur !== undefined) params.push(cur.t, cur.id);
      params.push(q.limit + 1);
      const r = await tx.query<CardRow>(
        `SELECT l.id, l.store_ref, l.store ->> 'slug' AS store_slug, l.title_ar, l.title_en, l.main_media_id, l.main_media_alt_ar, l.condition_grade_code,
                l.condition_grade ->> 'label_ar' AS condition_label_ar, l.condition_grade ->> 'label_en' AS condition_label_en, l.colour_code,
                l.defect_count, l.min_price_minor::text AS min_price_minor, l.currency, l.variants -> 0 ->> 'sku_id' AS sku_id, ${CARD_TS} AS cur_t
           FROM catalog_public_listings l
          WHERE l.store_ref = $1 AND l.status = 'PUBLISHED'${cur === undefined ? "" : " AND (l.published_at, l.id) < ($2::timestamptz, $3::uuid)"}
          ORDER BY l.published_at DESC, l.id DESC LIMIT $${cur === undefined ? "2" : "4"}`,
        params,
      );
      const rows = r.rows.slice(0, q.limit);
      const last = rows[rows.length - 1];
      return QuickPageSchema.parse({
        items: rows.map((x) => ({
          product_id: x.id,
          sku_id: x.sku_id,
          store_id: x.store_ref,
          store_slug: x.store_slug,
          title_ar: x.title_ar,
          title_en: x.title_en,
          image: x.main_media_id === null ? null : { media_id: x.main_media_id, url: this.mediaUrl(x.main_media_id), alt_ar: x.main_media_alt_ar },
          condition_grade_code: x.condition_grade_code,
          condition_label_ar: x.condition_label_ar,
          condition_label_en: x.condition_label_en,
          colour_code: x.colour_code,
          defect_count: x.defect_count,
          // The catalog never invents a reference price: plain until Price Watch verifies a claim.
          price: { current_price: { amount_minor: x.min_price_minor, currency: x.currency }, claim_type: "plain", price_proof_path: `/${market}/products/${x.id}/price-evidence` },
          canonical_path: `/${market}/products/${x.id}`,
        })),
        next_cursor: r.rows.length > q.limit && last !== undefined ? encodeCursor({ t: last.cur_t, id: last.id }) : null,
      });
    });
  }
}
