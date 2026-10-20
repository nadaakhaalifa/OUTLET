import { cosine, seededRng, baselineScore, personalScore, type Candidate, type ExplorationStats, type Neighbor, type Rng, type UserFeatures } from "../domain/bridge";
import type {
  AffordabilityFilterPort,
  CatalogPort,
  CooccurrenceKind,
  CooccurrenceRow,
  FlagPort,
  HistoryPurchase,
  HistoryView,
  PersonalizationReadPort,
  RankerPort,
  RecModule,
  RecOutboxEvent,
  RecoStore,
  RngPort,
  UserSizePort,
  VectorIndexPort,
} from "../domain/ports";

export class InMemoryRecoStore implements RecoStore {
  readonly events: RecOutboxEvent[] = [];
  private readonly co: CooccurrenceRow[] = [];
  private readonly stats = new Map<string, { impressions: number; clicks: number }>();
  private model: string | null = "ltr-v1";

  setActiveModel(v: string | null): void {
    this.model = v;
  }

  async neighbors(productId: string, kind: CooccurrenceKind, limit: number): Promise<readonly Neighbor[]> {
    return this.co
      .filter((r) => r.itemA === productId && r.kind === kind)
      .sort((a, b) => b.score - a.score || (a.itemB < b.itemB ? -1 : 1))
      .slice(0, limit)
      .map((r) => ({ productId: r.itemB, score: r.score }));
  }

  async upsertCooccurrence(rows: readonly CooccurrenceRow[], _nowMs: number): Promise<number> {
    let n = 0;
    for (const r of rows) {
      if (r.itemA === r.itemB || r.score <= 0) continue;
      const i = this.co.findIndex((x) => x.itemA === r.itemA && x.itemB === r.itemB && x.kind === r.kind);
      if (i >= 0) this.co[i] = r;
      else this.co.push(r);
      n++;
    }
    return n;
  }

  async activeModelVersion(): Promise<string | null> {
    return this.model;
  }

  async explorationStats(productIds: readonly string[]): Promise<ReadonlyMap<string, ExplorationStats>> {
    const out = new Map<string, ExplorationStats>();
    for (const id of productIds) {
      const s = this.stats.get(`${id}|exploration`);
      if (s !== undefined) out.set(id, { ...s });
    }
    return out;
  }

  private bump(module: RecModule, id: string, field: "impressions" | "clicks"): void {
    const key = `${id}|${module}`;
    const cur = this.stats.get(key) ?? { impressions: 0, clicks: 0 };
    cur[field]++;
    this.stats.set(key, cur);
  }

  async recordImpressions(module: RecModule, productIds: readonly string[], event: RecOutboxEvent): Promise<void> {
    for (const id of productIds) this.bump(module, id, "impressions");
    this.events.push(event);
  }

  async recordClick(module: RecModule, productId: string, event: RecOutboxEvent): Promise<void> {
    const key = `${productId}|${module}`;
    const cur = this.stats.get(key) ?? { impressions: 0, clicks: 0 };
    // clicks never exceed impressions (CHECK in SQL): a click implies the item was shown
    this.stats.set(key, { impressions: Math.max(cur.impressions, cur.clicks + 1), clicks: cur.clicks + 1 });
    this.events.push(event);
  }

  statsFor(productId: string, module: RecModule): { impressions: number; clicks: number } {
    return this.stats.get(`${productId}|${module}`) ?? { impressions: 0, clicks: 0 };
  }
}

export class FakeCatalog implements CatalogPort {
  private readonly items = new Map<string, Candidate>();
  private readonly basics = new Map<string, number>();
  add(c: Candidate): void {
    this.items.set(c.productId, c);
  }
  setBasic(productId: string, days: number): void {
    this.basics.set(productId, days);
  }
  async product(id: string): Promise<Candidate | null> {
    return this.items.get(id) ?? null;
  }
  async byIds(ids: readonly string[]): Promise<readonly Candidate[]> {
    return ids.flatMap((i) => {
      const c = this.items.get(i);
      return c === undefined ? [] : [c];
    });
  }
  async popular(opts: { limit: number; categoryIds?: readonly string[] }): Promise<readonly Candidate[]> {
    return [...this.items.values()]
      .filter((c) => opts.categoryIds === undefined || opts.categoryIds.includes(c.categoryId))
      .sort((a, b) => b.popularity - a.popularity || (a.productId < b.productId ? -1 : 1))
      .slice(0, opts.limit);
  }
  async newSellerPool(limit: number): Promise<readonly Candidate[]> {
    return [...this.items.values()].filter((c) => c.isNewSeller).slice(0, limit);
  }
  async basicsIntervalDays(ids: readonly string[]): Promise<ReadonlyMap<string, number>> {
    return new Map(ids.flatMap((i) => (this.basics.has(i) ? [[i, this.basics.get(i) as number] as const] : [])));
  }
}

/** Exact cosine nearest neighbors over a map of embeddings: the in-memory VectorIndexPort. */
export class InMemoryVectorIndex implements VectorIndexPort {
  private readonly vectors = new Map<string, readonly number[]>();
  down = false;
  set(productId: string, v: readonly number[]): void {
    this.vectors.set(productId, v);
  }
  async nearest(productId: string, k: number): Promise<readonly Neighbor[]> {
    if (this.down) throw new Error("vector index unavailable");
    const a = this.vectors.get(productId);
    if (a === undefined) return [];
    return [...this.vectors.entries()]
      .filter(([id]) => id !== productId)
      .map(([id, v]) => ({ productId: id, score: cosine(a, v) }))
      .sort((x, y) => y.score - x.score || (x.productId < y.productId ? -1 : 1))
      .slice(0, k);
  }
}

/** Spy ranker: records exactly what it was given, ranks with the rule model. */
export class SpyRanker implements RankerPort {
  readonly calls: { features: UserFeatures | null; personalized: boolean; count: number }[] = [];
  down = false;
  async rank(input: Parameters<RankerPort["rank"]>[0]) {
    if (this.down) throw new Error("ranker unavailable");
    this.calls.push({ features: input.features, personalized: input.personalized, count: input.candidates.length });
    const scores = new Map<string, number>();
    for (const c of input.candidates) {
      scores.set(
        c.productId,
        input.personalized ? personalScore(c, input.features, input.nowMs) : baselineScore(c, input.nowMs),
      );
    }
    return { modelVersion: input.personalized ? "ltr-v1" : "popularity-v1", scores };
  }
}

/** Spy feature store plus the other history reads, in memory. */
export class FakePersonalization implements PersonalizationReadPort {
  readonly featureReads: string[] = [];
  private readonly settingsBy = new Map<string, { personalization: boolean; historyPaused: boolean }>();
  private readonly consent = new Set<string>();
  private readonly featuresBy = new Map<string, UserFeatures>();
  private readonly views = new Map<string, HistoryView[]>();
  private readonly buys = new Map<string, HistoryPurchase[]>();

  setSettings(u: string, s: { personalization: boolean; historyPaused: boolean }): void {
    this.settingsBy.set(u, s);
  }
  grantConsent(u: string): void {
    this.consent.add(u);
  }
  setFeatures(u: string, f: UserFeatures): void {
    this.featuresBy.set(u, f);
  }
  addView(u: string, v: HistoryView): void {
    this.views.set(u, [...(this.views.get(u) ?? []), v]);
  }
  addPurchase(u: string, p: HistoryPurchase): void {
    this.buys.set(u, [...(this.buys.get(u) ?? []), p]);
  }
  async settings(u: string) {
    return this.settingsBy.get(u) ?? { personalization: true, historyPaused: false };
  }
  async consentGranted(u: string) {
    return this.consent.has(u);
  }
  async features(u: string) {
    this.featureReads.push(u);
    return this.featuresBy.get(u) ?? null;
  }
  async recentViews(u: string, limit: number) {
    return [...(this.views.get(u) ?? [])].sort((a, b) => b.viewedAtMs - a.viewedAtMs).slice(0, limit);
  }
  async purchases(u: string, limit: number) {
    return [...(this.buys.get(u) ?? [])].sort((a, b) => b.boughtAtMs - a.boughtAtMs).slice(0, limit);
  }
}

export class FakeUserSizes implements UserSizePort {
  private readonly by = new Map<string, readonly string[]>();
  set(u: string, labels: readonly string[]): void {
    this.by.set(u, labels);
  }
  async sizeLabels(u: string) {
    return this.by.get(u) ?? null;
  }
}

export class FakeFlags implements FlagPort {
  constructor(public mlRanking = true) {}
  async mlRankingAllowed(): Promise<boolean> {
    return this.mlRanking;
  }
}

export class SeededRngPort implements RngPort {
  constructor(private readonly seed = 42) {}
  create(): Rng {
    return seededRng(this.seed);
  }
}

/** Test double for the spec 03 filter: keeps items at or under a ceiling and remembers calls. */
export class FakeAffordability implements AffordabilityFilterPort {
  readonly calls: string[] = [];
  constructor(private readonly ceilingMinor: bigint) {}
  async filter(userId: string, items: readonly Candidate[]) {
    this.calls.push(userId);
    return items.filter((c) => c.priceMinor <= this.ceilingMinor);
  }
}
