import { RANKING_FEATURE_NAMES, type RankingFeatureName, type RankingFeatureVector } from "./features";

/**
 * Pure scoring contract. A production GBDT lives behind the API module's async port and is
 * evaluated by an adapter; the domain only defines what a model is: vectors in, one number per
 * vector out, same order, deterministic, no I/O.
 */
export interface RankerModel {
  readonly modelVersion: string;
  score(batch: readonly RankingFeatureVector[]): readonly number[];
}

/** Linear baseline. Weights are plain numbers, missing features weigh 0. */
export type LinearWeights = Readonly<Partial<Record<RankingFeatureName, number>>>;

export const BASELINE_LINEAR_WEIGHTS: LinearWeights = {
  popularity: 1,
  freshness: 1,
  verified_discount_pct: 10,
  seller_health: 2,
  price_trust: 2,
  return_rate_permille: -1,
  in_stock: 100,
  size_available: 50,
  category_affinity: 2,
  store_affinity: 1,
};

export class LinearRanker implements RankerModel {
  constructor(
    readonly modelVersion: string = "linear-baseline-v2",
    private readonly weights: LinearWeights = BASELINE_LINEAR_WEIGHTS,
    private readonly bias = 0,
  ) {}
  score(batch: readonly RankingFeatureVector[]): readonly number[] {
    return batch.map((v) => {
      let s = this.bias;
      for (const n of RANKING_FEATURE_NAMES) s += (this.weights[n] ?? 0) * v.values[n];
      return s;
    });
  }
}

/** Gradient-boosted-tree style evaluation: sum of binary trees. Trees are data, not code. */
export type TreeNode =
  | { readonly leaf: number }
  | { readonly feature: RankingFeatureName; readonly threshold: number; readonly left: TreeNode; readonly right: TreeNode };

const MAX_TREE_DEPTH = 12;

export function evalTree(t: TreeNode, v: RankingFeatureVector): number {
  let node = t;
  for (let d = 0; d <= MAX_TREE_DEPTH; d++) {
    if ("leaf" in node) return node.leaf;
    node = v.values[node.feature] <= node.threshold ? node.left : node.right;
  }
  throw new Error("tree deeper than MAX_TREE_DEPTH");
}

export class TreeEnsembleRanker implements RankerModel {
  constructor(
    readonly modelVersion: string,
    private readonly trees: readonly TreeNode[],
    private readonly learningRate = 1,
    private readonly base = 0,
  ) {}
  score(batch: readonly RankingFeatureVector[]): readonly number[] {
    return batch.map((v) => this.base + this.learningRate * this.trees.reduce((s, t) => s + evalTree(t, v), 0));
  }
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic fake: score is a stable hash of (seed, productId). For tests and contract suites. */
export class FakeRanker implements RankerModel {
  constructor(
    readonly modelVersion: string = "fake-ranker-v2",
    private readonly seed = "seed",
  ) {}
  score(batch: readonly RankingFeatureVector[]): readonly number[] {
    return batch.map((v) => fnv1a(`${this.seed}|${v.productId}`) % 100_000);
  }
}
