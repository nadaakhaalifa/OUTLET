import {
  diversify,
  isSimilarForLess,
  isVisible,
  maxExplorationSlots,
  mergeExploration,
  personalizationDecision,
  pickExploration,
  priceDrops,
  restockDue,
  baselineScore,
  sortByScore,
  type Candidate,
  type UserFeatures,
  type PersonalizationReason,
  type PriceDrop,
  type ScoredCandidate,
} from "../domain/bridge";
import type {
  AffordabilityFilterPort,
  CatalogPort,
  Clock,
  FlagPort,
  PersonalizationReadPort,
  RankerPort,
  RecModule,
  RecoStore,
  RngPort,
  UserSizePort,
  VectorIndexPort,
} from "../domain/ports";

/** Structural slice of ranking's ShadowObserverPort (shadow deployment of the v2 ranker). */
export interface ShadowObserverLike {
  observe(o: {
    readonly module: "feed";
    readonly servedModelVersion: string;
    readonly servedOrder: readonly string[];
    readonly candidates: readonly Candidate[];
    readonly user: UserFeatures | null;
    readonly personalized: boolean;
    readonly sizeLabels: readonly string[] | null;
    readonly nowMs: number;
  }): Promise<void>;
}

export interface RecoDeps {
  readonly store: RecoStore;
  readonly catalog: CatalogPort;
  readonly vectors: VectorIndexPort;
  readonly ranker: RankerPort;
  readonly personalization: PersonalizationReadPort;
  readonly sizes: UserSizePort;
  readonly flags: FlagPort;
  readonly rng: RngPort;
  readonly clock: Clock;
  readonly affordability: AffordabilityFilterPort | null;
  /** Optional v2 shadow observer: scores and logs only, never changes what is served. */
  readonly shadow?: ShadowObserverLike | null;
}

export const FEED_POOL = 200;
const SEEDS = 3;
const NEIGHBORS_PER_SEED = 20;
const OVERSAMPLE = 4;
const TOP_CATEGORIES = 3;
const HISTORY_READ = 50;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export type ItemReason = "popular" | "for_you" | "new_seller" | "similar" | "similar_for_less" | "goes_with" | "restock" | "price_drop";

export interface RecItem {
  readonly candidate: Candidate;
  readonly reason: ItemReason;
  readonly priceDrop?: PriceDrop;
}

const clampLimit = (n: number): number => Math.min(Math.max(1, Math.trunc(n)), MAX_LIMIT);
const dedupe = (xs: readonly Candidate[]): Candidate[] => {
  const seen = new Set<string>();
  return xs.filter((c) => (seen.has(c.productId) ? false : (seen.add(c.productId), true)));
};

export interface FeedResult {
  readonly items: readonly RecItem[];
  readonly personalized: boolean;
  readonly reason: PersonalizationReason;
  readonly modelVersion: string;
  readonly degraded: readonly ("ranker_down" | "ann_down")[];
  readonly affordabilityApplied: boolean;
}

export class BuildFeed {
  constructor(private readonly d: RecoDeps) {}

  /**
   * Personalization is decided before any user data is touched. Short circuits (requested off,
   * setting off, no consent, kill switch) never read the feature store, the history or the sizes.
   */
  async execute(i: {
    userId: string;
    personalizedParam: boolean | undefined;
    affordable: boolean;
    limit: number;
    /** Public guest feed (ADR-0055): serve the popular pool only and write nothing (no impression counters, no shadow log). */
    anonymous?: boolean;
  }): Promise<FeedResult> {
    const now = this.d.clock.nowMs();
    const limit = clampLimit(i.limit);
    const mlAllowed = await this.d.flags.mlRankingAllowed();
    const decide = (features: Awaited<ReturnType<PersonalizationReadPort["features"]>>, settingOn: boolean, consent: boolean) =>
      personalizationDecision({
        requested: i.personalizedParam,
        settingOn,
        consentGranted: consent,
        mlRankingAllowed: mlAllowed,
        features,
        nowMs: now,
      });

    let decision = decide(null, true, true);
    let features = null;
    if (decision.reason === "no_features") {
      // requested/kill checks passed: now (and only now) look at the shopper's own settings.
      const s = await this.d.personalization.settings(i.userId);
      const consent = s.personalization ? await this.d.personalization.consentGranted(i.userId) : false;
      decision = decide(null, s.personalization, consent);
      if (decision.reason === "no_features") {
        features = await this.d.personalization.features(i.userId);
        decision = decide(features, true, true);
      }
    }
    const personalized = decision.personalized;
    const userFeatures = personalized ? features : null;
    const degraded: ("ranker_down" | "ann_down")[] = [];

    let pool: Candidate[];
    const reasonOf = new Map<string, ItemReason>();
    let sizes: readonly string[] | null = null;
    let exclude = new Set<string>();

    if (personalized && userFeatures !== null) {
      const cats = Object.entries(userFeatures.categoryAffinity)
        .sort(([, a], [, b]) => b - a)
        .slice(0, TOP_CATEGORIES)
        .map(([k]) => k);
      const [views, buys] = await Promise.all([
        this.d.personalization.recentViews(i.userId, HISTORY_READ),
        this.d.personalization.purchases(i.userId, HISTORY_READ),
      ]);
      exclude = new Set(buys.map((b) => b.productId));
      const seeds = [...new Set([...buys.map((b) => b.productId), ...views.map((v) => v.productId)])].slice(0, SEEDS);
      const neighborIds = new Set<string>();
      for (const seed of seeds) {
        try {
          for (const n of await this.d.vectors.nearest(seed, NEIGHBORS_PER_SEED)) neighborIds.add(n.productId);
        } catch {
          if (!degraded.includes("ann_down")) degraded.push("ann_down");
        }
        for (const n of await this.d.store.neighbors(seed, "co_buy", NEIGHBORS_PER_SEED)) neighborIds.add(n.productId);
      }
      const [neighbors, byCat, general] = await Promise.all([
        this.d.catalog.byIds([...neighborIds]),
        cats.length > 0 ? this.d.catalog.popular({ limit: FEED_POOL, categoryIds: cats }) : Promise.resolve([]),
        this.d.catalog.popular({ limit: FEED_POOL }),
      ]);
      for (const c of [...neighbors, ...byCat]) reasonOf.set(c.productId, "for_you");
      pool = dedupe([...neighbors, ...byCat, ...general]);
      sizes = await this.d.sizes.sizeLabels(i.userId);
    } else {
      pool = dedupe(await this.d.catalog.popular({ limit: FEED_POOL }));
    }

    let visible = pool.filter((c) => !exclude.has(c.productId) && isVisible(c, sizes));

    let affordabilityApplied = false;
    if (i.affordable && this.d.affordability !== null) {
      visible = [...(await this.d.affordability.filter(i.userId, visible))];
      affordabilityApplied = true;
    }

    const rankNow = this.d.clock.nowMs();
    let modelVersion: string;
    let scored: ScoredCandidate[];
    try {
      const r = await this.d.ranker.rank({ candidates: visible, features: userFeatures, personalized, nowMs: rankNow });
      modelVersion = r.modelVersion;
      scored = visible.map((c) => ({ candidate: c, score: r.scores.get(c.productId) ?? baselineScore(c, rankNow), exploration: false }));
    } catch {
      degraded.push("ranker_down");
      modelVersion = "popularity-fallback";
      scored = visible.map((c) => ({ candidate: c, score: baselineScore(c, rankNow), exploration: false }));
    }

    let ranked = diversify(sortByScore(scored));

    let explored: Candidate[] = [];
    if (mlAllowed) {
      const slots = maxExplorationSlots(limit);
      if (slots > 0) {
        const inList = new Set(ranked.map((r) => r.candidate.productId));
        const poolNew = (await this.d.catalog.newSellerPool(100)).filter(
          (c) => !inList.has(c.productId) && !exclude.has(c.productId) && isVisible(c, sizes),
        );
        const stats = await this.d.store.explorationStats(poolNew.map((c) => c.productId));
        explored = pickExploration(poolNew, stats, limit, this.d.rng.create());
      }
    }
    ranked = ranked.slice(0, Math.max(0, limit - explored.length));
    const merged = mergeExploration(ranked, explored).slice(0, limit);

    const items: RecItem[] = merged.map((m) => ({
      candidate: m.candidate,
      reason: m.exploration ? "new_seller" : (reasonOf.get(m.candidate.productId) ?? "popular"),
    }));

    const shown = items.map((x) => x.candidate.productId);
    if (shown.length > 0 && i.anonymous !== true) {
      await this.d.store.recordImpressions(
        "feed",
        shown,
        { type: "recommendation.impression", module: "feed", modelVersion, productIds: shown, personalized },
        now,
      );
      const ex = items.filter((x) => x.reason === "new_seller").map((x) => x.candidate.productId);
      if (ex.length > 0) {
        await this.d.store.recordImpressions(
          "exploration",
          ex,
          { type: "recommendation.impression", module: "exploration", modelVersion, productIds: ex, personalized },
          now,
        );
      }
    }
    // Shadow v2: fire and forget, after v1 has been decided. Skipped for affordability-filtered
    // requests so the budget-conditioned candidate set is never logged (spec 12 Privacy).
    if (this.d.shadow !== undefined && this.d.shadow !== null && !affordabilityApplied && shown.length > 0 && i.anonymous !== true) {
      void this.d.shadow
        .observe({
          module: "feed",
          servedModelVersion: modelVersion,
          servedOrder: shown,
          candidates: visible,
          user: personalized ? userFeatures : null,
          personalized,
          sizeLabels: personalized ? sizes : null,
          nowMs: rankNow,
        })
        .catch(() => undefined);
    }
    return { items, personalized, reason: decision.reason, modelVersion, degraded, affordabilityApplied };
  }
}

export type SimilarMode = "similar" | "for_less" | "goes_with";

export type SimilarResult =
  | { readonly kind: "ok"; readonly items: readonly RecItem[]; readonly degraded: boolean; readonly modelVersion: string }
  | { readonly kind: "not_found" };

/** Public, not personalized: the same answer for every shopper (no user data is read). */
export class SimilarProducts {
  constructor(private readonly d: RecoDeps) {}

  async execute(i: { productId: string; mode: SimilarMode; limit: number }): Promise<SimilarResult> {
    const limit = clampLimit(i.limit);
    const anchor = await this.d.catalog.product(i.productId);
    if (anchor === null || !anchor.storeActive) return { kind: "not_found" };
    const model = (await this.d.store.activeModelVersion()) ?? "rules-v1";
    let degraded = false;
    let found: Candidate[];

    if (i.mode === "goes_with") {
      const buys = await this.d.store.neighbors(anchor.productId, "co_buy", limit * OVERSAMPLE);
      const views = buys.length >= limit ? [] : await this.d.store.neighbors(anchor.productId, "co_view", limit * OVERSAMPLE);
      const ids = [...new Set([...buys, ...views].map((n) => n.productId))];
      found = (await this.d.catalog.byIds(ids)).filter((c) => c.categoryId !== anchor.categoryId);
    } else {
      try {
        const nn = await this.d.vectors.nearest(anchor.productId, limit * OVERSAMPLE);
        const order = new Map(nn.map((n, idx) => [n.productId, idx] as const));
        found = [...(await this.d.catalog.byIds(nn.map((n) => n.productId)))].sort(
          (a, b) => (order.get(a.productId) ?? 0) - (order.get(b.productId) ?? 0),
        );
      } catch {
        degraded = true;
        found = [...(await this.d.catalog.popular({ limit: limit * OVERSAMPLE, categoryIds: [anchor.categoryId] }))];
      }
    }

    let out = dedupe(found).filter((c) => c.productId !== anchor.productId && isVisible(c, null));
    if (i.mode === "for_less") out = out.filter((c) => isSimilarForLess(anchor.priceMinor, c));
    out = out.slice(0, limit);

    const module: RecModule = i.mode === "for_less" ? "similar_for_less" : i.mode === "goes_with" ? "goes_with" : "similar";
    const ids = out.map((c) => c.productId);
    if (ids.length > 0) {
      await this.d.store.recordImpressions(
        module,
        ids,
        { type: "recommendation.impression", module, modelVersion: model, productIds: ids, personalized: false },
        this.d.clock.nowMs(),
      );
    }
    const reason: ItemReason = i.mode === "for_less" ? "similar_for_less" : i.mode === "goes_with" ? "goes_with" : "similar";
    return { kind: "ok", items: out.map((candidate) => ({ candidate, reason })), degraded, modelVersion: model };
  }
}

export interface PersonalModuleResult {
  readonly items: readonly RecItem[];
  readonly personalized: boolean;
}

/** Own purchase history only; empty (not an error) when personalization is off or not consented. */
export class RestockReminders {
  constructor(private readonly d: RecoDeps) {}
  async execute(userId: string, limit: number): Promise<PersonalModuleResult> {
    const s = await this.d.personalization.settings(userId);
    if (!s.personalization || !(await this.d.personalization.consentGranted(userId))) return { items: [], personalized: false };
    const buys = await this.d.personalization.purchases(userId, 200);
    const intervals = await this.d.catalog.basicsIntervalDays([...new Set(buys.map((b) => b.productId))]);
    const due = restockDue(buys, intervals, this.d.clock.nowMs());
    const cands = (await this.d.catalog.byIds(due)).filter((c) => isVisible(c, null)).slice(0, clampLimit(limit));
    return { items: cands.map((candidate) => ({ candidate, reason: "restock" as const })), personalized: true };
  }
}

/** Items the shopper viewed that are cheaper now than when seen. A fact, never a "% off" claim. */
export class PriceDroppedOnViewed {
  constructor(private readonly d: RecoDeps) {}
  async execute(userId: string, limit: number): Promise<PersonalModuleResult> {
    const s = await this.d.personalization.settings(userId);
    if (!s.personalization || !(await this.d.personalization.consentGranted(userId))) return { items: [], personalized: false };
    const views = await this.d.personalization.recentViews(userId, HISTORY_READ);
    const cands = await this.d.catalog.byIds(views.map((v) => v.productId));
    const current = new Map(cands.filter((c) => isVisible(c, null)).map((c) => [c.productId, c.priceMinor] as const));
    const drops = priceDrops(views.map((v) => ({ productId: v.productId, priceMinor: v.priceMinor })), current);
    const byId = new Map(cands.map((c) => [c.productId, c] as const));
    const items: RecItem[] = [];
    for (const dr of drops.slice(0, clampLimit(limit))) {
      const c = byId.get(dr.productId);
      if (c !== undefined) items.push({ candidate: c, reason: "price_drop", priceDrop: dr });
    }
    return { items, personalized: true };
  }
}

export class RecordRecommendationClick {
  constructor(private readonly d: Pick<RecoDeps, "store" | "catalog" | "clock">) {}
  /** Unknown products are ignored so a client cannot grow the stats table with random ids. */
  async execute(i: { module: RecModule; productId: string; modelVersion: string }): Promise<void> {
    if ((await this.d.catalog.product(i.productId)) === null) return;
    await this.d.store.recordClick(
      i.module,
      i.productId,
      { type: "recommendation.click", module: i.module, modelVersion: i.modelVersion, productId: i.productId },
      this.d.clock.nowMs(),
    );
  }
}

/** Batch job: recompute co-view / co-buy rows from supplied basket sets (pairs counted per window). */
export class BuildCooccurrence {
  constructor(private readonly d: Pick<RecoDeps, "store" | "clock">) {}

  async execute(baskets: readonly (readonly string[])[], kind: "co_view" | "co_buy", windowDays: number): Promise<number> {
    const counts = new Map<string, number>();
    for (const b of baskets) {
      const items = [...new Set(b)].sort();
      for (let x = 0; x < items.length; x++) {
        for (let y = x + 1; y < items.length; y++) {
          const k = `${items[x]}|${items[y]}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
    }
    const rows = [...counts.entries()].flatMap(([k, score]) => {
      const [a, b] = k.split("|");
      if (a === undefined || b === undefined) return [];
      return [
        { itemA: a, itemB: b, kind, score, windowDays },
        { itemA: b, itemB: a, kind, score, windowDays },
      ];
    });
    return this.d.store.upsertCooccurrence(rows, this.d.clock.nowMs());
  }
}
