import { z } from "zod";

/**
 * Phase 3 wire schemas for the Admin API (creators, creator payouts, ranking v2). They mirror the generated
 * contract in packages/api-client/src/generated/schemas.ts and operations.ts. A mismatch becomes a "contract"
 * error on the screen, never a guess.
 */
const ts = z.iso.datetime({ offset: true });
const uuid = z.uuid();
const money = z.object({ amount: z.string().regex(/^-?\d{1,18}$/), currency: z.literal("EGP") });

export const CREATOR_STATUSES = ["APPLIED", "ACTIVE", "SUSPENDED", "REJECTED"] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];
export const creatorAccount = z.object({
  id: uuid, user_id: uuid, handle: z.string(), display_name: z.string(), status: z.enum(CREATOR_STATUSES),
  kyc_state: z.enum(["DRAFT", "SUBMITTED", "AUTO_CHECKS", "APPROVED", "NEEDS_INFO", "REJECTED"]),
  status_reason: z.string().nullable().optional(), applied_at: ts.optional(), decided_at: ts.nullable().optional(),
});
export type CreatorAccountWire = z.infer<typeof creatorAccount>;
export const creatorAccountList = z.object({ items: z.array(creatorAccount) });

export const CREATOR_DECISIONS = ["approve", "reject", "needs_info", "suspend", "reinstate"] as const;
export type CreatorDecision = (typeof CREATOR_DECISIONS)[number];

export const PAYOUT_STATES = ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"] as const;
export type CreatorPayoutState = (typeof PAYOUT_STATES)[number];
export const creatorPayout = z.object({
  id: uuid, creator_id: uuid, amount: money, state: z.enum(PAYOUT_STATES),
  hold_reason: z.string().nullable().optional(), failure_reason: z.string().nullable().optional(), attempt: z.number().int(),
  created_by: uuid.optional(), created_at: ts.optional(), updated_at: ts.optional(),
});
export type CreatorPayoutWire = z.infer<typeof creatorPayout>;
export const creatorPayoutList = z.object({ items: z.array(creatorPayout) });

const arm = z.object({ ndcg_bps: z.number().int(), map_bps: z.number().int() });
export const rankingEvaluation = z.object({
  id: uuid, request_key: z.string(), candidate_version: z.string(), baseline_version: z.string(),
  dataset: z.enum(["synthetic", "shadow_logs"]), seed: z.number().int().nullable(), requests: z.number().int(), k: z.number().int(),
  candidate: arm, baseline: arm, passed: z.boolean(), reasons: z.array(z.string()), created_at: ts,
});
export type RankingEvaluationWire = z.infer<typeof rankingEvaluation>;
export const rankingEvaluationList = z.object({ items: z.array(rankingEvaluation) });
export const rankingEvaluationRun = rankingEvaluation.extend({ replayed: z.boolean() });
export const rankingShadowSummary = z.object({
  window_hours: z.number().int(), runs: z.number().int(), personalized_runs: z.number().int(), bot_filtered_runs: z.number().int(),
  mean_overlap_permille: z.number().int().nullable(), top1_same_permille: z.number().int().nullable(),
  mean_rank_shift_milli: z.number().int().nullable(), shadow_model_versions: z.array(z.string()), served: z.literal("v1"),
});
export type RankingShadowSummaryWire = z.infer<typeof rankingShadowSummary>;
export const guardrailDecision = z.object({
  decision: z.enum(["continue", "halt", "insufficient_data"]),
  breaches: z.array(z.enum(["return_rate", "complaint_rate"])),
  return_rate_delta_bps: z.number().int().nullable(), complaint_rate_delta_bps: z.number().int().nullable(),
  config: z.object({ min_orders_per_arm: z.number().int(), max_return_rate_increase_bps: z.number().int(), max_complaint_rate_increase_bps: z.number().int() }),
});
export type GuardrailDecisionWire = z.infer<typeof guardrailDecision>;
