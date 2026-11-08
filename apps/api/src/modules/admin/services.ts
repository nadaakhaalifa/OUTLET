import type { AdminAccess } from "@outlet/admin-access";
import type { Principal } from "@outlet/policy";
import type {
  ApprovalRequestDto, ApprovalRequestPage, ApprovalsQuery, ItemsQuery, KycCaseSummaryPage, KycCasesQuery, KycDecisionInput, KycDecisionResult, ReconciliationItemPage,
  ReconciliationRunPage, RunsQuery,
} from "./dto.js";

export type AdminAccessPort = Pick<AdminAccess, "buildPrincipal" | "approve" | "reject" | "recordPiiView">;

export interface ApprovalReaderPort {
  list(p: Principal, q: ApprovalsQuery): Promise<ApprovalRequestPage>;
  /** The decided request, read back after the vote (404 when it is not in the market). */
  get(p: Principal, id: string): Promise<ApprovalRequestDto>;
}

export interface KycAdminPort {
  list(marketId: string, q: KycCasesQuery): Promise<KycCaseSummaryPage>;
  decide(p: Principal, caseId: string, input: KycDecisionInput): Promise<KycDecisionResult>;
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
}
