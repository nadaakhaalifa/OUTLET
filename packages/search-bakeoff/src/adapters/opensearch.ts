import type { FetchLike, SearchDoc, SearchEnginePort, SearchFilters, SearchResult } from "../port.js";
import { asArray, asRecord, defaultFetch, num, requestJson, str } from "./http.js";

export const OPENSEARCH_VERSION = "2.18.0";

export interface OpenSearchOptions {
  readonly baseUrl?: string;
  readonly index?: string;
  readonly fetch?: FetchLike;
}

export const openSearchFilter = (f: SearchFilters): unknown[] => [
  ...(f.maxPriceMinor === undefined ? [] : [{ range: { price_minor: { lte: f.maxPriceMinor } } }]),
  ...(f.category === undefined ? [] : [{ term: { category: f.category } }]),
  ...(f.brand === undefined ? [] : [{ term: { brand: f.brand } }]),
  ...(f.inStockOnly === true ? [{ term: { in_stock: true } }] : []),
];

export class OpenSearchAdapter implements SearchEnginePort {
  public readonly name = "opensearch";
  private readonly base: string;
  private readonly idx: string;
  private readonly f: FetchLike;
  private readonly headers = { "Content-Type": "application/json" };

  public constructor(o: OpenSearchOptions = {}) {
    this.base = o.baseUrl ?? "http://127.0.0.1:9200";
    this.idx = o.index ?? "bakeoff_products";
    this.f = o.fetch ?? defaultFetch;
  }

  public async health(): Promise<boolean> {
    try {
      const status = asRecord(await requestJson(this.f, "GET", `${this.base}/_cluster/health`, this.headers)).status;
      return status === "green" || status === "yellow";
    } catch {
      return false;
    }
  }

  public async index(docs: readonly SearchDoc[]): Promise<void> {
    await requestJson(this.f, "DELETE", `${this.base}/${this.idx}`, this.headers, undefined, [404]);
    const mapping = {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          analyzer: {
            ar_text: { tokenizer: "standard", filter: ["lowercase", "decimal_digit", "arabic_normalization", "arabic_stem"] },
          },
        },
      },
      mappings: {
        properties: {
          search_text: { type: "text", analyzer: "ar_text" },
          title_ar: { type: "text", analyzer: "ar_text" },
          title_en: { type: "text", analyzer: "standard" },
          category: { type: "keyword" },
          brand: { type: "keyword" },
          price_minor: { type: "long" },
          in_stock: { type: "boolean" },
        },
      },
    };
    await requestJson(this.f, "PUT", `${this.base}/${this.idx}`, this.headers, JSON.stringify(mapping));
    const lines = docs.flatMap((d) => [
      JSON.stringify({ index: { _index: this.idx, _id: d.id } }),
      JSON.stringify({ search_text: d.searchText, title_ar: d.titleAr, title_en: d.titleEn, category: d.category, brand: d.brand, price_minor: d.priceMinor, in_stock: d.inStock }),
    ]);
    const res = asRecord(await requestJson(this.f, "POST", `${this.base}/_bulk?refresh=true`, { "Content-Type": "application/x-ndjson" }, `${lines.join("\n")}\n`));
    if (res.errors === true) throw new Error("opensearch bulk reported errors");
  }

  public async search(q: string, filters: SearchFilters, limit = 10): Promise<SearchResult> {
    const body = {
      size: limit,
      query: {
        bool: {
          must: [{ multi_match: { query: q, fields: ["search_text", "title_ar", "title_en"], operator: "and", fuzziness: "AUTO" } }],
          filter: openSearchFilter(filters),
        },
      },
    };
    const res = asRecord(await requestJson(this.f, "POST", `${this.base}/${this.idx}/_search`, this.headers, JSON.stringify(body)));
    const hits = asArray(asRecord(res.hits).hits);
    return { hits: hits.map((h) => ({ id: str(asRecord(h)._id), score: num(asRecord(h)._score) })) };
  }
}
