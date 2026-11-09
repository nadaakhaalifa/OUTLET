import type { AdminAccess } from "@outlet/admin-access";
import type { Principal } from "@outlet/policy";
import type {
  AdminKycCase, ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput, KycDecisionResult, ReconciliationItemPage,
  ReconciliationRunPage, RunsQuery,
} from "./dto.js";
import type { AdminOpsServices } from "./ops-services.js";

export type AdminAccessPort = Pick<AdminAccess, "buildPrincipal" | "approve" | "reject" | "recordPiiView" | "requireApproval" | "executeApproval" | "requestElevation" | "approveElevation" | "rejectElevation" | "activateElevation">;

export interface ApprovalReaderPort {
  list(p: Principal, q: ApprovalsQuery): Promise<ApprovalRequestPage>;
  /** The decided request, read back after the vote (404 when it is not in the market). */
  get(p: Principal, id: string): Promise<ApprovalRequestDto>;
}

export interface KycAdminPort {
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
}
