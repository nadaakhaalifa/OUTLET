import type { AdminAccess } from "@outlet/admin-access";
import type { Principal } from "@outlet/policy";
import type {
  AdminKycCase, ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput, KycDecisionResult, ReconciliationItemPage,
  ReconciliationRunPage, RunsQuery,
} from "./dto.js";
import type { AdminOpsServices } from "./ops-services.js";
import type { DashboardReaderPort } from "./ports.js";

export type AdminAccessPort = Pick<AdminAccess, "buildPrincipal" | "approve" | "reject" | "recordPiiView" | "requireApproval" | "executeApproval" | "verifyApproved" | "requestElevation" | "approveElevation" | "rejectElevation" | "activateElevation">;

export interface ApprovalCount { readonly forMe: number; readonly soonestExpiresAt: string | null }
export interface KycCount { readonly submitted: number; readonly needsInfo: number; readonly oldestAt: string | null }

export interface ApprovalReaderPort {
  /** Dashboard: pending requests the caller may decide (not own, not already voted). */
  countPending(p: Principal): Promise<ApprovalCount>;
  list(p: Principal, q: ApprovalsQuery): Promise<ApprovalRequestPage>;
  /** The decided request, read back after the vote (404 when it is not in the market). */
  get(p: Principal, id: string): Promise<ApprovalRequestDto>;
}

export interface KycAdminPort {
  /** Dashboard: queue sizes and the oldest submission. */
  count(marketId: string): Promise<KycCount>;
  list(marketId: string, q: KycCasesQuery): Promise<KycCaseSummaryPage>;
  decide(p: Principal, caseId: string, input: KycDecisionInput): Promise<KycDecisionResult>;
  /** Null when the case is not in the market (404). */
  detail(marketId: string, caseId: string): Promise<AdminKycCase | null>;
}

export interface ReconciliationReaderPort {
  listRuns(marketId: string, q: RunsQuery): Promise<ReconciliationRunPage>;
  /** Null when the run does not exist in the market. */
  listItems(marketId: string, runId: string, q: ItemsQuery, now: Date): Promise<ReconciliationItemPage | null>;
}

/** Everything the Admin Console routes need for one market. */
export interface AdminServices {
  readonly access: AdminAccessPort;
  readonly approvals: ApprovalReaderPort;
  readonly kyc: KycAdminPort;
  readonly reconciliation: ReconciliationReaderPort;
  /** Feature flags / kill switches and the audit-log read. Absent until composed: those routes answer 503. */
  readonly ops?: AdminOpsServices;
  /** Rollup reads (job admin.dashboard). Absent until composed: the snapshot and sales tiles answer `unavailable/not_connected`, never a zero. */
  readonly dashboard?: DashboardReaderPort;
}
