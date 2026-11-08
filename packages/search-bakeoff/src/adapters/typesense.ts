import type { FetchLike, SearchDoc, SearchEnginePort, SearchFilters, SearchResult } from "../port.js";
import { asArray, asRecord, defaultFetch, num, requestJson, str } from "./http.js";

/** Pinned for the bake-off; see infra/local/search/docker-compose.search.yml. */
export const TYPESENSE_VERSION = "27.1";

export interface TypesenseOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly collection?: string;
  readonly fetch?: FetchLike;
}

export const typesenseFilter = (f: SearchFilters): string =>
  [
    f.maxPriceMinor === undefined ? "" : `price_minor:<=${String(f.maxPriceMinor)}`,
    f.category === undefined ? "" : `category:=${f.category}`,
    f.brand === undefined ? "" : `brand:=${f.brand}`,
    f.inStockOnly === true ? "in_stock:=true" : "",
  ]
    .filter((x) => x.length > 0)
    .join(" && ");

export class TypesenseAdapter implements SearchEnginePort {
  public readonly name = "typesense";
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly coll: string;
  private readonly f: FetchLike;

  public constructor(o: TypesenseOptions = {}) {
    this.base = o.baseUrl ?? "http://127.0.0.1:8108";
    this.headers = { "X-TYPESENSE-API-KEY": o.apiKey ?? "bakeoff-local-key", "Content-Type": "application/json" };
    this.coll = o.collection ?? "bakeoff_products";
    this.f = o.fetch ?? defaultFetch;
  }

  public async health(): Promise<boolean> {
    try {
      return asRecord(await requestJson(this.f, "GET", `${this.base}/health`, this.headers)).ok === true;
    } catch {
      return false;
    }
  }

  public async index(docs: readonly SearchDoc[]): Promise<void> {
    await requestJson(this.f, "DELETE", `${this.base}/collections/${this.coll}`, this.headers, undefined, [404]);
    const schema = {
      name: this.coll,
      fields: [
        { name: "search_text", type: "string" },
        { name: "title_ar", type: "string" },
        { name: "title_en", type: "string" },
        { name: "category", type: "string", facet: true },
        { name: "brand", type: "string", facet: true },
        { name: "price_minor", type: "int64" },
        { name: "in_stock", type: "bool" },
      ],
    };
    await requestJson(this.f, "POST", `${this.base}/collections`, this.headers, JSON.stringify(schema));
    const ndjson = docs
      .map((d) =>
        JSON.stringify({ id: d.id, search_text: d.searchText, title_ar: d.titleAr, title_en: d.titleEn, category: d.category, brand: d.brand, price_minor: d.priceMinor, in_stock: d.inStock }),
      )
      .join("\n");
    const res = await this.f(`${this.base}/collections/${this.coll}/documents/import?action=upsert`, { method: "POST", headers: this.headers, body: ndjson });
    if (!res.ok) throw new Error(`typesense import failed: ${String(res.status)}`);
  }

  public async search(q: string, filters: SearchFilters, limit = 10): Promise<SearchResult> {
    const params = new URLSearchParams({ q, query_by: "search_text,title_ar,title_en", per_page: String(limit), num_typos: "2", drop_tokens_threshold: "0" });
    const fb = typesenseFilter(filters);
    if (fb.length > 0) params.set("filter_by", fb);
    const body = asRecord(await requestJson(this.f, "GET", `${this.base}/collections/${this.coll}/documents/search?${params.toString()}`, this.headers));
    const hits = asArray(body.hits).map((h) => {
      const r = asRecord(h);
      return { id: str(asRecord(r.document).id), score: num(r.text_match) };
    });
    return { hits };
  }
}
