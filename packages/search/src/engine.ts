import type { Queryable } from "@outlet/db";

/** What an external engine (Typesense and similar, undecided: ADR-0010) is given for one product: the published read-model row, never anything else. */
export interface EngineDocument {
  readonly marketId: string;
  readonly productId: string;
  readonly storeRef: string;
  readonly categoryId: string | null;
  readonly world: string;
  readonly titleAr: string;
  readonly titleEn: string;
  readonly searchText: string;
  readonly priceMinor: string;
  readonly currency: string;
  readonly conditionGrade: string;
  readonly sizes: readonly string[];
  readonly verifiedDiscount: boolean;
  readonly lowest30d: boolean;
  readonly inStock: boolean;
  readonly isPublished: boolean;
  /** Source version (event microseconds): an engine adapter must ignore a document older than the one it holds. */
  readonly seq: string;
}

/**
 * Port to the external search engine. `configured = false` is the honest state while no engine is chosen or contracted: nothing is ever sent, and
 * staleness reports `search_provider_unconfigured` instead of "fresh". A configured adapter must be idempotent per (marketId, productId, seq).
 */
export interface SearchEnginePort {
  readonly configured: boolean;
  index(doc: EngineDocument): Promise<void>;
}

export class SearchProviderUnconfiguredError extends Error {
  constructor() {
    super("search_provider_unconfigured");
    this.name = "SearchProviderUnconfiguredError";
  }
}

/** Production default (ADR-0029): fails closed. The Postgres read model keeps serving through the FTS path. */
export class UnconfiguredSearchEngine implements SearchEnginePort {
  readonly configured = false;
  index(): Promise<void> {
    return Promise.reject(new SearchProviderUnconfiguredError());
  }
}

interface DocRow {
  product_id: string; store_ref: string; category_id: string | null; world: string; title_ar: string; title_en: string; search_text: string;
  price_minor: string; currency: string; condition_grade: string; sizes: string[]; verified_discount: boolean; lowest_30d: boolean; in_stock: boolean;
  is_published: boolean; seq: string;
}

export interface EngineReconcileResult {
  readonly indexed: number;
  readonly failed: number;
  /** Documents still ahead of the engine after this run (all of them when the engine is unconfigured). */
  readonly pending: number;
}

/**
 * Mirrors search_documents rows that are ahead of the engine (seq IS DISTINCT FROM engine_synced_seq) and records the seq it mirrored. `db` must be a
 * context allowed to read and update search_documents (worker job `search.sync`). With an unconfigured engine nothing is sent and nothing is marked:
 * the rows stay pending and staleness keeps saying so. A failure leaves the row pending (retried next run); a newer seq that landed meanwhile is not marked.
 */
export const reconcileEngine = async (db: Queryable, marketId: string, engine: SearchEnginePort, limit = 100): Promise<EngineReconcileResult> => {
  const pendingNow = async (): Promise<number> =>
    Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM search_documents WHERE market_id = $1 AND engine_synced_seq IS DISTINCT FROM seq", [marketId])).rows[0]?.n ?? "0");
  if (!engine.configured) return { indexed: 0, failed: 0, pending: await pendingNow() };
  const rows = await db.query<DocRow>(
    `SELECT product_id, store_ref, category_id, world, title_ar, title_en, search_text, price_minor::text AS price_minor, currency, condition_grade, sizes,
            verified_discount, lowest_30d, in_stock, is_published, seq::text AS seq
       FROM search_documents WHERE market_id = $1 AND engine_synced_seq IS DISTINCT FROM seq ORDER BY updated_at, product_id LIMIT $2`,
    [marketId, limit],
  );
  let indexed = 0;
  let failed = 0;
  for (const r of rows.rows) {
    try {
      await engine.index({
        marketId, productId: r.product_id, storeRef: r.store_ref, categoryId: r.category_id, world: r.world, titleAr: r.title_ar, titleEn: r.title_en, searchText: r.search_text,
        priceMinor: r.price_minor, currency: r.currency, conditionGrade: r.condition_grade, sizes: r.sizes, verifiedDiscount: r.verified_discount, lowest30d: r.lowest_30d,
        inStock: r.in_stock, isPublished: r.is_published, seq: r.seq,
      });
      await db.query("UPDATE search_documents SET engine_synced_seq = $3 WHERE market_id = $1 AND product_id = $2 AND seq = $3", [marketId, r.product_id, r.seq]);
      indexed += 1;
    } catch {
      failed += 1;
    }
  }
  return { indexed, failed, pending: await pendingNow() };
};
