import { bigintToNumber } from "./budget.js";
import { analyzeQuery } from "./query.js";
import type { SearchDoc, SearchEnginePort, SearchFilters } from "./port.js";
import { isRelevant, ndcgAtK, percentile, type Judgment } from "./relevance.js";

export interface BakeoffQuery {
  readonly id: string;
  readonly text: string;
  readonly script: "ar" | "en" | "franco" | "mixed";
  readonly intent: string;
  readonly expected_normalized: string;
  readonly expected_filters?: { readonly maxPriceMinor?: number };
  readonly tags?: readonly string[];
  readonly source: "synthetic" | "real";
}

export interface GroupMetrics {
  readonly queries: number;
  readonly judged: number;
  readonly recallAt10: number;
  readonly ndcgAt10: number;
  readonly zeroResultRate: number;
}

export interface EngineRun {
  readonly engine: string;
  readonly date: string;
  readonly docs: number;
  readonly queries: number;
  readonly judgedQueries: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly p99: number };
  readonly recallAt10: number;
  readonly ndcgAt10: number;
  readonly zeroResultRate: number;
  readonly typoHitRate: number;
  readonly francoHitRate: number;
  readonly byScript: Readonly<Record<string, GroupMetrics>>;
  readonly corpusSource: string;
}

export interface RunOptions {
  readonly engine: SearchEnginePort;
  readonly docs: readonly SearchDoc[];
  readonly queries: readonly BakeoffQuery[];
  readonly judgments: readonly Judgment[];
  readonly date: string;
  /** Timed passes after one warm-up pass (default 3). */
  readonly passes?: number;
  readonly now?: () => number;
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const round = (n: number): number => Math.round(n * 1000) / 1000;

interface Row {
  readonly q: BakeoffQuery;
  readonly zero: boolean;
  readonly judged: boolean;
  readonly recall: number;
  readonly ndcg: number;
  readonly hit: boolean;
}

const summarize = (rows: readonly Row[]): GroupMetrics => {
  const judged = rows.filter((r) => r.judged);
  return {
    queries: rows.length,
    judged: judged.length,
    recallAt10: round(mean(judged.map((r) => r.recall))),
    ndcgAt10: round(mean(judged.map((r) => r.ndcg))),
    zeroResultRate: round(mean(rows.map((r) => (r.zero ? 1 : 0)))),
  };
};

/** Indexes the fixtures, runs every query through the shared analyser, and scores the engine. */
export const runEngine = async (opts: RunOptions): Promise<EngineRun> => {
  const now = opts.now ?? ((): number => performance.now());
  const byId = new Map(opts.docs.map((d) => [d.id, d] as const));
  const judgmentOf = new Map(opts.judgments.map((j) => [j.queryId, j] as const));
  await opts.engine.index(opts.docs);

  const prep = opts.queries.map((q) => {
    const a = analyzeQuery(q.text, { fuzzy: false });
    const max = a.maxPriceMinor === undefined ? undefined : bigintToNumber(a.maxPriceMinor);
    const filters: SearchFilters = max === undefined ? {} : { maxPriceMinor: max };
    return { q, query: a.engineQuery, filters, max };
  });
  for (const p of prep) await opts.engine.search(p.query, p.filters, 10); // warm-up

  const latencies: number[] = [];
  const rows: Row[] = [];
  const passes = opts.passes ?? 3;
  for (let pass = 0; pass < passes; pass += 1) {
    for (const p of prep) {
      const t0 = now();
      const res = await opts.engine.search(p.query, p.filters, 10);
      latencies.push(now() - t0);
      if (pass !== 0) continue;
      const j = judgmentOf.get(p.q.id);
      const top = res.hits.slice(0, 10).map((h) => byId.get(h.id));
      let recall = 0;
      let ndcg = 0;
      let judged = false;
      let hit = false;
      if (j !== undefined) {
        const total = opts.docs.filter((d) => isRelevant(d, j, p.max)).length;
        if (total > 0) {
          judged = true;
          const rel = top.map((d) => d !== undefined && isRelevant(d, j, p.max));
          const found = rel.filter(Boolean).length;
          recall = found / Math.min(10, total);
          ndcg = ndcgAtK(rel, total, 10);
          hit = found > 0;
        }
      }
      rows.push({ q: p.q, zero: res.hits.length === 0, judged, recall, ndcg, hit });
    }
  }
  latencies.sort((a, b) => a - b);
  const all = summarize(rows);
  const scripts = [...new Set(rows.map((r) => r.q.script))].sort();
  const byScript = Object.fromEntries(scripts.map((s) => [s, summarize(rows.filter((r) => r.q.script === s))]));
  const hitRate = (sel: (r: Row) => boolean): number => {
    const sub = rows.filter((r) => r.judged && sel(r));
    return round(sub.length === 0 ? 0 : sub.filter((r) => r.hit).length / sub.length);
  };
  return {
    engine: opts.engine.name,
    date: opts.date,
    docs: opts.docs.length,
    queries: rows.length,
    judgedQueries: all.judged,
    latencyMs: { p50: round(percentile(latencies, 50)), p95: round(percentile(latencies, 95)), p99: round(percentile(latencies, 99)) },
    recallAt10: all.recallAt10,
    ndcgAt10: all.ndcgAt10,
    zeroResultRate: all.zeroResultRate,
    typoHitRate: hitRate((r) => r.q.tags?.includes("typo") === true),
    francoHitRate: hitRate((r) => r.q.script === "franco"),
    byScript,
    corpusSource: [...new Set(opts.queries.map((q) => q.source))].join(","),
  };
};

export const summaryTable = (runs: readonly EngineRun[]): string => {
  const head = "| Engine | docs | queries | judged | p50 ms | p95 ms | recall@10 | nDCG@10 | zero-result | typo hit | Franco hit |\n|---|---|---|---|---|---|---|---|---|---|---|";
  const lines = runs.map(
    (r) =>
      ["", r.engine, ...[r.docs, r.queries, r.judgedQueries, r.latencyMs.p50, r.latencyMs.p95, r.recallAt10, r.ndcgAt10, r.zeroResultRate, r.typoHitRate, r.francoHitRate].map((n) => n.toString()), ""].join(" | ").trim(),
  );
  return [head, ...lines].join("\n");
};
