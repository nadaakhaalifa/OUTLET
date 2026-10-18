import { recallAtK, reciprocalRank, type EvalQuery, type EvalReport } from "../domain/metrics";
import type { VisualIndexPort } from "../domain/ports";

/**
 * Offline retrieval evaluation. Runs queries (already embedded) through any VisualIndexPort and
 * reports recall@k, MRR and embedding coverage. Metrics are computed on the ranked product ids the
 * index returns, before catalog filtering: this measures the embedding and ANN quality in isolation.
 * `catalogIds` is the set of products the labelled set expects to be searchable.
 */
export async function evaluateRetrieval(input: {
  readonly index: VisualIndexPort;
  readonly modelVersion: string;
  readonly queries: readonly EvalQuery[];
  readonly k: number;
  /** Depth used for MRR so a relevant item ranked below k still earns partial credit. Default 100. */
  readonly mrrDepth?: number;
}): Promise<EvalReport> {
  const depth = Math.max(input.k, input.mrrDepth ?? 100);
  let recall = 0;
  let rr = 0;
  let covered = 0;
  let expectedTotal = 0;
  const cat = new Map<string, { n: number; recall: number; rr: number }>();
  for (const q of input.queries) {
    const relevant = new Set(q.expected);
    const ranked = (await input.index.search({ vector: q.vector, modelVersion: input.modelVersion, k: depth })).map((n) => n.productId);
    const r = recallAtK(ranked, relevant, input.k);
    const m = reciprocalRank(ranked, relevant);
    recall += r;
    rr += m;
    for (const id of q.expected) {
      expectedTotal++;
      if ((await input.index.vectorOf(id))?.modelVersion === input.modelVersion) covered++;
    }
    const c = cat.get(q.category ?? "all") ?? { n: 0, recall: 0, rr: 0 };
    cat.set(q.category ?? "all", { n: c.n + 1, recall: c.recall + r, rr: c.rr + m });
  }
  const n = input.queries.length;
  return {
    queries: n,
    k: input.k,
    recallAtK: n === 0 ? 0 : recall / n,
    mrr: n === 0 ? 0 : rr / n,
    coverage: expectedTotal === 0 ? 0 : covered / expectedTotal,
    byCategory: Object.fromEntries([...cat].map(([k, v]) => [k, { queries: v.n, recallAtK: v.recall / v.n, mrr: v.rr / v.n }])),
  };
}
