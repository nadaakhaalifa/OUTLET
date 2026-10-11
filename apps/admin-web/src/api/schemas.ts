import { admin } from "@outlet/domain";
import { z } from "zod";

/**
 * Wire schemas for the Admin API. Every response is parsed here; a mismatch becomes a "contract" error and
 * the screen shows an error state, never a guess. Shapes mirror the controllers' explicit wire mappers
 * (apps/api/src/modules/{admin,privacy,tax-eta,ledger,reviews}) and docs/api/openapi.yaml where no controller exists yet.
 */
const ts = z.iso.datetime({ offset: true });
const tsOrNull = ts.nullable();
const uuid = z.uuid();
const minor = z.string().regex(/^-?\d{1,18}$/);
const money = z.object({ amount: minor, currency: z.literal("EGP") });
const page = z.object({ next_cursor: z.string().nullable(), has_more: z.boolean() });

export const roleName = z.enum(admin.ADMIN_ROLE_NAMES);
export const reasonCode = z.enum(admin.ADMIN_REASON_CODES);
export const approvalKind = z.enum(admin.APPROVAL_KINDS);

export const problemSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().optional(),
  detail: z.string().optional(),
  code: z.string().optional(),
  request_id: z.string().optional(),
  errors: z.array(z.object({ pointer: z.string(), code: z.string(), detail: z.string().optional() })).optional(),
});

// ---- session -------------------------------------------------------------------------------
export const sessionTokens = z.object({
  access_token: z.string(),
  access_expires_at: ts,
  refresh_token: z.string(),
  refresh_expires_at: ts,
  second_factor_required: z.boolean().optional(),
});
export type SessionTokens = z.infer<typeof sessionTokens>;
export const passkeyOptions = z.object({ challenge_id: uuid, challenge: z.string(), rp_id: z.string(), expires_at: ts });
export type PasskeyOptions = z.infer<typeof passkeyOptions>;

/** PROPOSED endpoint GET /v1/admin/me (see spec gaps). */
export const adminMe = z.object({
  user_id: uuid,
  /** Effective roles: standing grants plus LIVE elevations (standing super_admin alone grants nothing). */
  roles: z.array(roleName),
  standing_roles: z.array(roleName),
  assurance: z.enum(["passkey", "totp", "otp"]),
  posture: z.object({ ip_allowlisted: z.boolean(), device_trusted: z.boolean() }),
});
export type AdminMe = z.infer<typeof adminMe>;

// ---- approvals / elevations ---------------------------------------------------------------
export const approvalSchema = z.object({
  id: uuid,
  kind: approvalKind,
  subject_type: z.string(),
  subject_id: z.string(),
  amount_minor: minor.nullable(),
  currency: z.literal("EGP"),
  reason_code: z.string(),
  requester_id: uuid,
  state: z.enum(admin.APPROVAL_STATES),
  approver_id: uuid.nullable(),
  requested_at: ts,
  expires_at: ts,
  decided_at: tsOrNull,
});
export type ApprovalWire = z.infer<typeof approvalSchema>;
export const approvalList = z.object({ items: z.array(approvalSchema) });
export const approvalCreated = z.union([approvalSchema, z.object({ approval_required: z.literal(false) })]);

export const elevationSchema = z.object({
  id: uuid,
  user_id: uuid,
  role: roleName,
  reason_code: z.string(),
  approval_id: uuid,
  state: z.enum(admin.ELEVATION_STATES),
  requested_at: ts,
  activated_at: tsOrNull,
  expires_at: tsOrNull,
});
export type ElevationWire = z.infer<typeof elevationSchema>;
export const elevationList = z.object({ items: z.array(elevationSchema) });

export const piiViewResult = z.object({
  subject_user_id: uuid,
  fields: z.record(z.string(), z.string()),
  reason_code: reasonCode,
});

// ---- flags ----------------------------------------------------------------------------------
export const flagSchema = z.object({
  key: z.string(),
  kind: z.enum(["kill_switch", "release"]),
  description: z.string(),
  enabled: z.boolean(),
  is_default: z.boolean(),
});
export type FlagWire = z.infer<typeof flagSchema>;
export const flagList = z.object({ items: z.array(flagSchema) });
export const flagSetResult = flagSchema.extend({ previous_enabled: z.boolean() });

// ---- KYC ------------------------------------------------------------------------------------
export const sellerKycSchema = z.object({
  seller_id: uuid,
  kyc_state: z.string(),
  store_count: z.number().int(),
  store_names: z.array(z.string()),
  updated_at: ts,
});
export type SellerKycWire = z.infer<typeof sellerKycSchema>;
export const kycQueue = z.object({ items: z.array(sellerKycSchema) });
export const reviewSchema = z.object({
  id: uuid,
  seller_id: uuid,
  state: z.enum(admin.REVIEW_STATES),
  reason_code: z.string(),
  suspended_at: ts,
  due_at: ts,
  overdue: z.boolean(),
  automatic: z.boolean(),
  reviewed_at: tsOrNull,
});
export type ReviewWire = z.infer<typeof reviewSchema>;
export const reviewList = z.object({ items: z.array(reviewSchema) });
export const kycTransition = sellerKycSchema.extend({ review: reviewSchema.nullable() });

// ---- privacy / DPO -------------------------------------------------------------------------
export const dsarItem = z.object({
  id: uuid,
  type: z.enum(["export", "deletion"]),
  subject_ref: z.string(),
  status: z.string(),
  received_at: ts,
  due_at: ts,
  ms_remaining: z.number().nullable(),
  overdue: z.boolean(),
  ready_target_at: tsOrNull,
  ready_target_missed: z.boolean(),
  cooling_ends_at: tsOrNull,
  blockers: z.array(z.string()),
});
export type DsarItemWire = z.infer<typeof dsarItem>;
export const dsarQueue = z.object({
  summary: z.object({ open: z.number(), overdue: z.number(), due_within_24h: z.number(), by_kind: z.record(z.string(), z.number()) }),
  items: z.array(dsarItem),
});
const clock = z.object({
  due_at: tsOrNull,
  status: z.enum(["pending", "overdue", "met", "met_late", "not_required"]),
  ms_remaining: z.number().nullable(),
});
export const breachSchema = z.object({
  id: uuid,
  detected_at: ts,
  severity: z.string(),
  summary: z.string(),
  affected_count: z.number().int(),
  status: z.string(),
  dpo_decision: z.string().nullable(),
  triaged_at: tsOrNull,
  pdpc_notified_at: tsOrNull,
  subjects_notified_at: tsOrNull,
  closed_at: tsOrNull,
  clocks: z.object({ triage: clock, pdpc: clock, subjects: clock }),
});
export type BreachWire = z.infer<typeof breachSchema>;
export const breachList = z.object({ items: z.array(breachSchema) });

// ---- tax / ETA ------------------------------------------------------------------------------
const submission = z.object({
  state: z.enum(["QUEUED", "SUBMITTED", "ACCEPTED", "REJECTED", "RETRY", "DEAD_LETTER"]),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  next_attempt_at: ts,
  last_submitted_at: tsOrNull,
  last_error: z.string().nullable(),
  eta_uuid: z.string().nullable(),
  rejection_reasons: z.array(z.string()),
  decided_at: tsOrNull,
});
export const taxDocument = z.object({
  id: uuid,
  kind: z.enum(["seller_einvoice", "shopper_ereceipt", "seller_goods_ereceipt"]),
  source_ref: z.string(),
  issued_at: ts,
  totals: z.object({ net: money, vat: money, gross: money }),
  submission,
});
export type TaxDocumentWire = z.infer<typeof taxDocument>;
export const taxDocumentList = z.object({ items: z.array(taxDocument), page });
export const taxReconciliation = z.object({
  date: z.string(),
  documents: z.number().int(),
  counts: z.record(z.string(), z.number()),
  gross_by_state: z.record(z.string(), minor),
  submitted: z.number().int(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  acceptance_rate_bps: z.number().int().nullable(),
  discrepancies: z.array(z.object({ internal_id: z.string(), kind: z.string() })),
  reconciled: z.boolean(),
});
export type TaxReconciliationWire = z.infer<typeof taxReconciliation>;

// ---- finance --------------------------------------------------------------------------------
export const ledgerBalance = z.object({
  account: z.string(),
  type: z.string(),
  owner_type: z.string(),
  owner_id: z.string(),
  sub_key: z.string().nullable(),
  currency: z.string(),
  raw: minor,
  balance: minor,
  posting_count: z.number().int(),
});
export type LedgerBalanceWire = z.infer<typeof ledgerBalance>;
export const ledgerBalances = z.object({ items: z.array(ledgerBalance) });

/** openapi.yaml listAdminReconciliationBreaks (proposed; no controller yet). */
export const reconBreak = z.object({
  id: uuid,
  kind: z.enum(["psp_settlement", "courier_cod", "wallet_projection", "ledger_balance"]),
  status: z.enum(["open", "ticketed", "resolved"]),
  expected: money.optional(),
  actual: money.optional(),
  reference: z.string().optional(),
  detected_at: ts,
});
export type ReconBreakWire = z.infer<typeof reconBreak>;
export const reconBreakList = z.object({ items: z.array(reconBreak), page });

// ---- price integrity (openapi.yaml, proposed) ----------------------------------------------
export const priceAction = z.object({
  id: uuid,
  store_id: uuid,
  action: z.string(),
  reason_code: z.string(),
  config_version: z.number().int().optional(),
  evidence_ids: z.array(uuid).optional(),
  applied_at: ts,
  human_review_due_at: tsOrNull.optional(),
});
export type PriceActionWire = z.infer<typeof priceAction>;
export const priceActionList = z.object({ items: z.array(priceAction), page });

// ---- moderation / promotions ---------------------------------------------------------------
export const moderationItem = z.object({
  target_type: z.enum(["review", "review_reply", "question", "answer"]),
  target_id: uuid,
  status: z.string(),
  hold_reason: z.string().nullable(),
  text: z.string().nullable(),
  photo_ids: z.array(z.string()),
  product_id: uuid.nullable(),
  store_id: uuid.nullable(),
  created_at: ts,
});
export type ModerationItemWire = z.infer<typeof moderationItem>;
export const moderationQueue = z.object({ items: z.array(moderationItem), page });
export const moderationDecisionResult = z.object({ status: z.string() });

export const promotionSchema = z.object({
  id: uuid,
  type: z.string(),
  title: z.object({ ar: z.string(), en: z.string().optional() }),
  code: z.string().optional(),
  auto_apply: z.boolean().optional(),
  funding: z.object({ platform_pct: z.number().int(), seller_pct: z.number().int() }),
  total_budget: money.optional(),
  starts_at: ts,
  ends_at: ts,
  status: z.enum(["draft", "scheduled", "active", "paused", "ended"]),
  version: z.number().int(),
});
export type PromotionWire = z.infer<typeof promotionSchema>;
export const promotionList = z.object({ items: z.array(promotionSchema), page });

// ---- Phase 2 (docs/api/openapi.yaml admin paths) --------------------------------------------
const minorUnsigned = z.string().regex(/^\d{1,18}$/);
export const plusPlanSchema = z.object({
  id: z.string(),
  code: z.string(),
  interval: z.enum(["month", "year"]),
  price: z.object({ amount_minor: minorUnsigned, currency: z.literal("EGP") }),
  trial_days: z.number().int(),
  version: z.number().int(),
  active: z.boolean(),
  effective_from: ts,
  members_notified_at: tsOrNull,
});
export type PlusPlanWire = z.infer<typeof plusPlanSchema>;
export const plusPlanList = z.object({ items: z.array(plusPlanSchema) });
export const plusPlanPublished = z.object({ plan: plusPlanSchema, members_notified: z.number().int().optional() });
export const plusPlanResult = z.object({ plan: plusPlanSchema });

export const rewardsConfig = z.object({
  version: z.number().int(),
  piastres_per_coin: minorUnsigned,
  purchase_bps: minorUnsigned,
  plus_bonus_bps: minorUnsigned,
  review_base_coins: minorUnsigned,
  review_photo_coins: minorUnsigned,
  review_fit_coins: minorUnsigned,
  profile_completion_coins: minorUnsigned,
  fit_feedback_coins: minorUnsigned,
  max_coins_per_event: minorUnsigned,
  expiry_months: z.number().int(),
  expiring_notice_days: z.number().int(),
  silver_from: minorUnsigned,
  gold_from: minorUnsigned,
  black_from: minorUnsigned,
  tier_downgrade_notice_days: z.number().int(),
  streak_milestones: z.array(z.object({ months: z.number().int(), coins: minorUnsigned })),
  daily_plays_per_game: z.number().int(),
  odds_publish_lead_hours: z.number().int(),
  max_game_coins: minorUnsigned,
});
export type RewardsConfigWire = z.infer<typeof rewardsConfig>;
export const gameOddsPublished = z.object({ odds_version_id: z.string(), version: z.number().int(), effective_from: ts });
export const dropControlResult = z.object({ id: uuid, state: z.string(), paused: z.boolean() });
export const priceMatchingConfig = z.object({
  tau_bp: z.number().int(),
  shadow_only: z.boolean(),
  version: z.number().int(),
  labelled_pairs: z.number().int(),
  kappa_milli: z.number().int(),
});
export type PriceMatchingConfigWire = z.infer<typeof priceMatchingConfig>;
export const adsConfig = z.object({
  floor_price: money,
  slots: z.number().int(),
  pricing: z.enum(["gsp", "first_price"]),
  frequency_cap_per_session_day: z.number().int(),
  click_token_ttl_ms: z.number().int(),
  click_dedupe_window_ms: z.number().int(),
  min_dwell_ms: z.number().int(),
  max_clicks_per_session_per_minute: z.number().int(),
  max_clicks_per_campaign_session_day: z.number().int(),
  bot_score_block_bps: z.number().int(),
  vat_bps: z.number().int(),
  min_top_up: money,
  max_top_up: money,
});
export type AdsConfigWire = z.infer<typeof adsConfig>;

/** `outlet.dora.report/v1` (docs/engineering/dora.md). null means "not measurable", never zero. */
const band = z.enum(["elite", "high", "medium", "low"]);
export const doraReport = z.object({
  schema: z.literal("outlet.dora.report/v1"),
  generatedAt: ts,
  window: z.object({ from: ts, to: ts, days: z.number().int() }),
  source: z.object({
    mode: z.enum(["offline", "github"]),
    deploymentProxy: z.enum(["github-deployment", "tag", "commit"]),
    repo: z.string().nullable(),
    ref: z.string(),
    commitsInWindow: z.number().int(),
  }),
  metrics: z.object({
    deploymentFrequency: z.object({ count: z.number(), perDay: z.number(), perWeek: z.number(), band }),
    leadTimeForChanges: z.object({ medianHours: z.number(), p90Hours: z.number(), sampleSize: z.number(), basis: z.string(), band }).nullable(),
    changeFailureRate: z.object({ ratio: z.number().nullable(), failures: z.number(), deployments: z.number(), basis: z.string(), band: band.nullable() }),
    timeToRecover: z.object({ medianHours: z.number(), sampleSize: z.number(), basis: z.string(), band }).nullable(),
    reworkRate: z.object({ ratio: z.number().nullable(), reworkCommits: z.number(), changeCommits: z.number(), windowDays: z.number(), basis: z.string() }),
  }),
  series: z.array(z.object({ weekStart: z.string(), deployments: z.number(), failures: z.number(), rework: z.number() })),
  notes: z.array(z.string()),
});
export type DoraReport = z.infer<typeof doraReport>;
export const anyObject = z.looseObject({});
