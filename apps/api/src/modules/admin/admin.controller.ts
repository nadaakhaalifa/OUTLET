import { Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import type { Principal } from "@outlet/policy";
import { Authorize, Contract, Paginated, RateLimit, ReasonCode } from "../../platform/decorators.js";
import { API_DEPS } from "../../platform/deps.js";
import type { ApiDeps } from "../../platform/deps.js";
import type { RequestState } from "../../platform/http.js";
import { Problems } from "../../platform/problem.js";
import { RATE_BUDGETS } from "../../platform/rate-limit/budgets.js";
import type { ResourceResolver } from "../../platform/decorators.js";
import { Body, Ctx, Params, Query } from "../../platform/validation.js";
import {
  ApprovalDecisionInput, ApprovalIdParams, ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseIdParams, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput,
  KycDecisionResult, ReconciliationItemPage, ReconciliationRunPage, RunIdParams, RunsQuery,
} from "./dto.js";
import type { AdminServices } from "./services.js";

/** Admin routes act on the staff's market as a whole; there is no object-level resolver (ids are checked against the market by the services: foreign id = 404). */
const market: ResourceResolver = (c) => ({ type: "admin_console", marketId: c.marketId });

interface Staff { readonly principal: Principal; readonly marketId: string; readonly svc: AdminServices }

/**
 * Admin Console routes (tenant "admin": passkey session + live role grants/elevations from @outlet/admin-access, deny by default).
 * Policy actions are the ones @outlet/policy grants today: `audit.read` for the approval queue, `seller_kyc.review` for KYC,
 * `ledger.read` (reason code required, one audited reveal per read) for reconciliation.
 */
@Controller("v1/:market/admin")
export class AdminController {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  private staff(s: RequestState): Staff {
    if (s.principal === undefined || s.marketId === undefined) throw Problems.internal("tenant-context-missing");
    return { principal: s.principal, marketId: s.marketId, svc: this.deps.admin(s.marketId) };
  }

  // ---------------------------------------------------------------- approval requests (dual approval queue)

  @Get("approval-requests")
  @Paginated()
  @Authorize("audit.read", market, { tenant: "admin" })
  @RateLimit({ budget: RATE_BUDGETS.adminRead })
  @Contract({ operationId: "adminListApprovalRequests", summary: "Dual-approval queue (status, action filters)", tags: ["Admin Approvals"], query: ApprovalsQuery, response: ApprovalRequestPage, maxQueries: 4 })
  listApprovals(@Ctx() s: RequestState, @Query() q: ApprovalsQuery): Promise<ApprovalRequestPage> {
    const t = this.staff(s);
    return t.svc.approvals.list(t.principal, q);
  }

  @Post("approval-requests/:approval_request_id/decision")
  @HttpCode(200)
  @Authorize("audit.read", market, { tenant: "admin" })
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
}
