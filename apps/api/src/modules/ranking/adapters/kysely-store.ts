import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type {
  EvalRunRecord,
  EvalRunStore,
  ShadowItemRecord,
  ShadowLogStore,
  ShadowRunRecord,
  ShadowSummary,
} from "../domain/ports";

export type RankingDb = Kysely<Record<string, never>>;

const Num = z.union([z.number(), z.string()]).transform((v) => Number(v));
const NumOrNull = z.union([z.number(), z.string(), z.null()]).transform((v) => (v === null ? null : Number(v)));

const SummaryRow = z.object({
  runs: Num,
  personalized_runs: Num,
  bot_runs: Num,
  mean_overlap: NumOrNull,
  top1_same: NumOrNull,
  mean_shift: NumOrNull,
  versions: z.union([z.array(z.string()), z.null()]),
});
const EvalRow = z.object({
  id: z.string(),
  request_key: z.string(),
  candidate_version: z.string(),
  baseline_version: z.string(),
  dataset: z.enum(["synthetic", "shadow_logs"]),
  seed: NumOrNull,
  requests: Num,
  k: Num,
  candidate_ndcg_bps: Num,
  candidate_map_bps: Num,
  baseline_ndcg_bps: Num,
  baseline_map_bps: Num,
  passed: z.boolean(),
  reasons: z.array(z.string()),
  created_ms: Num,
});
const ItemRow = z.object({
  product_id: z.string(),
  v1_rank: Num,
  v2_rank: Num,
  v2_score_milli: z.union([z.string(), z.number(), z.bigint()]).transform((v) => BigInt(v)),
  features: z.record(z.string(), z.number()),
});

const toEval = (r: z.output<typeof EvalRow>): EvalRunRecord => ({
  id: r.id,
  requestKey: r.request_key,
  candidateVersion: r.candidate_version,
  baselineVersion: r.baseline_version,
  dataset: r.dataset,
  seed: r.seed,
  requests: r.requests,
  k: r.k,
  candidateNdcgBps: r.candidate_ndcg_bps,
  candidateMapBps: r.candidate_map_bps,
  baselineNdcgBps: r.baseline_ndcg_bps,
  baselineMapBps: r.baseline_map_bps,
  passed: r.passed,
  reasons: r.reasons,
  createdAtMs: r.created_ms,
});

const EVAL_COLS = sql.raw(
  "id::text AS id, request_key, candidate_version, baseline_version, dataset, seed, requests, k, candidate_ndcg_bps, candidate_map_bps, baseline_ndcg_bps, baseline_map_bps, passed, reasons, (extract(epoch FROM created_at) * 1000)::bigint AS created_ms",
);

/** Shadow logs (0079) and offline evaluation results (0080). Raw SQL, rows validated with Zod. */
export class KyselyRankingStore implements ShadowLogStore, EvalRunStore {
  constructor(private readonly db: RankingDb) {}

  async record(run: ShadowRunRecord, items: readonly ShadowItemRecord[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO ranking_shadow_runs
          (id, module, served_model_version, shadow_model_version, personalized, bot_filtered, candidate_count,
           k, overlap_permille, top1_same, mean_rank_shift_milli, created_at)
        VALUES (${run.id}::uuid, ${run.module}, ${run.servedModelVersion}, ${run.shadowModelVersion}, ${run.personalized},
           ${run.botFiltered}, ${run.candidateCount}, ${run.k}, ${run.overlapPermille}, ${run.top1Same},
           ${run.meanRankShiftMilli}, to_timestamp(${run.createdAtMs}::double precision / 1000))`.execute(trx);
      for (const it of items) {
        await sql`INSERT INTO ranking_shadow_items (run_id, product_id, v1_rank, v2_rank, v2_score_milli, features)
          VALUES (${run.id}::uuid, ${it.productId}::uuid, ${it.v1Rank}, ${it.v2Rank}, ${it.v2ScoreMilli.toString()}::bigint,
            ${JSON.stringify(it.features)}::jsonb)`.execute(trx);
      }
    });
  }

  async itemsOf(runId: string): Promise<readonly ShadowItemRecord[]> {
    const r = await sql<unknown>`SELECT product_id::text AS product_id, v1_rank, v2_rank, v2_score_milli::text AS v2_score_milli, features
      FROM ranking_shadow_items WHERE run_id = ${runId}::uuid ORDER BY v2_rank`.execute(this.db);
    return r.rows.map((x) => {
      const p = ItemRow.parse(x);
      return {
        productId: p.product_id,
        v1Rank: p.v1_rank,
        v2Rank: p.v2_rank,
        v2ScoreMilli: p.v2_score_milli,
        features: p.features as ShadowItemRecord["features"],
      };
    });
  }

  async summary(sinceMs: number): Promise<ShadowSummary> {
    const r = await sql<unknown>`SELECT count(*) AS runs,
        count(*) FILTER (WHERE personalized) AS personalized_runs,
        count(*) FILTER (WHERE bot_filtered) AS bot_runs,
        round(avg(overlap_permille)) AS mean_overlap,
        CASE WHEN count(*) = 0 THEN NULL ELSE round(count(*) FILTER (WHERE top1_same) * 1000.0 / count(*)) END AS top1_same,
        round(avg(mean_rank_shift_milli)) AS mean_shift,
        array_agg(DISTINCT shadow_model_version) AS versions
      FROM ranking_shadow_runs WHERE created_at >= to_timestamp(${sinceMs}::double precision / 1000)`.execute(this.db);
    const p = SummaryRow.parse(r.rows[0]);
    return {
      runs: p.runs,
      personalizedRuns: p.personalized_runs,
      botFilteredRuns: p.bot_runs,
      meanOverlapPermille: p.mean_overlap,
      top1SamePermille: p.top1_same,
      meanRankShiftMilli: p.mean_shift,
      shadowModelVersions: [...(p.versions ?? [])].sort(),
    };
  }

  async purgeBefore(beforeMs: number): Promise<number> {
    const r = await sql<{ n: string }>`WITH d AS (DELETE FROM ranking_shadow_runs WHERE created_at < to_timestamp(${beforeMs}::double precision / 1000) RETURNING 1)
      SELECT count(*)::text AS n FROM d`.execute(this.db);
    return Number(r.rows[0]?.n ?? 0);
  }

  async insert(run: EvalRunRecord): Promise<{ run: EvalRunRecord; created: boolean }> {
    const ins = await sql<unknown>`INSERT INTO ranking_eval_runs
        (id, request_key, candidate_version, baseline_version, dataset, seed, requests, k, candidate_ndcg_bps,
         candidate_map_bps, baseline_ndcg_bps, baseline_map_bps, passed, reasons, created_at)
      VALUES (${run.id}::uuid, ${run.requestKey}, ${run.candidateVersion}, ${run.baselineVersion}, ${run.dataset},
        ${run.seed}, ${run.requests}, ${run.k}, ${run.candidateNdcgBps}, ${run.candidateMapBps}, ${run.baselineNdcgBps},
        ${run.baselineMapBps}, ${run.passed}, ${JSON.stringify(run.reasons)}::jsonb,
        to_timestamp(${run.createdAtMs}::double precision / 1000))
      ON CONFLICT (request_key) DO NOTHING
      RETURNING ${EVAL_COLS}`.execute(this.db);
    if (ins.rows[0] !== undefined) return { run: toEval(EvalRow.parse(ins.rows[0])), created: true };
    const ex = await sql<unknown>`SELECT ${EVAL_COLS} FROM ranking_eval_runs WHERE request_key = ${run.requestKey}`.execute(this.db);
    return { run: toEval(EvalRow.parse(ex.rows[0])), created: false };
  }

  async list(limit: number): Promise<readonly EvalRunRecord[]> {
    const r = await sql<unknown>`SELECT ${EVAL_COLS} FROM ranking_eval_runs ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(this.db);
    return r.rows.map((x) => toEval(EvalRow.parse(x)));
  }
}
