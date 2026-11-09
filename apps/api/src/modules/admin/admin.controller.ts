import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { KILL_SWITCHES, isKillSwitchName } from "@outlet/flags";
import type { KillSwitchName } from "@outlet/flags";
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
  ApprovalDecisionInput, ApprovalIdParams, ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseIdParams, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput,
  KycDecisionResult, ReconciliationItemPage, ReconciliationRunPage, RunIdParams, RunsQuery,
} from "./dto.js";
import {
  AuditLogEntryPage, AuditQuery, AuditVerifyQuery, AuditVerifyResult, ElevationDecisionInput, ElevationDto, ElevationIdParams, ElevationPage, ElevationRequestInput, ElevationsQuery,
   FeatureFlagDto, FeatureFlagPage, FlagKeyParams, FlagsQuery, KillSwitchInput } from "./dto-ops.js";
import { flagOf, flagPage } from "./ops-services.js";
import type { AdminOpsServices, ElevationReaderPort } from "./ops-services.js";
import type { AdminServices } from "./services.js";

/** Admin routes act on the staff's market as a whole; there is no object-level resolver (ids are checked against the market by the services: foreign id = 404). */
const market: ResourceResolver = (c) => ({ type: "admin_console", marketId: c.marketId });

/** Approval requests are market-scoped: the service re-checks the request's own action role and 404s foreign ids. */
const approvalResource: ResourceResolver = (c) => ({ type: "approval_request", marketId: c.marketId });

const ELEVATION_ACTION = "elevation.approve";
const KILL_RELEASE_ACTION = "kill_switch.engage";
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
    // A fully approved money-switch release applies right away (executed once: the approval claim and the flag write share the request).
    if (decided.status === "APPROVED" && decided.action === KILL_RELEASE_ACTION) {
      await t.svc.access.executeApproval(t.principal, decided.id, async (req, tx) => {
        if (!isKillSwitchName(req.targetId)) throw Problems.unprocessable("unknown-kill-switch");
        await this.ops(t).flags.set(t.principal, req.targetId, true, releaseReason(req.payload), tx);
      });
      return t.svc.approvals.get(t.principal, p.approval_request_id);
    }
    // A fully approved break-glass elevation (super_admin) activates right away; the executor is the last approver, never the requester.
    if (decided.status === "APPROVED" && decided.action === ELEVATION_ACTION) {
      await t.svc.access.activateElevation(t.principal, decided.id);
      return t.svc.approvals.get(t.principal, p.approval_request_id);
    }
    return decided;
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
    if (body.enabled && KILL_SWITCHES[name].class === "money") {
      const r = await t.svc.access.requireApproval(t.principal, { action: KILL_RELEASE_ACTION, targetType: "kill_switch", targetId: name, payload: { marketId: t.marketId, enabled: true, reason: body.reason } });
      if (r.required) throw new ProblemError(409, "dual-approval-required", "A second approver is required", { detail: r.request.id });
    }
    await ops.flags.set(t.principal, name, body.enabled, body.reason);
    return flagOf(await ops.flags.list(t.marketId), name);
  }
}
