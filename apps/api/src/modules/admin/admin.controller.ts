import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { SellerStore } from "@outlet/catalog";
import { KILL_SWITCHES, isKillSwitchName } from "@outlet/flags";
import type { KillSwitchName } from "@outlet/flags";
import { getMarket } from "@outlet/markets-config";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { Authorize, Contract, Paginated, RateLimit, ReasonCode } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { ProblemError, Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import type { ResourceResolver } from "../../platform/decorators.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import {
  AdminKycCase, ApprovalDecisionInput, ApprovalExecuteInput, ApprovalIdParams, ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseIdParams, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput,
  KycDecisionResult, ReconciliationItemPage, ReconciliationRunPage, RolePage, RolesQuery, RunIdParams, RunsQuery,
} from "./dto.js";
import {
  AuditLogEntryPage, AuditQuery, AuditVerifyQuery, AuditVerifyResult, ElevationDecisionInput, ElevationDto, ElevationIdParams, ElevationPage, ElevationRequestInput, ElevationsQuery,
   FeatureFlagDto, FeatureFlagPage, FlagKeyParams, FlagsQuery, KillSwitchInput, PiiAccessLogEntryPage, PiiAccessLogQuery, StoreIdParams, StoreReinstateInput, StoreSuspendInput } from "./dto-ops.js";
import { DashboardService } from "./dashboard.js";
import { DlqActionResult, DlqDiscardInput, DlqPage, DlqQuery, DlqReplayInput } from "./dto-dlq.js";
import type { DlqAdminPort } from "./dlq-admin.js";
import { isMoneyEventType } from "@outlet/outbox";
import type { DiscardReasonCode } from "@outlet/outbox";
import {
  AttentionAckInput, AttentionIdParams, AttentionItemDto, AttentionItemPage, AttentionQuery, AttentionResolveInput, DashboardQuery, DashboardResponse,
} from "./dto-dashboard.js";
import type { AttentionAdminPort } from "./attention-admin.js";
import { flagOf, flagPage } from "./ops-services.js";
import { rolePage } from "./roles.js";
import type { AdminOpsServices, ElevationReaderPort } from "./ops-services.js";
import type { StoreModerationPort } from "./store-moderation.js";
import type { AdminServices } from "./services.js";

/** Admin routes act on the staff's market as a whole; there is no object-level resolver (ids are checked against the market by the services: foreign id = 404). */
const market: ResourceResolver = (c) => ({ type: "admin_console", marketId: c.marketId });

/** Approval requests are market-scoped: the service re-checks the request's own action role and 404s foreign ids. */
const approvalResource: ResourceResolver = (c) => ({ type: "approval_request", marketId: c.marketId });

const ELEVATION_ACTION = "elevation.approve";
const KILL_RELEASE_ACTION = "kill_switch.engage";
const STORE_SUSPEND_ACTION = "store.suspend";
const STORE_REINSTATE_ACTION = "store.reinstate";
const DLQ_DISCARD_MONEY_ACTION = "dlq.discard.money";
/** The ids and reason the requester filed (hash-checked payload of the approval request); anything malformed is a 422, never executed. */
const dlqPayload = (payload: Readonly<Record<string, unknown>>): DlqDiscardInput => {
  const r = DlqDiscardInput.safeParse({ ids: payload.ids, reason_code: payload.reasonCode });
  if (!r.success) throw Problems.unprocessable("invalid-approval-payload");
  return r.data;
};
/** The reason and note the requester filed (hash-checked payload of the approval request); anything malformed is a 422, never executed. */
const moderationPayload = (payload: Readonly<Record<string, unknown>>): { reasonCode: string; note: string; storeIds: readonly string[] } => {
  const { reasonCode, note, storeIds } = payload;
  if (typeof reasonCode !== "string" || typeof note !== "string") throw Problems.unprocessable("invalid-approval-payload");
  if (!Array.isArray(storeIds) || storeIds.length === 0 || storeIds.length > 200 || !storeIds.every((x) => typeof x === "string")) throw Problems.unprocessable("invalid-approval-payload");
  return { reasonCode, note, storeIds };
};
const releaseReason = (payload: Readonly<Record<string, unknown>>): string => (typeof payload.reason === "string" && payload.reason.length >= 3 ? payload.reason : "approved release");

interface Staff { readonly principal: Principal; readonly marketId: string; readonly svc: AdminServices }

/**
 * Admin Console routes (tenant "admin": passkey session + live role grants/elevations from @outlet/admin-access, deny by default).
 * Policy actions are the ones @outlet/policy grants today: `approval.read`/`approval.decide` for the approval queue, `seller_kyc.review` for KYC,
 * `ledger.read` (reason code required, one audited reveal per read) for reconciliation.
 */
@Controller("v1/:market/admin")
export class AdminController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private staff(s: RequestState): Staff {
    if (s.principal === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, marketId: s.marketId, svc: this.deps.admin(s.marketId) };
  }

  private ops(t: Staff): AdminOpsServices {
    if (t.svc.ops === undefined) throw Problems.unavailable("admin-unavailable");
    return t.svc.ops;
  }

  private stores(t: Staff): StoreModerationPort {
    const s = this.ops(t).stores;
    if (s === undefined) throw Problems.unavailable("admin-unavailable");
    return s;
  }

  private attention(t: Staff): AttentionAdminPort {
    const a = this.ops(t).attention;
    if (a === undefined) throw Problems.unavailable("admin-unavailable");
    return a;
  }

  private dlq(t: Staff): DlqAdminPort {
    const d = this.ops(t).dlq;
    if (d === undefined) throw Problems.unavailable("admin-unavailable");
    return d;
  }

  // ---------------------------------------------------------------- dashboard (Home)

  @Get("dashboard")
  @Authorize("dashboard.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminDashboard })
  @Contract({
    operationId: "adminGetDashboard",
    summary: "Admin Home: today, sales, orders, money, trust, privacy and platform tiles. Each tile is authorized on its own action before it is read (forbidden = not computed); a failed or unconnected read is unavailable, never zero",
    tags: ["Admin Dashboard"],
    query: DashboardQuery,
    response: DashboardResponse,
    maxQueries: 10,
  })
  getDashboard(@Ctx() s: RequestState, @Query() q: DashboardQuery): Promise<DashboardResponse> {
    const t = this.staff(s);
    const svc = new DashboardService(t.svc, {
      now: () => this.deps.clock.now(), logger: this.deps.logger,
      market: (id) => {
        const m = getMarket(id.toLowerCase());
        return { timezone: m.timezone, currency: m.currency };
      },
    });
    return svc.build(t.principal, t.marketId, q);
  }

  // ---------------------------------------------------------------- ops attention queue (money / cancellation work parked for a human)

  @Get("attention")
  @Paginated()
  @Authorize("attention.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListAttention", summary: "Open and acknowledged attention items, newest first (ids and short codes only)", tags: ["Admin Attention"], query: AttentionQuery, response: AttentionItemPage, maxQueries: 3 })
  listAttention(@Ctx() s: RequestState, @Query() q: AttentionQuery): Promise<AttentionItemPage> {
    const t = this.staff(s);
    return this.attention(t).list(t.principal, q);
  }

  @Post("attention/:attention_id/ack")
  @HttpCode(200)
  @Authorize("attention.write", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({ operationId: "adminAckAttention", summary: "Acknowledge an attention item (OPEN to ACKED; audited in the same transaction; acking again is an unchanged success, a resolved item is 409)", tags: ["Admin Attention"], params: AttentionIdParams, body: AttentionAckInput, response: AttentionItemDto, maxQueries: 8 })
  ackAttention(@Ctx() s: RequestState, @Params() p: AttentionIdParams): Promise<AttentionItemDto> {
    const t = this.staff(s);
    return this.attention(t).ack(t.principal, p.attention_id);
  }

  @Post("attention/:attention_id/resolve")
  @HttpCode(200)
  @Authorize("attention.write", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({ operationId: "adminResolveAttention", summary: "Resolve an attention item with a fixed code (audited in the same transaction; the same code again is an unchanged success, another code is 409)", tags: ["Admin Attention"], params: AttentionIdParams, body: AttentionResolveInput, response: AttentionItemDto, maxQueries: 8 })
  resolveAttention(@Ctx() s: RequestState, @Params() p: AttentionIdParams, @Body() body: AttentionResolveInput): Promise<AttentionItemDto> {
    const t = this.staff(s);
    return this.attention(t).resolve(t.principal, p.attention_id, body.resolution_code);
  }

  // ---------------------------------------------------------------- approval requests (dual approval queue)

  @Get("approval-requests")
  @Paginated()
  @Authorize("approval.read", approvalResource, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListApprovalRequests", summary: "Dual-approval queue (status, action filters)", tags: ["Admin Approvals"], query: ApprovalsQuery, response: ApprovalRequestPage, maxQueries: 4 })
  listApprovals(@Ctx() s: RequestState, @Query() q: ApprovalsQuery): Promise<ApprovalRequestPage> {
    const t = this.staff(s);
    return t.svc.approvals.list(t.principal, q);
  }

  @Post("approval-requests/:approval_request_id/decision")
  @HttpCode(200)
  @Authorize("approval.decide", approvalResource, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminDecideApprovalRequest",
    summary: "Approve or reject (the requester can never decide; the action's own role is re-checked)",
    tags: ["Admin Approvals"],
    params: ApprovalIdParams,
    body: ApprovalDecisionInput,
    response: ApprovalRequestDto,
    maxQueries: 12,
  })
  async decideApproval(@Ctx() s: RequestState, @Params() p: ApprovalIdParams, @Body() body: ApprovalDecisionInput): Promise<ApprovalRequestDto> {
    const t = this.staff(s);
    if (body.decision === "approve") await t.svc.access.approve(t.principal, p.approval_request_id, body.reason);
    else await t.svc.access.reject(t.principal, p.approval_request_id, body.reason);
    const decided = await t.svc.approvals.get(t.principal, p.approval_request_id);
    // A fully approved request applies right away; if that step fails the request stays APPROVED (executed_at NULL) and POST approval-requests/{id}/execute retries it.
    if (decided.status === "APPROVED") await this.applyApproved(t, decided);
    return t.svc.approvals.get(t.principal, p.approval_request_id);
  }

  /** Runs the action of an APPROVED request exactly once (the executed_at claim and the effect share one tx, so a failure releases the claim and a replay is a no-op). */
  private async applyApproved(t: Staff, decided: ApprovalRequestDto): Promise<boolean> {
    if (decided.action === KILL_RELEASE_ACTION) {
      await t.svc.access.executeApproval(t.principal, decided.id, async (req, tx) => {
        if (!isKillSwitchName(req.targetId)) throw Problems.unprocessable("unknown-kill-switch");
        await this.ops(t).flags.set(t.principal, req.targetId, true, releaseReason(req.payload), tx);
      });
    } else if (decided.action === STORE_SUSPEND_ACTION || decided.action === STORE_REINSTATE_ACTION) {
      const stores = this.stores(t);
      // The effects run under other database roles, so they cannot share the claim transaction: prove the request first, apply the idempotent effects, then claim + audit.
      const req = await t.svc.access.verifyApproved(t.principal, decided.id);
      const to = decided.action === STORE_SUSPEND_ACTION ? "SUSPENDED" : "ACTIVE";
      const applied = await stores.apply(t.principal, req.targetId, to, { ...moderationPayload(req.payload), approvalRequestId: req.id });
      await t.svc.access.executeApproval(t.principal, decided.id, async (_req, tx) => {
        await stores.record(t.principal, tx, applied);
      });
    } else if (decided.action === DLQ_DISCARD_MONEY_ACTION) {
      const dlq = this.dlq(t);
      // The effect runs as the outbox.relay worker job (another role), so like store moderation it goes first and is idempotent; then claim + audit share one transaction.
      const req = await t.svc.access.verifyApproved(t.principal, decided.id);
      const input = dlqPayload(req.payload);
      const applied = await dlq.discard(t.principal, input.ids, input.reason_code);
      await t.svc.access.executeApproval(t.principal, decided.id, async (_req, tx) => {
        await dlq.record(t.principal, applied, { reasonCode: input.reason_code, approvalRequestId: req.id }, tx);
      });
    } else if (decided.action === ELEVATION_ACTION) {
      // The executor is the last approver, never the requester.
      await t.svc.access.activateElevation(t.principal, decided.id);
    } else return false;
    return true;
  }

  @Post("approval-requests/:approval_request_id/execute")
  @HttpCode(200)
  @Authorize("approval.decide", approvalResource, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminExecuteApprovalRequest",
    summary: "Run an APPROVED request that was not executed (recovery after a failure between the last vote and execution); idempotent, requester excluded, the action's own role re-checked",
    tags: ["Admin Approvals"],
    params: ApprovalIdParams,
    body: ApprovalExecuteInput,
    response: ApprovalRequestDto,
    maxQueries: 12,
  })
  async executeApproval(@Ctx() s: RequestState, @Params() p: ApprovalIdParams): Promise<ApprovalRequestDto> {
    const t = this.staff(s);
    const req = await t.svc.approvals.get(t.principal, p.approval_request_id);
    if (req.status !== "APPROVED") throw new ProblemError(409, "approval-not-approved", "The request is not approved or was already executed");
    if (req.requested_by === t.principal.userId) throw Problems.forbidden();
    if (!(await this.applyApproved(t, req))) throw Problems.unprocessable("no-executor-for-action");
    return t.svc.approvals.get(t.principal, p.approval_request_id);
  }

  // ---------------------------------------------------------------- seller KYC

  @Get("kyc-cases")
  @Paginated()
  @Authorize("seller_kyc.review", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListKycCases", summary: "Submitted KYC cases (newest first)", tags: ["Admin KYC"], query: KycCasesQuery, response: KycCaseSummaryPage, maxQueries: 3 })
  listKyc(@Ctx() s: RequestState, @Query() q: KycCasesQuery): Promise<KycCaseSummaryPage> {
    const t = this.staff(s);
    return t.svc.kyc.list(t.marketId, q);
  }

  @Get("kyc-cases/:kyc_case_id")
  @ReasonCode()
  @Authorize("seller_kyc.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminGetKycCase", summary: "One KYC case with documents, checks and the seller's legal identity (reason code required; every read is logged in pii_access_log)", tags: ["Admin KYC"], params: KycCaseIdParams, response: AdminKycCase, maxQueries: 4 })
  async getKyc(@Ctx() s: RequestState, @Params() p: KycCaseIdParams): Promise<AdminKycCase> {
    const t = this.staff(s);
    // Logged before any data leaves (the entry carries ids and the code, never the data viewed).
    await t.svc.access.recordPiiView(t.principal, { action: "seller_kyc.read", targetType: "kyc_case", targetId: p.kyc_case_id }, s.reasonCode);
    const detail = await t.svc.kyc.detail(t.marketId, p.kyc_case_id);
    if (detail === null) throw Problems.notFound();
    return detail;
  }

  @Post("kyc-cases/:kyc_case_id/decision")
  @HttpCode(200)
  @Authorize("seller_kyc.review", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminDecideKycCase",
    summary: "Approve, request info or reject a case in AUTO_CHECKS (runs as the seller.kyc worker job)",
    tags: ["Admin KYC"],
    params: KycCaseIdParams,
    body: KycDecisionInput,
    response: KycDecisionResult,
    maxQueries: 5,
  })
  decideKyc(@Ctx() s: RequestState, @Params() p: KycCaseIdParams, @Body() body: KycDecisionInput): Promise<KycDecisionResult> {
    const t = this.staff(s);
    return t.svc.kyc.decide(t.principal, p.kyc_case_id, body);
  }

  // ---------------------------------------------------------------- store moderation (always dual approval)

  /** Both routes only file the dual-approval request (409 dual-approval-required, request id in `detail`); the effect runs when the second approver votes. */
  private async fileStoreRequest(t: Staff, storeId: string, action: string, payload: Record<string, unknown>, from: readonly string[]): Promise<never> {
    const port = this.stores(t);
    const store = await port.get(t.principal, storeId);
    if (!from.includes(store.status)) throw new ProblemError(409, "invalid-transition", `The store is ${store.status}`);
    // The exact store set goes into the hash-protected payload: the approvers vote on it and the executor acts on nothing else.
    const storeIds = await port.targets(t.principal, storeId, action === STORE_SUSPEND_ACTION ? "SUSPENDED" : "ACTIVE");
    const r = await t.svc.access.requireApproval(t.principal, { action, targetType: "store", targetId: storeId, payload: { ...payload, storeIds } });
    if (!r.required) throw Problems.internal("dual-approval-expected");
    throw new ProblemError(409, "dual-approval-required", "A second approver is required", { detail: r.request.id });
  }

  @Post("stores/:store_id/suspend")
  @HttpCode(200)
  @Authorize("store.suspend", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminSuspendStore",
    summary: "Suspend a store (human decision; always dual approval: this files the request, the second approver's vote runs it and hides the seller's stores)",
    tags: ["Admin KYC"],
    params: StoreIdParams,
    body: StoreSuspendInput,
    response: SellerStore,
    maxQueries: 8,
  })
  suspendStore(@Ctx() s: RequestState, @Params() p: StoreIdParams, @Body() body: StoreSuspendInput): Promise<SellerStore> {
    return this.fileStoreRequest(this.staff(s), p.store_id, STORE_SUSPEND_ACTION, { reasonCode: body.reason_code, note: body.note, ...(body.finding_id === undefined ? {} : { findingId: body.finding_id }) }, ["ACTIVE", "VACATION"]);
  }

  @Post("stores/:store_id/reinstate")
  @HttpCode(200)
  @Authorize("store.reinstate", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminReinstateStore",
    summary: "Reinstate a suspended store (always dual approval, like suspend)",
    tags: ["Admin KYC"],
    params: StoreIdParams,
    body: StoreReinstateInput,
    response: SellerStore,
    maxQueries: 8,
  })
  reinstateStore(@Ctx() s: RequestState, @Params() p: StoreIdParams, @Body() body: StoreReinstateInput): Promise<SellerStore> {
    return this.fileStoreRequest(this.staff(s), p.store_id, STORE_REINSTATE_ACTION, { reasonCode: body.reason_code, note: body.note }, ["SUSPENDED"]);
  }

  // ---------------------------------------------------------------- PII access log (DPO / security)

  @Get("privacy/pii-access-log")
  @Paginated()
  @Authorize("pii_access.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListPiiAccessLog", summary: "Who viewed personal data and why (ids and reason codes only; reading it is not itself a PII view)", tags: ["Admin DPO"], query: PiiAccessLogQuery, response: PiiAccessLogEntryPage, maxQueries: 3 })
  listPiiAccess(@Ctx() s: RequestState, @Query() q: PiiAccessLogQuery): Promise<PiiAccessLogEntryPage> {
    const t = this.staff(s);
    const reader = this.ops(t).piiAccess;
    if (reader === undefined) throw Problems.unavailable("admin-unavailable");
    return reader.list(t.principal, q);
  }

  // ---------------------------------------------------------------- reconciliation (finance, reason code, audited read)

  @Get("reconciliation/runs")
  @Paginated()
  @ReasonCode()
  @Authorize("ledger.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListReconciliationRuns", summary: "Reconciliation runs (source, business date filters)", tags: ["Admin Finance"], query: RunsQuery, response: ReconciliationRunPage, maxQueries: 3 })
  async listRuns(@Ctx() s: RequestState, @Query() q: RunsQuery): Promise<ReconciliationRunPage> {
    const t = this.staff(s);
    await t.svc.access.recordPiiView(t.principal, { action: "ledger.read", targetType: "reconciliation_runs", targetId: t.marketId }, s.reasonCode);
    return t.svc.reconciliation.listRuns(t.marketId, q);
  }

  @Get("reconciliation/runs/:reconciliation_run_id/items")
  @Paginated()
  @ReasonCode()
  @Authorize("ledger.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListReconciliationItems", summary: "Exceptions of one run, with age in days", tags: ["Admin Finance"], params: RunIdParams, query: ItemsQuery, response: ReconciliationItemPage, maxQueries: 3 })
  async listItems(@Ctx() s: RequestState, @Params() p: RunIdParams, @Query() q: ItemsQuery): Promise<ReconciliationItemPage> {
    const t = this.staff(s);
    await t.svc.access.recordPiiView(t.principal, { action: "ledger.read", targetType: "reconciliation_run", targetId: p.reconciliation_run_id }, s.reasonCode);
    const page = await t.svc.reconciliation.listItems(t.marketId, p.reconciliation_run_id, q, this.deps.clock.now());
    if (page === null) throw Problems.notFound();
    return page;
  }

  // ---------------------------------------------------------------- roles catalogue

  @Get("roles")
  @Paginated()
  @Authorize("rbac.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListRoles", summary: "Roles and their permissions (admin, then seller), straight from @outlet/policy", tags: ["Admin RBAC"], query: RolesQuery, response: RolePage, maxQueries: 3 })
  listRoles(@Ctx() s: RequestState, @Query() q: RolesQuery): RolePage {
    this.staff(s);
    return rolePage(q);
  }

  // ---------------------------------------------------------------- audit log

  @Get("audit-log")
  @Paginated()
  @Authorize("audit.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListAuditLog", summary: "Audit log (diffs redacted)", tags: ["Admin RBAC"], query: AuditQuery, response: AuditLogEntryPage, maxQueries: 4 })
  listAudit(@Ctx() s: RequestState, @Query() q: AuditQuery): Promise<AuditLogEntryPage> {
    const t = this.staff(s);
    return this.ops(t).audit.list(t.principal, q);
  }

  @Get("audit-log/verify")
  @Authorize("audit.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminVerify })
  @Contract({ operationId: "adminVerifyAuditLog", summary: "Re-hash the market's audit chain (a broken chain is ok:false with the first bad seq, not an error)", tags: ["Admin RBAC"], query: AuditVerifyQuery, response: AuditVerifyResult, maxQueries: 8 })
  verifyAudit(@Ctx() s: RequestState, @Query() q: AuditVerifyQuery): Promise<AuditVerifyResult> {
    const t = this.staff(s);
    return this.ops(t).audit.verify(t.principal, q);
  }

  // ---------------------------------------------------------------- just-in-time elevations

  private elevations(t: Staff): ElevationReaderPort {
    const e = this.ops(t).elevations;
    if (e === undefined) throw Problems.unavailable("admin-unavailable");
    return e;
  }

  /** Approvers see every elevation of the market; everyone else only their own. */
  private seesAll(t: Staff): boolean {
    return authorize(t.principal, "elevation.approve", { type: "admin_console", marketId: t.marketId }).effect === "allow";
  }

  @Get("elevations")
  @Paginated()
  @Authorize("elevation.request", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListElevations", summary: "Just-in-time elevations (own; all of the market for approvers)", tags: ["Admin RBAC"], query: ElevationsQuery, response: ElevationPage, maxQueries: 3 })
  listElevations(@Ctx() s: RequestState, @Query() q: ElevationsQuery): Promise<ElevationPage> {
    const t = this.staff(s);
    return this.elevations(t).list(t.principal, q, this.seesAll(t));
  }

  @Post("elevations")
  @HttpCode(201)
  @Authorize("elevation.request", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminRequestElevation",
    summary: "Ask for a role for 1 to 60 minutes (super_admin also files its dual-approval request)",
    tags: ["Admin RBAC"],
    body: ElevationRequestInput,
    response: ElevationDto,
    status: 201,
    maxQueries: 8,
  })
  async requestElevation(@Ctx() s: RequestState, @Body() body: ElevationRequestInput): Promise<ElevationDto> {
    const t = this.staff(s);
    const readers = this.elevations(t);
    const row = await t.svc.access.requestElevation(t.principal, body.role, { reason: body.reason, ttlMinutes: body.ttl_minutes });
    return readers.get(t.principal, row.id, true);
  }

  @Post("elevations/:elevation_id/decision")
  @HttpCode(200)
  @Authorize("elevation.approve", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminDecideElevation",
    summary: "Approve or reject a pending elevation (never your own; super_admin needs two approvers through its approval request)",
    tags: ["Admin RBAC"],
    params: ElevationIdParams,
    body: ElevationDecisionInput,
    response: ElevationDto,
    maxQueries: 8,
  })
  async decideElevation(@Ctx() s: RequestState, @Params() p: ElevationIdParams, @Body() body: ElevationDecisionInput): Promise<ElevationDto> {
    const t = this.staff(s);
    const readers = this.elevations(t);
    if (body.decision === "approve") await t.svc.access.approveElevation(t.principal, p.elevation_id);
    else await t.svc.access.rejectElevation(t.principal, p.elevation_id);
    return readers.get(t.principal, p.elevation_id, true);
  }

  // ---------------------------------------------------------------- feature flags and kill switches

  @Get("feature-flags")
  @Paginated()
  @Authorize("kill_switch.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListFeatureFlags", summary: "Feature flags and kill switches", tags: ["Admin RBAC"], query: FlagsQuery, response: FeatureFlagPage, maxQueries: 3 })
  async listFlags(@Ctx() s: RequestState, @Query() q: FlagsQuery): Promise<FeatureFlagPage> {
    const t = this.staff(s);
    return flagPage(await this.ops(t).flags.list(t.marketId), q);
  }

  // ---------------------------------------------------------------- relay dead-letter queue (ids, event types, attempts and error codes only; never a payload)

  @Get("dlq")
  @Paginated()
  @Authorize("dlq.manage", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListDlq", summary: "Dead-lettered outbox events, newest first (event type, attempts, error code; never the payload)", tags: ["Admin DLQ"], query: DlqQuery, response: DlqPage, maxQueries: 3 })
  listDlq(@Ctx() s: RequestState, @Query() q: DlqQuery): Promise<DlqPage> {
    const t = this.staff(s);
    return this.dlq(t).list(t.principal, q);
  }

  @Post("dlq/replay")
  @HttpCode(200)
  @Authorize("dlq.manage", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminReplayDlq",
    summary: "Send up to 50 dead-lettered events back to the relay (attempts reset; idempotent: an id not in the DLQ is reported not_in_dlq; no dual approval, redelivery is deduplicated by the consumers' inbox; audited as dlq.replayed)",
    tags: ["Admin DLQ"],
    body: DlqReplayInput,
    response: DlqActionResult,
    maxQueries: 6,
  })
  replayDlq(@Ctx() s: RequestState, @Body() body: DlqReplayInput): Promise<DlqActionResult> {
    const t = this.staff(s);
    return this.dlq(t).replay(t.principal, body.ids);
  }

  @Post("dlq/discard")
  @HttpCode(200)
  @Authorize("dlq.manage", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminDiscardDlq",
    summary: "Give up on up to 50 dead-lettered events with a fixed reason code (audited as dlq.discarded). A batch that contains a money event type (refund.*, promotions.*, payout.*, order_group.late_payment_refund) files a dual-approval request instead: 409 dual-approval-required with the request id in `detail`; the second approver's vote runs it",
    tags: ["Admin DLQ"],
    body: DlqDiscardInput,
    response: DlqActionResult,
    maxQueries: 8,
  })
  async discardDlq(@Ctx() s: RequestState, @Body() body: DlqDiscardInput): Promise<DlqActionResult> {
    const t = this.staff(s);
    const dlq = this.dlq(t);
    const types = await dlq.types(t.principal, body.ids);
    if ([...types.values()].some(isMoneyEventType)) {
      // The set of ids goes into the hash-protected payload: the approvers vote on it and the executor acts on nothing else.
      const r = await t.svc.access.requireApproval(t.principal, { action: DLQ_DISCARD_MONEY_ACTION, targetType: "dlq_batch", targetId: body.ids[0] ?? t.marketId, payload: { ids: body.ids, reasonCode: body.reason_code } });
      if (!r.required) throw Problems.internal("dual-approval-expected");
      throw new ProblemError(409, "dual-approval-required", "A second approver is required", { detail: r.request.id });
    }
    const applied = await dlq.discard(t.principal, body.ids, body.reason_code satisfies DiscardReasonCode);
    await dlq.record(t.principal, applied, { reasonCode: body.reason_code });
    return applied;
  }

  @Post("feature-flags/:flag_key/kill-switch")
  @HttpCode(200)
  @Authorize("kill_switch.engage", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminWrite })
  @Contract({
    operationId: "adminToggleKillSwitch",
    summary: "Toggle a kill switch",
    tags: ["Admin RBAC"],
    params: FlagKeyParams,
    body: KillSwitchInput,
    response: FeatureFlagDto,
    maxQueries: 8,
  })
  async toggleKill(@Ctx() s: RequestState, @Params() p: FlagKeyParams, @Body() body: KillSwitchInput): Promise<FeatureFlagDto> {
    const t = this.staff(s);
    const ops = this.ops(t);
    // Only registered kill switches are toggled here (an ordinary flag or an unknown key is a 404, never created).
    if (!isKillSwitchName(p.flag_key)) throw Problems.notFound();
    const name: KillSwitchName = p.flag_key;
    if (body.enabled) {
      // Policy decides (dualApprovalRequired): only a switch explicitly registered as "ui" opts out; a missing or unknown class counts as money.
      const r = await t.svc.access.requireApproval(t.principal, { action: KILL_RELEASE_ACTION, targetType: "kill_switch", targetId: name, payload: { marketId: t.marketId, enabled: true, reason: body.reason }, moneySwitch: KILL_SWITCHES[name].class !== "ui" });
      if (r.required) throw new ProblemError(409, "dual-approval-required", "A second approver is required", { detail: r.request.id });
    }
    await ops.flags.set(t.principal, name, body.enabled, body.reason);
    return flagOf(await ops.flags.list(t.marketId), name);
  }
}
