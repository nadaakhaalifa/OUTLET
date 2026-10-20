/**
 * DEVELOPMENT / TEST FIXTURES: in-memory index, saved-search repository and fakes for every port.
 * Synthetic data only. Not safe for production (the module refuses to start with real adapters configured).
 */
import { normalizeSearchText } from "../domain/bridge";
import {
  LlmUnavailableError,
  ProductFactsUnavailableError,
  type FacetBucket,
  type FacetCountFacet,
  type IndexedProduct,
  type LlmGatewayPort,
  type ProductFacts,
  type ProductFactsPort,
  type SavedSearchCursor,
  type SavedSearchPatch,
  type SavedSearchRecord,
  type SavedSearchRepository,
  type SearchEvent,
  type SearchEventPublisher,
  type SearchIndexWriter,
  type SearchKillSwitchPort,
  type SearchPage,
  type SearchPort,
  type SearchRequest,
  type ShopperScopePort,
  type StoreSummaryFacts,
  type SuggestionDirectoryPort,
  type LocalizedText,
} from "../domain/ports";
import { bucketize, compareDocs, docMatches } from "./matching";

export class InMemorySearchIndex implements SearchPort, SearchIndexWriter {
  readonly engine = "in_memory" as const;
  private readonly docs = new Map<string, IndexedProduct>();

  async upsert(doc: IndexedProduct): Promise<void> {
    this.docs.set(doc.productId, { ...doc, searchText: normalizeSearchText(doc.searchText) });
  }

  async remove(productId: string): Promise<void> {
    this.docs.delete(productId);
  }

  async search(req: SearchRequest): Promise<SearchPage> {
    const all = [...this.docs.values()]
      .filter((d) => docMatches(d, req))
      .sort((a, b) => compareDocs(req.sort ?? "relevance", a, b));
    return {
      hits: all.slice(req.offset, req.offset + req.limit).map((d) => ({ productId: d.productId, sponsored: d.sponsored })),
      total: all.length,
      degraded: false,
    };
  }

  async facetCounts(req: SearchRequest, facet: FacetCountFacet, cap: number): Promise<readonly FacetBucket[]> {
    return bucketize([...this.docs.values()].filter((d) => docMatches(d, req)), facet, cap);
  }

  async suggest(prefixNormalized: string, limit: number): Promise<readonly string[]> {
    const out: string[] = [];
    for (const d of this.docs.values()) {
      if (d.searchText.includes(prefixNormalized)) out.push(d.titleAr);
      if (out.length >= limit) break;
    }
    return out;
  }
}

export class FakeProductFacts implements ProductFactsPort {
  private readonly map = new Map<string, ProductFacts>();
  failing = false;
  calls = 0;

  set(f: ProductFacts): void {
    this.map.set(f.productId, f);
  }

  async products(ids: readonly string[]): Promise<ReadonlyMap<string, ProductFacts>> {
    this.calls += 1;
    if (this.failing) throw new ProductFactsUnavailableError();
    const out = new Map<string, ProductFacts>();
    for (const id of ids) {
      const f = this.map.get(id);
      if (f !== undefined) out.set(id, f);
    }
    return out;
  }
}

export class StaticShopperScope implements ShopperScopePort {
  private readonly byUser = new Map<string, readonly string[]>();
  set(userId: string, storeIds: readonly string[]): void {
    this.byUser.set(userId, storeIds);
  }
  async favoriteStoreIds(userId: string): Promise<readonly string[]> {
    return this.byUser.get(userId) ?? [];
  }
}

export class InMemorySuggestionDirectory implements SuggestionDirectoryPort {
  readonly storeList: StoreSummaryFacts[] = [];
  readonly categoryList: { id: string; name: LocalizedText }[] = [];
  async stores(prefix: string, limit: number): Promise<readonly StoreSummaryFacts[]> {
    return this.storeList
      .filter((s) => normalizeSearchText(s.name.ar).startsWith(prefix) || normalizeSearchText(s.name.en ?? "").startsWith(prefix))
      .slice(0, limit);
  }
  async categories(prefix: string, limit: number) {
    return this.categoryList
      .filter((c) => normalizeSearchText(c.name.ar).startsWith(prefix) || normalizeSearchText(c.name.en ?? "").startsWith(prefix))
      .slice(0, limit);
  }
}

export class StaticKillSwitch implements SearchKillSwitchPort {
  constructor(public disabled = false) {}
  async typesenseDisabled(): Promise<boolean> {
    return this.disabled;
  }
}

export class InMemorySearchEventPublisher implements SearchEventPublisher {
  readonly events: SearchEvent[] = [];
  async publish(event: SearchEvent): Promise<void> {
    this.events.push(event);
  }
}

/** Fake LLM: returns a scripted raw object, or null, or fails. Never makes a network call. */
export class FakeLlmGateway implements LlmGatewayPort {
  response: unknown | null = null;
  failing = false;
  calls: { text: string; locale: "ar" | "en" }[] = [];
  async refineSearchParse(input: { text: string; locale: "ar" | "en" }): Promise<unknown | null> {
    this.calls.push(input);
    if (this.failing) throw new LlmUnavailableError();
    return this.response;
  }
}

export class InMemorySavedSearchRepository implements SavedSearchRepository {
  private readonly rows = new Map<string, SavedSearchRecord>();

  async list(userId: string, limit: number, after: SavedSearchCursor | null): Promise<readonly SavedSearchRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1))
      .filter(
        (r) => after === null || r.createdAtMs < after.createdAtMs || (r.createdAtMs === after.createdAtMs && r.id < after.id),
      )
      .slice(0, limit);
  }

  async get(userId: string, id: string): Promise<SavedSearchRecord | null> {
    const r = this.rows.get(id);
    return r !== undefined && r.userId === userId ? r : null;
  }

  async count(userId: string): Promise<number> {
    return [...this.rows.values()].filter((r) => r.userId === userId).length;
  }

  async create(record: SavedSearchRecord): Promise<void> {
    this.rows.set(record.id, record);
  }

  async update(userId: string, id: string, patch: SavedSearchPatch, nowMs: number): Promise<SavedSearchRecord | null> {
    const r = await this.get(userId, id);
    if (r === null) return null;
    const next: SavedSearchRecord = {
      ...r,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.alertEnabled !== undefined ? { alertEnabled: patch.alertEnabled } : {}),
      ...(patch.filter !== undefined ? { filter: patch.filter } : {}),
      updatedAtMs: nowMs,
    };
    this.rows.set(id, next);
    return next;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const r = await this.get(userId, id);
    if (r === null) return false;
    this.rows.delete(id);
    return true;
  }
}
