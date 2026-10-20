/** Offline retrieval metrics. Pure functions over ranked id lists. */

/** recall@k = |relevant in top k| / |relevant|. Empty relevant set is undefined and rejected. */
export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) throw new RangeError("relevant set is empty");
  let hits = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

/** Reciprocal rank of the first relevant item within the list (0 when absent). */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  const i = ranked.findIndex((id) => relevant.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export interface EvalQuery {
  readonly id: string;
  readonly vector: readonly number[];
  readonly expected: readonly string[];
  readonly category?: string;
}

export interface EvalReport {
  readonly queries: number;
  readonly k: number;
  readonly recallAtK: number;
  readonly mrr: number;
  /** Share of expected products that have an embedding under the evaluated model version. */
  readonly coverage: number;
  readonly byCategory: Readonly<Record<string, { readonly queries: number; readonly recallAtK: number; readonly mrr: number }>>;
}

export interface EvalThresholds {
  readonly recallAtK: number;
  readonly mrr: number;
  readonly coverage: number;
}

export const meetsThresholds = (r: EvalReport, t: EvalThresholds): boolean =>
  r.queries > 0 && r.recallAtK >= t.recallAtK && r.mrr >= t.mrr && r.coverage >= t.coverage;
