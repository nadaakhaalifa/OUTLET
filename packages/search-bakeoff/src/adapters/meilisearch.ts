import type { FetchLike, SearchDoc, SearchEnginePort, SearchFilters, SearchResult } from "../port.js";
import { asArray, asRecord, defaultFetch, num, requestJson, str } from "./http.js";

export const MEILISEARCH_VERSION = "v1.12.0";

export interface MeilisearchOptions {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly index?: string;
  readonly fetch?: FetchLike;
  readonly pollMs?: number;
}

export const meiliFilter = (f: SearchFilters): string =>
  [
    f.maxPriceMinor === undefined ? "" : `price_minor <= ${String(f.maxPriceMinor)}`,
    f.category === undefined ? "" : `category = "${f.category}"`,
    f.brand === undefined ? "" : `brand = "${f.brand}"`,
    f.inStockOnly === true ? "in_stock = true" : "",
  ]
    .filter((x) => x.length > 0)
    .join(" AND ");

export class MeilisearchAdapter implements SearchEnginePort {
  public readonly name = "meilisearch";
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly uid: string;
  private readonly f: FetchLike;
  private readonly pollMs: number;

  public constructor(o: MeilisearchOptions = {}) {
    this.base = o.baseUrl ?? "http://127.0.0.1:7700";
    this.headers = { "Content-Type": "application/json", ...(o.apiKey === undefined ? {} : { Authorization: `Bearer ${o.apiKey}` }) };
    this.uid = o.index ?? "bakeoff_products";
    this.f = o.fetch ?? defaultFetch;
    this.pollMs = o.pollMs ?? 200;
  }

  public async health(): Promise<boolean> {
    try {
      return asRecord(await requestJson(this.f, "GET", `${this.base}/health`, this.headers)).status === "available";
    } catch {
      return false;
    }
  }

  private async waitTask(resp: unknown): Promise<void> {
    const uid = asRecord(resp).taskUid;
    if (typeof uid !== "number") return;
    for (let i = 0; i < 600; i += 1) {
      const t = asRecord(await requestJson(this.f, "GET", `${this.base}/tasks/${String(uid)}`, this.headers));
      const status = t.status;
      if (status === "succeeded") return;
      if (status === "failed" || status === "canceled") throw new Error(`meilisearch task ${String(uid)} ${status}`);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new Error(`meilisearch task ${String(uid)} timed out`);
  }

  public async index(docs: readonly SearchDoc[]): Promise<void> {
    await this.waitTask(await requestJson(this.f, "DELETE", `${this.base}/indexes/${this.uid}`, this.headers, undefined, [404]));
    await this.waitTask(await requestJson(this.f, "POST", `${this.base}/indexes`, this.headers, JSON.stringify({ uid: this.uid, primaryKey: "id" })));
    const settings = { searchableAttributes: ["search_text", "title_ar", "title_en"], filterableAttributes: ["price_minor", "category", "brand", "in_stock"], typoTolerance: { enabled: true } };
    await this.waitTask(await requestJson(this.f, "PATCH", `${this.base}/indexes/${this.uid}/settings`, this.headers, JSON.stringify(settings)));
    const body = JSON.stringify(
      docs.map((d) => ({ id: d.id, search_text: d.searchText, title_ar: d.titleAr, title_en: d.titleEn, category: d.category, brand: d.brand, price_minor: d.priceMinor, in_stock: d.inStock })),
    );
    await this.waitTask(await requestJson(this.f, "POST", `${this.base}/indexes/${this.uid}/documents`, this.headers, body));
  }

  public async search(q: string, filters: SearchFilters, limit = 10): Promise<SearchResult> {
    const filter = meiliFilter(filters);
    const payload = { q, limit, matchingStrategy: "all", showRankingScore: true, ...(filter.length > 0 ? { filter } : {}) };
    const body = asRecord(await requestJson(this.f, "POST", `${this.base}/indexes/${this.uid}/search`, this.headers, JSON.stringify(payload)));
    return { hits: asArray(body.hits).map((h) => ({ id: str(asRecord(h).id), score: num(asRecord(h)._rankingScore) })) };
  }
}
