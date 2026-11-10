import { normalizeArabic, tokenize } from "../normalize.js";
import type { SearchDoc, SearchEnginePort, SearchFilters, SearchHit, SearchResult } from "../port.js";

/** Structural subset satisfied by PGlite and by a pg-style client wrapper. */
export interface PgLike {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const toHits = (rows: readonly unknown[]): SearchHit[] =>
  rows.map((r) => {
    const row = r as { id: string; score: number | string };
    return { id: row.id, score: typeof row.score === "number" ? row.score : parseFloat(row.score) };
  });

/**
 * Kill-switch fallback (ADR-0010): tsvector with a custom 'arabic_simple' config (unaccent + simple), the shared
 * normaliser applied before indexing and on the query, and a pg_trgm word-similarity fallback for typos.
 * Extensions are optional: when unaccent or pg_trgm are missing the adapter degrades and reports it in `features`.
 */
export class PostgresFtsAdapter implements SearchEnginePort {
  public readonly name = "postgres-fts";
  public readonly features = { unaccent: false, trigram: false };

  public constructor(
    private readonly db: PgLike,
    private readonly trigramThreshold = 0.4,
  ) {}

  public async health(): Promise<boolean> {
    try {
      await this.db.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  private async tryExec(sql: string): Promise<boolean> {
    try {
      await this.db.exec(sql);
      return true;
    } catch {
      return false;
    }
  }

  private async setup(): Promise<void> {
    this.features.unaccent = await this.tryExec("CREATE EXTENSION IF NOT EXISTS unaccent");
    this.features.trigram = await this.tryExec("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await this.db.exec("DROP TEXT SEARCH CONFIGURATION IF EXISTS arabic_simple");
    await this.db.exec("CREATE TEXT SEARCH CONFIGURATION arabic_simple (COPY = pg_catalog.simple)");
    if (this.features.unaccent) {
      await this.db.exec(
        "ALTER TEXT SEARCH CONFIGURATION arabic_simple ALTER MAPPING FOR asciiword, word, numword, asciihword, hword, numhword WITH unaccent, simple",
      );
    }
    await this.db.exec("DROP TABLE IF EXISTS bakeoff_docs");
    await this.db.exec(`CREATE TABLE bakeoff_docs (
      id text PRIMARY KEY, category text NOT NULL, brand text NOT NULL, price_minor bigint NOT NULL,
      in_stock boolean NOT NULL, search_text text NOT NULL, tsv tsvector NOT NULL)`);
    await this.db.exec("CREATE INDEX bakeoff_docs_tsv ON bakeoff_docs USING gin (tsv)");
    if (this.features.trigram) {
      await this.db.exec(`SET pg_trgm.word_similarity_threshold = ${String(this.trigramThreshold)}`);
      await this.db.exec("CREATE INDEX bakeoff_docs_trgm ON bakeoff_docs USING gin (search_text gin_trgm_ops)");
    }
  }

  public async index(docs: readonly SearchDoc[]): Promise<void> {
    await this.setup();
    const chunk = 400;
    for (let i = 0; i < docs.length; i += chunk) {
      const part = docs.slice(i, i + chunk);
      const params: unknown[] = [];
      const values = part.map((d, n) => {
        const text = normalizeArabic(d.searchText);
        params.push(d.id, d.category, d.brand, d.priceMinor, d.inStock, text);
        const b = n * 6;
        return `($${String(b + 1)},$${String(b + 2)},$${String(b + 3)},$${String(b + 4)},$${String(b + 5)},$${String(b + 6)},to_tsvector('arabic_simple',$${String(b + 6)}))`;
      });
      await this.db.query(`INSERT INTO bakeoff_docs (id,category,brand,price_minor,in_stock,search_text,tsv) VALUES ${values.join(",")}`, params);
    }
    await this.db.exec("ANALYZE bakeoff_docs");
  }

  private filterSql(f: SearchFilters, params: unknown[]): string {
    const parts: string[] = [];
    const add = (sql: string, v: unknown): void => {
      params.push(v);
      parts.push(sql.replace("?", `$${String(params.length)}`));
    };
    if (f.maxPriceMinor !== undefined) add("price_minor <= ?", f.maxPriceMinor);
    if (f.category !== undefined) add("category = ?", f.category);
    if (f.brand !== undefined) add("brand = ?", f.brand);
    if (f.inStockOnly === true) parts.push("in_stock");
    return parts.map((p) => ` AND ${p}`).join("");
  }

  public async search(q: string, filters: SearchFilters, limit = 10): Promise<SearchResult> {
    const text = normalizeArabic(q);
    if (text.length === 0) return { hits: [] };
    const params: unknown[] = [text];
    const fsql = this.filterSql(filters, params);
    params.push(limit);
    const exact = await this.db.query(
      `SELECT id, ts_rank(tsv, plainto_tsquery('arabic_simple',$1))::float8 AS score FROM bakeoff_docs
       WHERE tsv @@ plainto_tsquery('arabic_simple',$1)${fsql} ORDER BY score DESC, id LIMIT $${String(params.length)}`,
      params,
    );
    if (exact.rows.length > 0 || !this.features.trigram) return { hits: toHits(exact.rows) };

    const toks = tokenize(text).filter((t) => !/^\d+$/.test(t));
    if (toks.length === 0) return { hits: [] };
    const p2: unknown[] = [];
    const sims = toks.map((t) => {
      p2.push(t);
      return `word_similarity($${String(p2.length)}, search_text)`;
    });
    const fsql2 = this.filterSql(filters, p2);
    p2.push(limit);
    const fuzzy = await this.db.query(
      `SELECT id, (${sims.join(" + ")})::float8 / ${String(toks.length)} AS score FROM bakeoff_docs
       WHERE ${toks.map((_, i) => `$${String(i + 1)} <% search_text`).join(" AND ")}${fsql2} ORDER BY score DESC, id LIMIT $${String(p2.length)}`,
      p2,
    );
    return { hits: toHits(fuzzy.rows) };
  }
}
