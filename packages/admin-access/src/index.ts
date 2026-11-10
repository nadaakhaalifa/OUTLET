export { AdminAccessError } from "./errors.js";
export type { AdminAccessErrorCode } from "./errors.js";
export {
  APPROVAL_TTL_MS, AdminRole, DEFAULT_GRANT_DAYS, ELEVATION_PENDING_MS, MAX_ELEVATION_MINUTES, MAX_GRANT_DAYS, REASON_CODES, REQUIRED_APPROVALS, ReasonCode, liveRoles, nextApprovalStatus,
} from "./domain.js";
export type { ApprovalEvent, ApprovalStatus, ElevationWindow, GrantWindow } from "./domain.js";
export { createAdminAccess } from "./service.js";
export type { AdminAccess, AdminAccessDeps, ApprovalRequestRow, AuditMeta, AuditPort, ElevationRow, ExecuteResult, RequireApprovalResult } from "./service.js";
