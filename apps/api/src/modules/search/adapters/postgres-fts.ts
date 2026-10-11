import { sql, type Kysely, type RawBuilder } from "kysely";
import { z } from "zod";
import { normalizeSearchText } from "../domain/bridge";
import type {
  IndexedProduct,
  SearchHit,
  SearchIndexWriter,
  SearchPage,
  SearchPort,
  SearchRequest,
} from "../domain/ports";
import { termGroups } from "./matching";

/** Raw SQL only, rows validated with Zod (same approach as the cart and inventory adapters, ADR-0020). */
export type SearchDb = Kysely<Record<string, never>>;

const Hit = z.object({ product_id: z.string(), sponsored: z.boolean(), total: z.string() });
const Title = z.object({ title: z.string() });

/** `{"a","b"}` text[] / uuid[] literal; each element is quoted and escaped, so it is never executable. */
export function pgArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`).join(",")}}`;
}

/** tsquery text built only from letters and digits; bound as a parameter, never interpolated. */
export function toTsQuery(groups: readonly (readonly string[])[]): string | null {
  const parts = groups
    .map((g) => g.filter((f) => /^[\p{L}\p{N}]+$/u.test(f)))
    .filter((g) => g.length > 0)
    .map((g) => `(${g.map((f) => `${f}:*`).join(" | ")})`);
  return parts.length === 0 ? null : parts.join(" & ");
}

const FOURTEEN_DAYS_MS = 14 * 86_400_000;

function filterConditions(req: SearchRequest): RawBuilder<unknown>[] {
  const f = req.filter;
  const c: RawBuilder<unknown>[] = [sql`d.in_stock`];
  if (req.storeScope !== null) c.push(sql`d.store_id = any(${pgArray(req.storeScope)}::uuid[])`);
  if (f.storeIds !== undefined) c.push(sql`d.store_id = any(${pgArray(f.storeIds)}::uuid[])`);
  if (f.world === "local" || f.world === "global") c.push(sql`d.world = ${f.world}`);
  if (f.priceMin !== undefined) c.push(sql`d.price_amount >= ${f.priceMin.toString()}::bigint`);
  if (f.priceMax !== undefined) c.push(sql`d.price_amount <= ${f.priceMax.toString()}::bigint`);
  if (f.budgetMax !== undefined) c.push(sql`d.price_amount <= ${f.budgetMax.toString()}::bigint`);
  if (f.colors !== undefined) c.push(sql`d.colors && ${pgArray(f.colors)}::text[]`);
  if (f.materials !== undefined) c.push(sql`d.materials && ${pgArray(f.materials)}::text[]`);
  if (f.conditions !== undefined) c.push(sql`d.condition = any(${pgArray(f.conditions)}::text[])`);
  if (f.categoryIds !== undefined) c.push(sql`d.category_ids && ${pgArray(f.categoryIds)}::uuid[]`);
  if (f.verifiedDiscountOnly === true) c.push(sql`d.verified_discount_pct is not null`);
  if (f.minVerifiedDiscountPct !== undefined) {
    c.push(sql`coalesce(d.verified_discount_pct, 0) >= ${f.minVerifiedDiscountPct}`);
  }
  if (f.lowest30dOnly === true) c.push(sql`d.lowest_30d`);
  if (f.newArrivals === true) {
    c.push(sql`d.listed_at >= to_timestamp(${(req.nowMs - FOURTEEN_DAYS_MS).toString()}::double precision / 1000)`);
  }
  if (f.minRating !== undefined) c.push(sql`d.rating >= ${f.minRating}`);
  if (f.freeDeliveryEligible === true) c.push(sql`d.free_delivery_eligible`);
  return c;
}

/**
 * Postgres FTS + trigram adapter: the documented Typesense-down fallback (spec 4). Arabic has no
 * stock stemmer, so text is matched with the `simple` configuration on text normalized by the
 * indexer (and again here for the query), with prefix matching. When FTS finds nothing and
 * pg_trgm is installed, word similarity rescues typos. Reads only the search_documents read model;
 * price and stock are re-read by the caller.
 */
export class PostgresFtsSearchPort implements SearchPort, SearchIndexWriter {
  readonly engine = "postgres_fts" as const;

  private constructor(
    private readonly db: SearchDb,
    private readonly trigram: boolean,
  ) {}

  /** Feature-detects pg_trgm once (0001 installs it only where the server offers it). */
  static async create(db: SearchDb): Promise<PostgresFtsSearchPort> {
    const r = await sql<{ n: string }>`select count(*)::text as n from pg_extension where extname = 'pg_trgm'`.execute(db);
    return new PostgresFtsSearchPort(db, (r.rows[0]?.n ?? "0") !== "0");
  }

  get trigramEnabled(): boolean {
    return this.trigram;
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    const groups = termGroups(req.keywords);
    const conds = filterConditions(req);
    const tsq = toTsQuery(groups);
    if (tsq !== null) {
      const where = sql.join([...conds, sql`d.tsv @@ to_tsquery('simple', ${tsq})`], sql` and `);
      const fts = await this.run(
        sql`select d.product_id::text as product_id, d.sponsored, count(*) over ()::text as total
              from search_documents d where ${where}
             order by ts_rank(d.tsv, to_tsquery('simple', ${tsq})) desc, d.listed_at desc, d.product_id
             limit ${req.limit} offset ${req.offset}`,
      );
      if (fts.hits.length > 0 || !this.trigram || req.offset > 0) return fts;
      const sim = groups.map((g) => sql`(${sql.join(g.map((f) => sql`word_similarity(${f}, d.search_text) >= 0.5`), sql` or `)})`);
      const swhere = sql.join([...conds, ...sim], sql` and `);
      return this.run(
        sql`select d.product_id::text as product_id, d.sponsored, count(*) over ()::text as total
              from search_documents d where ${swhere}
             order by d.listed_at desc, d.product_id
             limit ${req.limit} offset ${req.offset}`,
      );
    }
    const where = sql.join(conds, sql` and `);
    return this.run(
      sql`select d.product_id::text as product_id, d.sponsored, count(*) over ()::text as total
            from search_documents d where ${where}
           order by d.listed_at desc, d.product_id
           limit ${req.limit} offset ${req.offset}`,
    );
  }

  private async run(q: RawBuilder<unknown>): Promise<SearchPage> {
    const r = await q.execute(this.db);
    const rows = r.rows.map((x) => Hit.parse(x));
    const hits: SearchHit[] = rows.map((x) => ({ productId: x.product_id, sponsored: x.sponsored }));
    return { hits, total: Number(rows[0]?.total ?? "0"), degraded: true };
  }

  async suggest(prefixNormalized: string, limit: number): Promise<readonly string[]> {
    const p = normalizeSearchText(prefixNormalized).replace(/[\\%_]/gu, "");
    if (p.length === 0) return [];
    const r = await sql<unknown>`
      select title_ar as title from search_documents
       where in_stock and (search_text like ${`${p}%`} or search_text like ${`% ${p}%`})
       order by listed_at desc limit ${limit}`.execute(this.db);
    return r.rows.map((x) => Title.parse(x).title);
  }

  async upsert(doc: IndexedProduct): Promise<void> {
    const text = normalizeSearchText(doc.searchText);
    await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await sql`
        insert into search_documents (product_id, store_id, world, title_ar, title_en, search_text, price_amount,
          colors, materials, condition, category_ids, verified_discount_pct, lowest_30d, free_delivery_eligible,
          rating, sponsored, in_stock, listed_at, indexed_at)
        values (${doc.productId}::uuid, ${doc.storeId}::uuid, ${doc.world}, ${doc.titleAr}, ${doc.titleEn}, ${text},
          ${doc.priceAmount.toString()}::bigint, ${pgArray(doc.colors)}::text[], ${pgArray(doc.materials)}::text[],
          ${doc.condition}, ${pgArray(doc.categoryIds)}::uuid[], ${doc.verifiedDiscountPct}, ${doc.lowest30d},
          ${doc.freeDeliveryEligible}, ${doc.rating}, ${doc.sponsored}, ${doc.inStock},
          to_timestamp(${doc.listedAtMs.toString()}::double precision / 1000), now())
        on conflict (product_id) do update set
          store_id = excluded.store_id, world = excluded.world, title_ar = excluded.title_ar,
          title_en = excluded.title_en, search_text = excluded.search_text, price_amount = excluded.price_amount,
          colors = excluded.colors, materials = excluded.materials, condition = excluded.condition,
          category_ids = excluded.category_ids, verified_discount_pct = excluded.verified_discount_pct,
          lowest_30d = excluded.lowest_30d, free_delivery_eligible = excluded.free_delivery_eligible,
          rating = excluded.rating, sponsored = excluded.sponsored, in_stock = excluded.in_stock,
          listed_at = excluded.listed_at, indexed_at = now()`.execute(trx);
    });
  }

  async remove(productId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await sql`delete from search_documents where product_id = ${productId}::uuid`.execute(trx);
    });
  }
}
