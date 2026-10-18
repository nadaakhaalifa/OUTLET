import type { Rng } from "../recommendations/types";
import { RANKING_FEATURE_NAMES, type RankingFeatureVector } from "./features";
import type { RankerModel } from "./model";
import { BOT_SCORE_THRESHOLD_PERMILLE } from "./pipeline";

/** One logged impression: a candidate shown (or scored) with its graded outcome. */
export interface LoggedImpression {
  readonly requestId: string;
  readonly vector: RankingFeatureVector;
  /** 1-based position the logging policy showed it at. */
  readonly position: number;
  /** Graded relevance 0..3 (0 none, 1 click, 2 save/bag, 3 purchase kept). */
  readonly relevance: number;
  readonly botScorePermille: number;
}

export interface EvalMetrics {
  readonly ndcgAtK: number;
  readonly map: number;
  readonly requests: number;
  readonly k: number;
}

const log2 = (x: number): number => Math.log(x) / Math.LN2;

/** DCG with exponential gain 2^rel - 1. `rels` already in ranked order. */
export function dcgAtK(rels: readonly number[], k: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(k, rels.length); i++) s += (Math.pow(2, rels[i] ?? 0) - 1) / log2(i + 2);
  return s;
}

export function ndcgAtK(rankedRels: readonly number[], k: number): number {
  const ideal = dcgAtK([...rankedRels].sort((a, b) => b - a), k);
  return ideal === 0 ? 0 : dcgAtK(rankedRels, k) / ideal;
}

/** Average precision over binary relevance (rel > 0), normalised by total relevant items. */
export function averagePrecision(rankedRels: readonly number[]): number {
  let hits = 0;
  let sum = 0;
  rankedRels.forEach((r, i) => {
    if (r > 0) {
      hits++;
      sum += hits / (i + 1);
    }
  });
  return hits === 0 ? 0 : sum / hits;
}

export function groupByRequest(logs: readonly LoggedImpression[]): Map<string, LoggedImpression[]> {
  const m = new Map<string, LoggedImpression[]>();
  for (const l of logs) {
    const g = m.get(l.requestId);
    if (g === undefined) m.set(l.requestId, [l]);
    else g.push(l);
  }
  return m;
}

/** Bot traffic never counts toward evaluation or training. */
export function dropBotImpressions(logs: readonly LoggedImpression[], threshold = BOT_SCORE_THRESHOLD_PERMILLE): LoggedImpression[] {
  return logs.filter((l) => l.botScorePermille < threshold);
}

/** Re-ranks every request group with `model` and averages NDCG@k and MAP. Ties break by product id. */
export function evaluateRanker(model: RankerModel, logs: readonly LoggedImpression[], k = 10): EvalMetrics {
  const groups = groupByRequest(dropBotImpressions(logs));
  let nd = 0;
  let ap = 0;
  let n = 0;
  for (const g of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v)) {
    const scores = model.score(g.map((x) => x.vector));
    const order = g
      .map((x, i) => ({ x, s: scores[i] ?? 0 }))
      .sort((a, b) => b.s - a.s || (a.x.vector.productId < b.x.vector.productId ? -1 : 1));
    const rels = order.map((o) => o.x.relevance);
    nd += ndcgAtK(rels, k);
    ap += averagePrecision(rels);
    n++;
  }
  return { ndcgAtK: n === 0 ? 0 : nd / n, map: n === 0 ? 0 : ap / n, requests: n, k };
}

/** Examination propensity of a display position (cascade-style, strictly decreasing). */
export function positionPropensity(position: number): number {
  return 1 / (1 + 0.5 * Math.max(0, position - 1));
}

/** Inverse-propensity weight used to de-bias click-derived labels. Clamped to bound variance. */
export function ipsWeight(position: number, maxWeight = 10): number {
  return Math.min(maxWeight, 1 / positionPropensity(position));
}

export interface RegressionGate {
  /** Absolute floor for NDCG@k of the candidate. */
  readonly minNdcg: number;
  /** Candidate may be at most this many basis points below the baseline NDCG. */
  readonly maxRelativeDropBps: number;
  readonly minRequests: number;
}
export const DEFAULT_REGRESSION_GATE: RegressionGate = { minNdcg: 0.5, maxRelativeDropBps: 100, minRequests: 50 };

export function checkRegression(
  candidate: EvalMetrics,
  baseline: EvalMetrics,
  gate: RegressionGate = DEFAULT_REGRESSION_GATE,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (candidate.requests < gate.minRequests) reasons.push("insufficient_requests");
  if (candidate.ndcgAtK < gate.minNdcg) reasons.push("below_ndcg_floor");
  if (candidate.ndcgAtK < baseline.ndcgAtK * (1 - gate.maxRelativeDropBps / 10_000)) reasons.push("ndcg_regression_vs_baseline");
  if (candidate.map < baseline.map * (1 - gate.maxRelativeDropBps / 10_000)) reasons.push("map_regression_vs_baseline");
  return { passed: reasons.length === 0, reasons };
}

/** Synthetic logged impressions with known latent relevance, a position-biased logging policy and a few bots. */
export function generateSyntheticLogs(opts: {
  readonly seed: Rng;
  readonly requests: number;
  readonly perRequest?: number;
  readonly botShare?: number;
}): LoggedImpression[] {
  const per = opts.perRequest ?? 20;
  const out: LoggedImpression[] = [];
  const r = (): number => opts.seed.next();
  for (let q = 0; q < opts.requests; q++) {
    const bot = r() < (opts.botShare ?? 0.05);
    const requestId = `req-${q.toString().padStart(5, "0")}`;
    const rows = Array.from({ length: per }, (_, i) => {
      const values = Object.fromEntries(RANKING_FEATURE_NAMES.map((n) => [n, 0])) as Record<(typeof RANKING_FEATURE_NAMES)[number], number>;
      values.popularity = Math.floor(r() * 1000);
      values.freshness = Math.floor(r() * 1000);
      values.verified_discount_pct = Math.floor(r() * 60);
      values.seller_health = Math.floor(r() * 100);
      values.price_trust = Math.floor(r() * 100);
      values.return_rate_permille = Math.floor(r() * 300);
      values.in_stock = 1;
      values.size_available = r() < 0.8 ? 1 : 0;
      values.category_affinity = r() < 0.3 ? Math.floor(r() * 1000) : 0;
      values.store_affinity = r() < 0.2 ? Math.floor(r() * 1000) : 0;
      const latent =
        values.popularity / 1000 +
        values.verified_discount_pct / 60 +
        values.price_trust / 100 -
        values.return_rate_permille / 300 +
        values.category_affinity / 500 +
        (r() - 0.5) * 0.6;
      return { id: `p-${q}-${i}`, values, latent };
    });
    const sortedLatent = rows.map((x) => x.latent).sort((a, b) => b - a);
    const t3 = sortedLatent[Math.floor(per * 0.1)] ?? 0;
    const t2 = sortedLatent[Math.floor(per * 0.25)] ?? 0;
    const t1 = sortedLatent[Math.floor(per * 0.5)] ?? 0;
    // Logging policy: noisy popularity-only order (what v1 roughly did), so position is biased.
    const shown = [...rows].sort((a, b) => b.values.popularity + (r() - 0.5) * 400 - (a.values.popularity + (r() - 0.5) * 400));
    shown.forEach((row, idx) => {
      const rel = row.latent >= t3 ? 3 : row.latent >= t2 ? 2 : row.latent >= t1 ? 1 : 0;
      out.push({
        requestId,
        position: idx + 1,
        relevance: rel,
        botScorePermille: bot ? 900 : Math.floor(r() * 300),
        vector: { productId: row.id, storeId: `s-${Math.floor(r() * 6)}`, personalized: row.values.category_affinity > 0, values: row.values },
      });
    });
  }
  return out;
}
