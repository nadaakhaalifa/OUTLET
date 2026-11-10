import { randomUUID } from "node:crypto";
import { withDbContext } from "@outlet/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryListingsSql, sellerListSql, storeListingsSql } from "../src/index.js";
import { LISTING_DETAIL_SQL, PASSPORT_SQL } from "../src/application/queries.js";
import { CAT, buildWorld } from "./fixtures.js";
import type { World } from "./fixtures.js";

/**
 * BUILD-PROMPT section 3: every hot query is backed by an index. 2,000 rows per table spread over several stores,
 * statistics gathered, sequential scans switched off, so the planner can only pick a seq scan when no usable index exists.
 */
let w: World;
const N = 2000;
const STORE_X = randomUUID();
const CARD = randomUUID();

beforeAll(async () => {
  w = await buildWorld();
  const { raw } = w;
  await raw.query(`INSERT INTO stores (id, seller_id, market_id, slug, display_name_ar, kind, ships_from_country, status) VALUES ($1,$2,'EG','store-x','متجر س','local','EG','ACTIVE')`, [STORE_X, w.seed.sellerA]);
  for (const [store, mod] of [[STORE_X, 1], [w.seed.storeB, 2]] as const) {
    await raw.query(
      `INSERT INTO products (id, store_id, market_id, primary_category_id, status, title_ar, description_ar, condition_grade_code, published_at, updated_at)
       SELECT gen_random_uuid(), $1, 'EG', $2, (ARRAY['PUBLISHED','DRAFT','PAUSED','PUBLISHED','SOLD_OUT'])[1 + i % 5], 'عنوان', 'وصف', 'new_with_tags',
              timestamptz '2030-01-01' + (i * $3) * interval '1 second', timestamptz '2030-01-01' + (i * $3) * interval '1 second'
         FROM generate_series(1, ${String(N)}) AS i`,
      [store, CAT.womenDresses, mod],
    );
    await raw.query(
      `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, description_ar, primary_category_id, condition_grade_code, condition_grade,
                                            min_price_minor, currency, attributes, variants, version, published_at, updated_at)
       SELECT gen_random_uuid(), $1, 'EG', '{}'::jsonb, 'PUBLISHED', 'عنوان', 'وصف', $2, 'new_with_tags', '{}'::jsonb, 1000 + i, 'EGP', '{}'::jsonb,
              '[{"sku_id":"x"}]'::jsonb, 1, timestamptz '2030-01-01' + (i * $3) * interval '1 second', timestamptz '2030-01-01'
         FROM generate_series(1, ${String(N)}) AS i`,
      [store, store === STORE_X ? CAT.womenDresses : CAT.kidsGirls, mod],
    );
  }
  await raw.query(
    `INSERT INTO skus (id, product_id, store_id, market_id, seller_sku, option_values, price_minor, currency)
     SELECT gen_random_uuid(), p.id, p.store_id, 'EG', 'X-' || row_number() OVER (), '{}'::jsonb, 1000, 'EGP' FROM products p WHERE p.store_id = $1`,
    [STORE_X],
  );
  await raw.query(
    `INSERT INTO catalog_public_passports (token_hash, market_id, product_id, title_ar, store_slug, store_name_ar, unit_status, condition_grade, defect_card, content_hash, inspections, issued_at)
     SELECT sha256(i::text::bytea), 'EG', gen_random_uuid(), 'عنوان', 'store-x', 'متجر', 'IN_STOCK', '{}'::jsonb, '{}'::jsonb, repeat('a', 64), '[]'::jsonb, now()
       FROM generate_series(1, ${String(N)}) AS i`,
  );
  await raw.query(
    `INSERT INTO catalog_public_stores (id, market_id, slug, display_name_ar, kind, status, verified_badge, ships_from_country, followers_count, discount_display_mode, legal_identity, updated_at)
     SELECT gen_random_uuid(), 'EG', 'bulk-' || i, 'متجر', 'local', 'ACTIVE', false, 'EG', 0, 'public', '{}'::jsonb, now() FROM generate_series(1, ${String(N)}) AS i`,
  );
  for (const t of ["products", "skus", "catalog_public_listings", "catalog_public_passports", "catalog_public_stores", "brands", "defect_items", "defect_cards"]) await raw.query(`ANALYZE ${t}`);
}, 120_000);

afterAll(async () => {
  await w.close();
});

interface Plan {
  "Node Type": string;
  "Index Name"?: string;
  Plans?: Plan[];
}

const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

/** Plans `sql` as outlet_app (RLS active) with seq scans disabled. */
const plan = async (ctx: "store" | "public", sql: string, params: unknown[]): Promise<Plan[]> =>
  withDbContext(w.app, ctx === "store" ? { kind: "store", marketId: "EG", storeId: STORE_X } : { kind: "user", marketId: "EG" }, async (tx) => {
    await tx.query("SET LOCAL enable_seqscan = off");
    const r = await tx.query<{ "QUERY PLAN": { Plan: Plan }[] }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    const root = r.rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (root === undefined) throw new Error("no plan");
    return nodes(root);
  });

const usesIndex = (ns: Plan[], name: string): boolean => ns.some((n) => n["Index Name"] === name);
const noSeqScan = (ns: Plan[]): boolean => ns.every((n) => n["Node Type"] !== "Seq Scan");
const noSort = (ns: Plan[]): boolean => ns.every((n) => n["Node Type"] !== "Sort");

const cursor = ["2031-01-01T00:00:00.000000Z", randomUUID()];

describe("EXPLAIN: hot catalog queries use their index (2k rows, enable_seqscan=off)", () => {
  it("seller list, no filter: products_store_updated_idx, ordered by the index (no sort)", async () => {
    const ns = await plan("store", sellerListSql({ status: false, cursor: false }), [STORE_X, 21]);
    expect(usesIndex(ns, "products_store_updated_idx")).toBe(true);
    expect(noSeqScan(ns)).toBe(true);
    expect(noSort(ns)).toBe(true);
  });

  it("seller list, status + keyset cursor: products_store_status_updated_idx, no sort", async () => {
    const ns = await plan("store", sellerListSql({ status: true, cursor: true }), [STORE_X, "PUBLISHED", ...cursor, 21]);
    expect(usesIndex(ns, "products_store_status_updated_idx")).toBe(true);
    expect(noSeqScan(ns)).toBe(true);
    expect(noSort(ns)).toBe(true);
  });

  it("seller list sku_count subquery uses skus_product_idx (no per-row seq scan)", async () => {
    const ns = await plan("store", sellerListSql({ status: false, cursor: false }), [STORE_X, 21]);
    expect(usesIndex(ns, "skus_product_idx")).toBe(true);
  });

  it("store shelf keyset: catalog_public_listings_store_idx, no sort", async () => {
    for (const withCursor of [false, true]) {
      const ns = await plan("public", storeListingsSql({ cursor: withCursor }), withCursor ? [STORE_X, ...cursor, 21] : [STORE_X, 21]);
      expect(usesIndex(ns, "catalog_public_listings_store_idx")).toBe(true);
      expect(noSeqScan(ns)).toBe(true);
      expect(noSort(ns)).toBe(true);
    }
  });

  it("category listing keyset: catalog_public_listings_category_idx, no sort", async () => {
    for (const withCursor of [false, true]) {
      const ns = await plan("public", categoryListingsSql({ cursor: withCursor }), withCursor ? ["EG", CAT.womenDresses, ...cursor, 21] : ["EG", CAT.womenDresses, 21]);
      expect(usesIndex(ns, "catalog_public_listings_category_idx")).toBe(true);
      expect(noSeqScan(ns)).toBe(true);
      expect(noSort(ns)).toBe(true);
    }
  });

  it("product detail, passport lookup, store by slug, brand by slug, categories: primary or unique keys", async () => {
    expect(usesIndex(await plan("public", LISTING_DETAIL_SQL, [randomUUID(), "EG"]), "catalog_public_listings_pkey")).toBe(true);
    expect(usesIndex(await plan("public", PASSPORT_SQL, [Buffer.alloc(32), "EG"]), "catalog_public_passports_pkey")).toBe(true);
    expect(usesIndex(await plan("public", "SELECT id FROM catalog_public_stores WHERE market_id = $1 AND slug = $2", ["EG", "bulk-7"]), "catalog_public_stores_market_id_slug_key")).toBe(true);
    expect(usesIndex(await plan("public", "SELECT id, name FROM brands WHERE slug = $1", ["zara"]), "brands_slug_key")).toBe(true);
    expect(usesIndex(await plan("public", "SELECT id FROM categories WHERE path > $1 ORDER BY path LIMIT 20", ["fashion"]), "categories_path_key")).toBe(true);
  });

  it("seller-side loaders: variants by product, defect items by card, media by product, product_categories", async () => {
    const skus = await plan("store", "SELECT id FROM skus WHERE product_id = $1 ORDER BY created_at, id", [randomUUID()]);
    expect(usesIndex(skus, "skus_product_idx")).toBe(true);
    const items = await plan("store", "SELECT id FROM defect_items WHERE defect_card_id = $1 ORDER BY position", [CARD]);
    expect(usesIndex(items, "defect_items_defect_card_id_position_key")).toBe(true);
    const media = await plan("store", "SELECT id FROM product_media WHERE product_id = $1 ORDER BY position", [randomUUID()]);
    expect(usesIndex(media, "product_media_product_id_position_key")).toBe(true);
    const cards = await plan("store", "SELECT version FROM defect_cards WHERE product_id = $1 ORDER BY version", [randomUUID()]);
    expect(usesIndex(cards, "defect_cards_product_id_version_key")).toBe(true);
    const cats = await plan("store", "SELECT category_id FROM product_categories WHERE product_id = $1", [randomUUID()]);
    expect(usesIndex(cats, "product_categories_pkey")).toBe(true);
  });

  it("a query that has no index is caught by this harness (negative control)", async () => {
    const ns = await plan("public", "SELECT id FROM catalog_public_listings WHERE title_en = $1", ["x"]);
    expect(noSeqScan(ns)).toBe(false);
  });
});
