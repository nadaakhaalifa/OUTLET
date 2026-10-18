import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { EvaluateGuardrails, GetShadowSummary, ListEvaluations, RunEvaluation } from "../application/ranking";
import type { EvalRunRecord } from "../domain/ports";
import { ArmOutcomeSchema, GuardrailConfigSchema } from "../domain/schemas";
import { RANKING_ADMIN_RESOLVER, RANKING_GUARDRAILS, RANKING_LIST_EVAL, RANKING_RUN_EVAL, RANKING_SHADOW_SUMMARY } from "./tokens";

/** Internal only: ML and ops. Marketing and support are deliberately excluded (no business reason). */
const ROLES = ["ops", "super_admin"] as const;

const SummaryQuery = z.object({ window_hours: z.coerce.number().int().min(1).max(720).default(24) }).strict();
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const EvalBody = z
  .object({
    request_key: z.string().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/),
    candidate: z.string().min(1).max(40),
    baseline: z.string().min(1).max(40),
    seed: z.number().int().min(0).max(2_147_483_647).default(1),
    requests: z.number().int().min(1).max(2000).default(200),
    k: z.number().int().min(1).max(50).default(10),
  })
  .strict();
const GuardrailBody = z
  .object({ control: ArmOutcomeSchema, treatment: ArmOutcomeSchema, config: GuardrailConfigSchema.optional() })
  .strict();

const evalWire = (r: EvalRunRecord) => ({
  id: r.id,
  request_key: r.requestKey,
  candidate_version: r.candidateVersion,
  baseline_version: r.baselineVersion,
  dataset: r.dataset,
  seed: r.seed,
  requests: r.requests,
  k: r.k,
  candidate: { ndcg_bps: r.candidateNdcgBps, map_bps: r.candidateMapBps },
  baseline: { ndcg_bps: r.baselineNdcgBps, map_bps: r.baselineMapBps },
  passed: r.passed,
  reasons: r.reasons,
  created_at: new Date(r.createdAtMs).toISOString(),
});

@Controller("admin/ranking")
export class RankingAdminController {
  constructor(
    @Inject(RANKING_SHADOW_SUMMARY) private readonly summary: GetShadowSummary,
    @Inject(RANKING_RUN_EVAL) private readonly runEval: RunEvaluation,
    @Inject(RANKING_LIST_EVAL) private readonly listEval: ListEvaluations,
    @Inject(RANKING_GUARDRAILS) private readonly guardrails: EvaluateGuardrails,
  ) {}

  private requireRole(req: ApiRequest): void {
    const p = req.principal;
    if (p === null || p === undefined) throw Problems.unauthenticated();
    if (!p.actor.grants.some((g) => g.kind === "admin" && (ROLES as readonly string[]).includes(g.role))) throw Problems.forbidden();
  }

  @Get("shadow/summary")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: RANKING_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async shadow(@Req() req: ApiRequest, @Query(new ZodPipe(SummaryQuery, "/query")) q: z.output<typeof SummaryQuery>) {
    this.requireRole(req);
    const s = await this.summary.execute(q.window_hours);
    return {
      window_hours: q.window_hours,
      runs: s.runs,
      personalized_runs: s.personalizedRuns,
      bot_filtered_runs: s.botFilteredRuns,
      mean_overlap_permille: s.meanOverlapPermille,
      top1_same_permille: s.top1SamePermille,
      mean_rank_shift_milli: s.meanRankShiftMilli,
      shadow_model_versions: s.shadowModelVersions,
      served: "v1",
    };
  }

  @Post("evaluations")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: RANKING_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async evaluate(@Req() req: ApiRequest, @Body(new ZodPipe(EvalBody)) b: z.output<typeof EvalBody>) {
    this.requireRole(req);
    const r = await this.runEval.execute({
      requestKey: b.request_key,
      candidate: b.candidate,
      baseline: b.baseline,
      seed: b.seed,
      requests: b.requests,
      k: b.k,
    });
    if (r.kind === "unknown_model") throw Problems.validation([{ pointer: "/body", code: "unknown_model" }]);
    return { ...evalWire(r.run), replayed: r.replayed };
  }

  @Get("evaluations")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: RANKING_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async evaluations(@Req() req: ApiRequest, @Query(new ZodPipe(ListQuery, "/query")) q: z.output<typeof ListQuery>) {
    this.requireRole(req);
    return { items: (await this.listEval.execute(q.limit)).map(evalWire) };
  }

  @Post("guardrails/evaluate")
  @HttpCode(200)
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: RANKING_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async guardrail(@Req() req: ApiRequest, @Body(new ZodPipe(GuardrailBody)) b: z.output<typeof GuardrailBody>) {
    this.requireRole(req);
    const r = this.guardrails.execute({ control: b.control, treatment: b.treatment, ...(b.config === undefined ? {} : { config: b.config }) });
    return {
      decision: r.result.decision,
      breaches: r.result.breaches,
      return_rate_delta_bps: r.result.returnRateDeltaBps,
      complaint_rate_delta_bps: r.result.complaintRateDeltaBps,
      config: {
        min_orders_per_arm: r.config.minOrdersPerArm,
        max_return_rate_increase_bps: r.config.maxReturnRateIncreaseBps,
        max_complaint_rate_increase_bps: r.config.maxComplaintRateIncreaseBps,
      },
    };
  }
}
