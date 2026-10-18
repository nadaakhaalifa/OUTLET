import { EMBED_DIM, seededUnitVector } from "../adapters/in-memory";
import type { EvalQuery } from "../domain/metrics";
import { norm } from "../domain/similarity";

/**
 * Synthetic labelled set. NOT a quality claim for the Egyptian catalogue: the real labelled set
 * (VR-P3-13, owner and data task) replaces it before the feature is enabled. This set exists to
 * regress retrieval plumbing: index, filters by model version, ordering and metric code.
 *
 * Structure: `groups` style groups, each with `perGroup` products embedded near a group centre
 * (noise `productNoise`). Each group has `queriesPerGroup` queries near the same centre (noise
 * `queryNoise`). Expected results for a query are the products of its group.
 */
export interface SyntheticSpec {
  readonly seed: number;
  readonly groups: number;
  readonly perGroup: number;
  readonly queriesPerGroup: number;
  readonly productNoise: number;
  readonly queryNoise: number;
  readonly dim: number;
}

export const DEFAULT_SYNTHETIC: SyntheticSpec = {
  seed: 20261012,
  groups: 40,
  perGroup: 5,
  queriesPerGroup: 3,
  productNoise: 2,
  queryNoise: 2.5,
  dim: EMBED_DIM,
};

export const productIdOf = (g: number, p: number): string => `00000000-0000-4000-8000-${String(g * 100 + p + 1).padStart(12, "0")}`;

const noisy = (centre: readonly number[], seed: number, sigma: number): number[] => {
  const e = seededUnitVector(seed, centre.length);
  const v = centre.map((c, i) => c + sigma * (e[i] ?? 0));
  const n = norm(v);
  return v.map((x) => x / n);
};

export interface SyntheticSet {
  readonly products: readonly { readonly productId: string; readonly vector: readonly number[]; readonly category: string }[];
  readonly queries: readonly EvalQuery[];
}

export function buildSyntheticSet(spec: SyntheticSpec = DEFAULT_SYNTHETIC): SyntheticSet {
  const products: { productId: string; vector: number[]; category: string }[] = [];
  const queries: EvalQuery[] = [];
  const cats = ["dress", "top", "shoes", "bag"];
  for (let g = 0; g < spec.groups; g++) {
    const centre = seededUnitVector(spec.seed + g * 7919, spec.dim);
    const category = cats[g % cats.length] ?? "dress";
    const expected: string[] = [];
    for (let p = 0; p < spec.perGroup; p++) {
      const productId = productIdOf(g, p);
      expected.push(productId);
      // seededUnitVector is unit norm, so sigma is the noise-to-signal norm ratio.
      products.push({ productId, vector: noisy(centre, spec.seed * 31 + g * 1009 + p, spec.productNoise), category });
    }
    for (let q = 0; q < spec.queriesPerGroup; q++) {
      queries.push({ id: `q-${g}-${q}`, vector: noisy(centre, spec.seed * 17 + g * 2003 + q + 500_000, spec.queryNoise), expected, category });
    }
  }
  return { products, queries };
}
