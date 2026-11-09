import { Problems } from "../../platform/problem.js";
import type { AdminServices } from "./services.js";

const down = (): Promise<never> => Promise.reject(Problems.unavailable("admin-unavailable"));

/**
 * The audit trail has no Postgres store yet (AuditChain only ships an in-memory one), and an audited staff action that cannot be
 * recorded must not happen: every write that audits fails closed (503) until the `audit_log` table and its store land.
 */
export class UnconfiguredAuditPort {
  appendIn(): Promise<never> {
    return down();
  }
}

/** Production default while the staff stores are not wired: every admin route answers 503 (no principal can be built). */
export const unconfiguredAdminServices: AdminServices = {
  access: { buildPrincipal: down, approve: down, reject: down, recordPiiView: down, requireApproval: down, executeApproval: down, requestElevation: down, approveElevation: down, rejectElevation: down, activateElevation: down },
  approvals: { list: down, get: down },
  kyc: { list: down, decide: down },
  reconciliation: { listRuns: down, listItems: down },
};
