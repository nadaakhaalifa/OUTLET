import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { applyMigrations } from "@outlet/db";
import type { Queryable, SqlClient } from "@outlet/db";
import { bootstrapTestRoles } from "@outlet/db/testing";
import type { OutboxEvent } from "@outlet/outbox";
import { uuidv7 } from "@outlet/ids";

export const MARKET = "eg";

export const makeDb = async (): Promise<{ db: PGlite; client: SqlClient }> => {
  const db = new PGlite({ extensions: { unaccent, pg_trgm } });
  await db.waitReady;
  await bootstrapTestRoles(db);
  await applyMigrations(db);
  const wrap = (q: { query: PGlite["query"] }): Queryable => ({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: async <R extends object>(sql: string, params?: readonly unknown[]) => ({ rows: (await q.query<R>(sql, params ? [...params] : [])).rows }),
  });
  const client: SqlClient = { ...wrap(db), transaction: (fn) => db.transaction((t) => fn(wrap(t))) };
  return { db, client };
};

export interface ListingSeed {
  id: string;
  store?: string;
  status?: "PUBLISHED" | "SOLD_OUT" | "PAUSED";
  titleAr: string;
  titleEn?: string;
  price: number;
  grade?: string;
  category?: string;
  sizes?: string[];
  sku?: string;
}

export const STORE_A = "00000000-0000-4000-8000-00000000000a";
export const STORE_B = "00000000-0000-4000-8000-00000000000b";
export const CAT_1 = "00000000-0000-4000-8000-0000000000c1";
export const CAT_2 = "00000000-0000-4000-8000-0000000000c2";

export const seedListing = async (db: Queryable, l: ListingSeed): Promise<void> => {
  const sizes = l.sizes ?? ["m"];
  await db.query(
    `INSERT INTO catalog_public_listings (id, store_ref, market_id, store, status, title_ar, title_en, description_ar, primary_category_id, condition_grade_code, condition_grade,
       min_price_minor, currency, attributes, variants, version, published_at, updated_at)
     VALUES ($1,$2,'eg','{"kind":"local"}'::jsonb,$3,$4,$5,'وصف',$6,$7,'{}'::jsonb,$8,'EGP','{}'::jsonb,$9::jsonb,1, now(), now())
     ON CONFLICT (id) DO UPDATE SET title_ar = EXCLUDED.title_ar, title_en = EXCLUDED.title_en, status = EXCLUDED.status, min_price_minor = EXCLUDED.min_price_minor, variants = EXCLUDED.variants`,
    [l.id, l.store ?? STORE_A, l.status ?? "PUBLISHED", l.titleAr, l.titleEn ?? null, l.category ?? CAT_1, l.grade ?? "new_with_tags", l.price,
      JSON.stringify(sizes.map((s, i) => ({ sku_id: i === 0 && l.sku !== undefined ? l.sku : uuidv7(), size_label: s, price_minor: String(l.price) })))],
  );
};

export const ev = (type: string, payload: Record<string, unknown>, at: string): OutboxEvent => ({
  id: uuidv7(), type, aggregateType: "listing", aggregateId: uuidv7(), marketId: MARKET, occurredAt: at, visibility: "internal", payload,
});

export const NEVER_KILLED = { isEngineKilled: () => Promise.resolve(false), isFtsKilled: () => Promise.resolve(false) };
