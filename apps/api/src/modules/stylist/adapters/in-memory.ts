import type { Season } from "../domain/bridge";
import {
  CatalogUnavailableError,
  type BagPort,
  type BudgetPort,
  type CandidateQuery,
  type CandidateSourcePort,
  type EmbeddingPort,
  type FeedbackRecord,
  type LivePrice,
  type LivePricePort,
  type OutfitRecord,
  type PersonalizationPort,
  type StylistCandidate,
  type StylistEvent,
  type StylistFlagPort,
  type StylistLlmPort,
  type StylistStore,
} from "../domain/ports";

export class InMemoryStylistStore implements StylistStore {
  readonly events: StylistEvent[] = [];
  private readonly outfits = new Map<string, OutfitRecord>();
  private readonly feedback = new Map<string, FeedbackRecord>();
  private readonly vectors = new Map<string, readonly number[]>();

  async insertOutfits(records: readonly OutfitRecord[], events: readonly StylistEvent[]): Promise<void> {
    for (const r of records) {
      if (this.outfits.has(r.id)) throw new Error("duplicate outfit");
    }
    for (const r of records) this.outfits.set(r.id, r);
    this.events.push(...events);
  }
  async getOutfit(id: string): Promise<OutfitRecord | null> {
    return this.outfits.get(id) ?? null;
  }
  async countSince(userId: string, sinceMs: number): Promise<number> {
    const g = new Set<string>();
    for (const o of this.outfits.values()) if (o.userId === userId && o.createdAtMs >= sinceMs) g.add(o.generationId);
    return g.size;
  }
  async markAddedToBag(outfitId: string, userId: string, atMs: number, events: readonly StylistEvent[]): Promise<"marked" | "already"> {
    const o = this.outfits.get(outfitId);
    if (o === undefined || o.userId !== userId) throw new Error("outfit not found");
    if (o.addedToBagAtMs !== null) return "already";
    this.outfits.set(outfitId, { ...o, addedToBagAtMs: atMs });
    this.events.push(...events);
    return "marked";
  }
  async upsertFeedback(f: FeedbackRecord, events: readonly StylistEvent[]): Promise<void> {
    this.feedback.set(`${f.outfitId}|${f.itemId}`, f);
    this.events.push(...events);
  }
  async getFeedback(outfitId: string): Promise<readonly FeedbackRecord[]> {
    return [...this.feedback.values()].filter((f) => f.outfitId === outfitId).sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
  }
  async getStyleVector(userId: string): Promise<readonly number[] | null> {
    return this.vectors.get(userId) ?? null;
  }
  async putStyleVector(userId: string, vec: readonly number[]): Promise<void> {
    this.vectors.set(userId, [...vec]);
  }
  async eraseForUser(userId: string): Promise<void> {
    for (const [k, o] of this.outfits) if (o.userId === userId) this.outfits.delete(k);
    for (const [k, f] of this.feedback) if (f.userId === userId) this.feedback.delete(k);
    this.vectors.delete(userId);
  }
}

export class FakeCandidateSource implements CandidateSourcePort {
  items: StylistCandidate[] = [];
  down = false;
  readonly queries: CandidateQuery[] = [];
  /** Item ids on the shopper's wishlist, for wishlistOnly queries. */
  wishlist = new Set<string>();
  async candidates(q: CandidateQuery): Promise<readonly StylistCandidate[]> {
    this.queries.push(q);
    if (this.down) throw new CatalogUnavailableError();
    let out = this.items;
    if (q.wishlistOnly) out = out.filter((c) => this.wishlist.has(c.itemId));
    if (q.scope.world === "my_stores" && q.scope.storeIds.length > 0) out = out.filter((c) => q.scope.storeIds.includes(c.storeId));
    return out;
  }
}

export class FakeEmbeddings implements EmbeddingPort {
  down = false;
  readonly calls: (readonly string[])[] = [];
  vectors = new Map<string, readonly number[]>();
  async embeddings(ids: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
    this.calls.push(ids);
    if (this.down) throw new Error("ml down");
    const m = new Map<string, readonly number[]>();
    for (const id of ids) {
      const v = this.vectors.get(id);
      if (v !== undefined) m.set(id, v);
    }
    return m;
  }
}

export class FakeBudget implements BudgetPort {
  remaining = new Map<string, bigint>();
  async remainingBudgetPiastres(userId: string): Promise<bigint | null> {
    return this.remaining.get(userId) ?? null;
  }
}

export class FakePersonalization implements PersonalizationPort {
  off = new Set<string>();
  reads = 0;
  async enabled(userId: string): Promise<boolean> {
    this.reads++;
    return !this.off.has(userId);
  }
}

export class FakeLivePrices implements LivePricePort {
  prices = new Map<string, LivePrice>();
  async current(itemIds: readonly string[]): Promise<ReadonlyMap<string, LivePrice>> {
    const m = new Map<string, LivePrice>();
    for (const id of itemIds) {
      const p = this.prices.get(id);
      if (p !== undefined) m.set(id, p);
    }
    return m;
  }
}

export class FakeBag implements BagPort {
  readonly adds: { userId: string; itemIds: readonly string[]; key: string }[] = [];
  async addLines(userId: string, itemIds: readonly string[], key: string): Promise<void> {
    this.adds.push({ userId, itemIds, key });
  }
}

export class StaticStylistFlags implements StylistFlagPort {
  constructor(public on: Set<string> = new Set()) {}
  async isEnabled(key: string): Promise<boolean> {
    return this.on.has(key);
  }
}

/** Scriptable LLM port. Default: returns null (LLM unavailable) so rules paths are exercised. */
export class FakeStylistLlm implements StylistLlmPort {
  intent: { occasion: string; formality: number; season: Season; modest: boolean } | null = null;
  ranking: readonly string[] | null = null;
  readonly rerankCalls: { id: string; title: string }[][] = [];
  async parseIntent(): Promise<{ occasion: string; formality: number; season: Season; modest: boolean } | null> {
    return this.intent;
  }
  async rerank(input: { items: readonly { id: string; title: string }[] }): Promise<readonly string[] | null> {
    this.rerankCalls.push([...input.items]);
    return this.ranking;
  }
}
