import type { z } from "zod";
import type { admin } from "@outlet/domain";
import { err, ok, type Result } from "../lib/result";
import type { SessionPort } from "../session/port";
import * as B from "./brand-schemas";
import * as P3 from "./phase3-schemas";
import * as S from "./schemas";
import { NetworkError, type Transport, type TransportRequest } from "./transport";

export type ApiErrorKind =
  | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "validation" | "conflict"
  | "offline" | "server" | "contract" | "not_configured" | "unavailable";

export interface ApiError {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
}

export interface ApiOk<T> {
  readonly data: T;
  /** Server clock from the HTTP Date header, for deadlines and clocks (never the device clock). */
  readonly serverNowMs: number | null;
}
export type ApiResult<T> = Result<ApiOk<T>, ApiError>;

export interface ClientDeps {
  readonly transport: Transport;
  readonly session: SessionPort;
  readonly newIdempotencyKey: () => string;
}

const kindFor = (status: number): ApiErrorKind => {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "validation";
  if (status === 503) return "unavailable";
  return "server";
};

const parseDate = (h: string | undefined): number | null => {
  if (h === undefined) return null;
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : t;
};

/**
 * Typed Admin API client. The API is the authority: this client never decides access, it only maps outcomes.
 * Mutating calls always carry an Idempotency-Key; a retry after a 401 reuses the same key.
 */
export function createAdminApi(deps: ClientDeps) {
  async function exec(req: TransportRequest, write: boolean, key?: string, retried = false): Promise<
    Result<{ status: number; json?: unknown; serverNowMs: number | null }, ApiError>
  > {
    const state = await deps.session.current();
    if (state === null) return err({ kind: "unauthorized", status: 401 });
    const headers: Record<string, string> = { ...req.headers, authorization: `Bearer ${state.accessToken}` };
    if (write) headers["idempotency-key"] = key ?? deps.newIdempotencyKey();
    let res;
    try {
      res = await deps.transport.send({ ...req, headers });
    } catch (e) {
      if (e instanceof NetworkError) return err({ kind: "offline" });
      throw e;
    }
    if (res.status === 401 && !retried) {
      const r = await deps.session.refresh();
      if (r.ok) return exec(req, write, headers["idempotency-key"], true);
      return err({ kind: "unauthorized", status: 401 });
    }
    if (res.status >= 200 && res.status < 300) {
      return ok({ status: res.status, ...(res.json === undefined ? {} : { json: res.json }), serverNowMs: parseDate(res.headers.date) });
    }
    const p = S.problemSchema.safeParse(res.json);
    const base: ApiError = { kind: kindFor(res.status), status: res.status };
    if (!p.success) return err(base);
    return err({
      ...base,
      ...(p.data.code === undefined ? {} : { code: p.data.code }),
      ...(p.data.request_id === undefined ? {} : { requestId: p.data.request_id }),
    });
  }

  async function call<T extends z.ZodType>(schema: T, req: TransportRequest, write = false, key?: string): Promise<ApiResult<z.output<T>>> {
    const r = await exec(req, write, key);
    if (!r.ok) return r;
    const parsed = schema.safeParse(r.value.json);
    if (!parsed.success) return err({ kind: "contract", status: r.value.status });
    return ok({ data: parsed.data as z.output<T>, serverNowMs: r.value.serverNowMs });
  }

  const enc = encodeURIComponent;
  type Reason = admin.AdminReasonCode;

  return {
    me: () => call(S.adminMe, { method: "GET", path: "/v1/admin/me" }),

    // approvals
    approvals: (q: { state?: ApprovalState; kind?: admin.ApprovalKind; mine?: boolean } = {}) =>
      call(S.approvalList, {
        method: "GET",
        path: "/v1/admin/approvals",
        query: { state: q.state, kind: q.kind, mine: q.mine === undefined ? undefined : String(q.mine), limit: 100 },
      }),
    requestApproval: (b: {
      kind: admin.ApprovalKind; subject_type: string; subject_id: string; amount_minor?: string; reason_code: Reason;
    }) => call(S.approvalCreated, { method: "POST", path: "/v1/admin/approvals", body: b }, true),
    approve: (id: string, note?: string) =>
      call(S.approvalSchema, { method: "POST", path: `/v1/admin/approvals/${enc(id)}/approve`, body: note === undefined ? {} : { note } }, true),
    reject: (id: string, note?: string) =>
      call(S.approvalSchema, { method: "POST", path: `/v1/admin/approvals/${enc(id)}/reject`, body: note === undefined ? {} : { note } }, true),

    // elevations
    myElevations: () => call(S.elevationList, { method: "GET", path: "/v1/admin/elevations/mine" }),
    activeElevations: () => call(S.elevationList, { method: "GET", path: "/v1/admin/elevations" }),
    requestElevation: (b: { role: admin.AdminRoleName; reason_code: Reason; ttl_minutes?: number }) =>
      call(S.elevationSchema, { method: "POST", path: "/v1/admin/elevations", body: b }, true),
    activateElevation: (id: string) =>
      call(S.elevationSchema, { method: "POST", path: `/v1/admin/elevations/${enc(id)}/activate`, body: {} }, true),
    revokeElevation: (id: string) =>
      call(S.elevationSchema, { method: "POST", path: `/v1/admin/elevations/${enc(id)}/revoke`, body: {} }, true),

    // PII
    viewPii: (b: { subject_user_id: string; fields: readonly string[]; reason_code: Reason }) =>
      call(S.piiViewResult, { method: "POST", path: "/v1/admin/pii-views", body: b }, true),

    // flags
    flags: (kind?: "kill_switch" | "release") =>
      call(S.flagList, { method: "GET", path: "/v1/admin/flags", query: { kind } }),
    killSwitches: () => call(S.flagList, { method: "GET", path: "/v1/admin/kill-switches" }),
    setFlag: (key: string, enabled: boolean, reason_code: Reason) =>
      call(S.flagSetResult, { method: "PUT", path: `/v1/admin/flags/${enc(key)}`, body: { enabled, reason_code } }, true),

    // KYC
    kycQueue: (state?: string) => call(S.kycQueue, { method: "GET", path: "/v1/admin/kyc/queue", query: { state, limit: 100 } }),
    suspendSeller: (sellerId: string, reason_code: Reason) =>
      call(S.kycTransition, { method: "POST", path: `/v1/admin/kyc/sellers/${enc(sellerId)}/suspend`, body: { reason_code } }, true),
    reinstateSeller: (sellerId: string, reason_code: Reason) =>
      call(S.kycTransition, { method: "POST", path: `/v1/admin/kyc/sellers/${enc(sellerId)}/reinstate`, body: { reason_code } }, true),
    suspensionReviews: (state?: "OPEN" | "UPHELD" | "REINSTATED") =>
      call(S.reviewList, { method: "GET", path: "/v1/admin/kyc/suspension-reviews", query: { state, limit: 100 } }),
    upholdSuspension: (reviewId: string) =>
      call(S.reviewSchema, { method: "POST", path: `/v1/admin/kyc/suspension-reviews/${enc(reviewId)}/uphold`, body: {} }, true),

    // privacy / DPO
    dsarQueue: (q: { overdue?: boolean } = {}) =>
      call(S.dsarQueue, { method: "GET", path: "/v1/admin/privacy/requests", query: { overdue: q.overdue === undefined ? undefined : String(q.overdue), limit: 200 } }),
    breaches: () => call(S.breachList, { method: "GET", path: "/v1/admin/privacy/breaches" }),
    breachStep: (id: string, step: "pdpc-notified" | "subjects-notified" | "close") =>
      call(S.breachSchema, { method: "POST", path: `/v1/admin/privacy/breaches/${enc(id)}/${step}`, body: {} }, true),
    breachTriage: (id: string, decision: "notify" | "no_notification_required") =>
      call(S.breachSchema, { method: "POST", path: `/v1/admin/privacy/breaches/${enc(id)}/triage`, body: { decision } }, true),

    // tax / ETA
    taxDocuments: (q: { state?: string; cursor?: string } = {}) =>
      call(S.taxDocumentList, { method: "GET", path: "/v1/admin/tax/documents", query: { state: q.state, cursor: q.cursor, limit: 50 } }),
    taxReconciliation: (date: string) =>
      call(S.taxReconciliation, { method: "GET", path: "/v1/admin/tax/reconciliation", query: { date } }),
    requeueSubmission: (documentId: string) =>
      call(S.taxDocument, { method: "POST", path: `/v1/admin/tax/submissions/${enc(documentId)}/requeue`, body: {} }, true),

    // finance
    ledgerBalances: (limit = 200) => call(S.ledgerBalances, { method: "GET", path: "/v1/admin/ledger/balances", query: { limit } }),
    reconciliationBreaks: () => call(S.reconTicketList, { method: "GET", path: "/v1/admin/finance/reconciliation/tickets", query: { limit: 100 } }),

    payoutsSummary: () => call(S.payoutSummary, { method: "GET", path: "/v1/admin/finance/payouts/summary" }),
    /** Single-source attention counts (404 while release.admin.attention is blocked). Not wired into the home page yet. */
    attention: () => call(S.attentionResponse, { method: "GET", path: "/v1/admin/attention" }),

    // price integrity
    priceActions: () => call(S.priceActionList, { method: "GET", path: "/v1/admin/price-integrity/actions", query: { limit: 100 } }),

    // Phase 2
    plusPlans: () => call(S.plusPlanList, { method: "GET", path: "/v1/admin/plus/plans" }),
    publishPlusPlan: (b: {
      code: string; interval: "month" | "year"; price_minor: string; trial_days: number; effective_from: string; approval_id: string;
      kind?: "individual" | "family" | "student"; seat_limit?: number;
    }) =>
      call(S.plusPlanPublished, { method: "POST", path: "/v1/admin/plus/plans", body: b }, true),
    setPlusPlanActive: (planId: string, active: boolean) =>
      call(S.plusPlanResult, { method: "PATCH", path: `/v1/admin/plus/plans/${enc(planId)}`, body: { active } }, true),
    rewardsConfig: () => call(S.rewardsConfig, { method: "GET", path: "/v1/admin/rewards/config" }),
    putRewardsConfig: (b: Record<string, unknown>) => call(S.rewardsConfig, { method: "PUT", path: "/v1/admin/rewards/config", body: b }, true),
    publishGameOdds: (game: "daily_spin" | "scratch_card", b: { approval_id: string; outcomes: readonly object[] }) =>
      call(S.gameOddsPublished, { method: "POST", path: `/v1/admin/games/${enc(game)}/odds`, body: b }, true),
    controlDrop: (id: string, action: "pause" | "resume" | "end") =>
      call(S.dropControlResult, { method: "POST", path: `/v1/admin/drops/${enc(id)}/pause`, body: { action } }, true),
    priceMatchingConfig: () => call(S.priceMatchingConfig, { method: "GET", path: "/v1/admin/price-matching/config" }),
    voidGiftCard: (id: string) => call(S.anyObject, { method: "POST", path: `/v1/gift-cards/${enc(id)}/void`, body: {} }, true),
    adsConfig: () => call(S.adsConfig, { method: "GET", path: "/v1/admin/ads/config" }),

    // Phase 3: creators, creator payouts (operations listCreatorsForReview .. recordCreatorPayoutOutcome), ranking v2
    creators: (status?: P3.CreatorStatus) =>
      call(P3.creatorAccountList, { method: "GET", path: "/v1/admin/creators", query: { status, limit: 50 } }),
    decideCreator: (id: string, action: P3.CreatorDecision, reason: string | null) =>
      call(P3.creatorAccount, { method: "POST", path: `/v1/admin/creators/${enc(id)}/decision`, body: { action, reason } }, true),
    creatorPayouts: (q: { status?: P3.CreatorPayoutState; creator_id?: string } = {}) =>
      call(P3.creatorPayoutList, { method: "GET", path: "/v1/admin/creator-payouts", query: { status: q.status, creator_id: q.creator_id, limit: 50 } }),
    createCreatorPayout: (creator_id: string) =>
      call(P3.creatorPayout, { method: "POST", path: "/v1/admin/creator-payouts", body: { creator_id } }, true),
    approveCreatorPayout: (id: string) => call(P3.creatorPayout, { method: "POST", path: `/v1/admin/creator-payouts/${enc(id)}/approve`, body: {} }, true),
    cancelCreatorPayout: (id: string) => call(P3.creatorPayout, { method: "POST", path: `/v1/admin/creator-payouts/${enc(id)}/cancel`, body: {} }, true),
    sendCreatorPayout: (id: string) => call(P3.creatorPayout, { method: "POST", path: `/v1/admin/creator-payouts/${enc(id)}/send`, body: {} }, true),
    recordCreatorPayoutOutcome: (id: string, b: { outcome: "settled" | "rejected"; provider_ref?: string; reason?: string }) =>
      call(P3.creatorPayout, { method: "POST", path: `/v1/admin/creator-payouts/${enc(id)}/outcome`, body: b }, true),
    rankingShadowSummary: (windowHours = 24) =>
      call(P3.rankingShadowSummary, { method: "GET", path: "/v1/admin/ranking/shadow/summary", query: { window_hours: windowHours } }),
    rankingEvaluations: () => call(P3.rankingEvaluationList, { method: "GET", path: "/v1/admin/ranking/evaluations", query: { limit: 50 } }),
    runRankingEvaluation: (b: { request_key: string; candidate: string; baseline: string; seed?: number; requests?: number; k?: number }) =>
      call(P3.rankingEvaluationRun, { method: "POST", path: "/v1/admin/ranking/evaluations", body: b }, true),
    evaluateRankingGuardrails: (b: Record<string, unknown>) =>
      call(P3.guardrailDecision, { method: "POST", path: "/v1/admin/ranking/guardrails/evaluate", body: b }, true),

    // moderation / promotions
    moderationQueue: (status: "HELD" | "SUBMITTED" | "AUTO_CHECKED" = "HELD") =>
      call(S.moderationQueue, { method: "GET", path: "/v1/admin/moderation/queue", query: { status, limit: 50 } }),
    moderate: (targetType: string, targetId: string, decision: "publish" | "reject") =>
      call(S.moderationDecisionResult, { method: "POST", path: `/v1/admin/moderation/${enc(targetType)}/${enc(targetId)}/decision`, body: { decision } }, true),
    promotions: () => call(S.promotionList, { method: "GET", path: "/v1/admin/promotions", query: { limit: 50 } }),

    // brand application review (docs/specs/admin-brand-review-web.md). Every write takes the form's own Idempotency-Key so a double submit replays.
    brandQueue: (q: {
      status?: B.BrandStatus; kind?: B.BrandKind; country?: string; assignee?: "me" | "unassigned" | "any";
      sla_breached?: boolean; cursor?: string; limit?: number;
    } = {}) =>
      call(B.adminBrandApplicationList, {
        method: "GET",
        path: "/v1/admin/brand-applications",
        query: {
          status: q.status, kind: q.kind, country: q.country, assignee: q.assignee,
          sla_breached: q.sla_breached === undefined ? undefined : String(q.sla_breached), cursor: q.cursor, limit: q.limit ?? 50,
        },
      }),
    brandApplication: (id: string) => call(B.adminBrandApplication, { method: "GET", path: `/v1/admin/brand-applications/${enc(id)}` }),
    claimBrand: (id: string, key: string) =>
      call(B.adminBrandApplication, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/claim`, body: {} }, true, key),
    releaseBrand: (id: string, key: string) =>
      call(B.adminBrandApplication, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/release`, body: {} }, true, key),
    decideBrand: (id: string, body: Record<string, unknown>, key: string) =>
      call(B.adminBrandApplication, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/decision`, body }, true, key),
    cosignBrand: (id: string, internal_note: string, key: string) =>
      call(B.adminBrandApplication, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/cosign`, body: { internal_note } }, true, key),
    brandDocumentReadUrl: (id: string, documentId: string, reason_code: B.DocumentReadReason, key: string) =>
      call(B.documentReadUrl, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/documents/${enc(documentId)}/read-url`, body: { reason_code } }, true, key),
    brandTrademarkLookup: (id: string, key: string) =>
      call(B.trademarkEvidence, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/trademark-lookup`, body: { mode: "auto" } }, true, key),
    resolveBrandConflict: (id: string, outcome: B.ConflictOutcome, internal_note: string, key: string) =>
      call(B.adminBrandApplication, { method: "POST", path: `/v1/admin/brand-applications/${enc(id)}/conflict-resolution`, body: { outcome, internal_note } }, true, key),
  };
}

type ApprovalState = "REQUESTED" | "APPROVED" | "REJECTED" | "EXPIRED";
export type AdminApi = ReturnType<typeof createAdminApi>;
