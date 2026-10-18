import type { Candidate, Rng, ScoredCandidate } from "../recommendations/types";
import type { UserFeatures } from "../recommendations/features";
import {
  EXPLORATION_CAP_PERCENT,
  MAX_CONSECUTIVE_PER_STORE,
  diversify,
  maxExplorationSlots,
  mergeExploration,
  pickExploration,
  sortByScore,
  type ExplorationStats,
} from "../recommendations/ranking";
import { buildFeatureVector, type RankingFeatureVector } from "./features";
import type { RankerModel } from "./model";

/** Requests scoring at or above this bot score (permille) get no exploration and no training use. */
export const BOT_SCORE_THRESHOLD_PERMILLE = 700;

export interface RankV2Input {
  readonly candidates: readonly Candidate[];
  /** Ignored (never read) when `personalized` is false. */
  readonly user: UserFeatures | null;
  readonly personalized: boolean;
  readonly sizeLabels?: readonly string[] | null;
  readonly nowMs: number;
  readonly limit: number;
  readonly model: RankerModel;
  readonly newSellerPool: readonly Candidate[];
  readonly explorationStats: ReadonlyMap<string, ExplorationStats>;
  readonly rng: Rng;
  /** Bot score of the request, 0..1000. Absent means unscored (treated as human). */
  readonly botScorePermille?: number;
  readonly maxConsecutivePerStore?: number;
  readonly explorationCapPercent?: number;
}

export interface RankV2Result {
  readonly items: readonly ScoredCandidate[];
  readonly modelVersion: string;
  /** Model score by product id for every scored (non-exploration) candidate. */
  readonly scores: ReadonlyMap<string, number>;
  readonly vectors: readonly RankingFeatureVector[];
  readonly explorationCount: number;
  readonly botFiltered: boolean;
  /** true when this request may be used as training/evaluation data. */
  readonly trainable: boolean;
}

export function isBotRequest(botScorePermille: number | undefined): boolean {
  return botScorePermille !== undefined && botScorePermille >= BOT_SCORE_THRESHOLD_PERMILLE;
}

/**
 * score -> sort -> diversity re-rank (<= 2 consecutive per store) -> Thompson exploration
 * (<= 5% of the list, seeded RNG) -> truncate. Pure given the injected model and RNG.
 */
export function rankV2(i: RankV2Input): RankV2Result {
  const bot = isBotRequest(i.botScorePermille);
  const vectors = i.candidates.map((c) => buildFeatureVector(c, i.user, i.personalized, i.nowMs, i.sizeLabels ?? null));
  const raw = i.model.score(vectors);
  const scores = new Map<string, number>();
  const scored: ScoredCandidate[] = i.candidates.map((c, idx) => {
    const s = raw[idx];
    const score = s !== undefined && Number.isFinite(s) ? s : 0;
    scores.set(c.productId, score);
    return { candidate: c, score, exploration: false };
  });
  let ranked = diversify(sortByScore(scored), i.maxConsecutivePerStore ?? MAX_CONSECUTIVE_PER_STORE);
  const cap = i.explorationCapPercent ?? EXPLORATION_CAP_PERCENT;
  let explored: Candidate[] = [];
  if (!bot && maxExplorationSlots(i.limit, cap) > 0) {
    const inList = new Set(ranked.map((r) => r.candidate.productId));
    const pool = i.newSellerPool.filter((c) => !inList.has(c.productId));
    explored = pickExploration(pool, i.explorationStats, i.limit, i.rng, cap);
  }
  ranked = ranked.slice(0, Math.max(0, i.limit - explored.length));
  const items = mergeExploration(ranked, explored).slice(0, i.limit);
  return {
    items,
    modelVersion: i.model.modelVersion,
    scores,
    vectors,
    explorationCount: items.filter((x) => x.exploration).length,
    botFiltered: bot,
    trainable: !bot,
  };
}
