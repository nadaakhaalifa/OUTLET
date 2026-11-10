import { ADMIN_ROLES } from "@outlet/policy";
import { z } from "zod";
import { AdminAccessError } from "./errors.js";

export const REASON_CODES = ["support_ticket", "fraud_review", "legal_request", "dsar", "finance_reconciliation", "other_with_note"] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const AdminRole = z.enum(ADMIN_ROLES);
export type AdminRole = z.infer<typeof AdminRole>;

export const DEFAULT_GRANT_DAYS = 90;
export const MAX_GRANT_DAYS = 365;
export const MAX_ELEVATION_MINUTES = 60;
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** A pending elevation request can be approved for this long. */
export const ELEVATION_PENDING_MS = 30 * 60 * 1000;
export const REQUIRED_APPROVALS = 2;

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
export type ApprovalEvent = "approve" | "reject" | "expire";

/**
 * ApprovalRequest machine: PENDING -> APPROVED | REJECTED | EXPIRED. All three are terminal.
 * `approvalsAfter` is the count of distinct approvals including the vote being applied.
 */
export const nextApprovalStatus = (status: ApprovalStatus, event: ApprovalEvent, approvalsAfter: number, required: number): ApprovalStatus => {
  if (status !== "PENDING") throw new AdminAccessError("INVALID_TRANSITION", `cannot ${event} a ${status} request`);
  switch (event) {
    case "approve":
      return approvalsAfter >= required ? "APPROVED" : "PENDING";
    case "reject":
      return "REJECTED";
    case "expire":
      return "EXPIRED";
  }
};

export interface GrantWindow {
  readonly role: string;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}
export interface ElevationWindow {
  readonly role: string;
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

const live = (w: { startsAt: Date; expiresAt: Date }, now: Date): boolean => w.startsAt.getTime() <= now.getTime() && now.getTime() < w.expiresAt.getTime();

/** Roles live at `now`: standing grants (not revoked, in window) plus approved elevations in window. Sorted, unique. */
export const liveRoles = (grants: readonly GrantWindow[], elevations: readonly ElevationWindow[], now: Date): string[] => {
  const roles = new Set<string>();
  for (const g of grants) if (g.revokedAt === null && live(g, now)) roles.add(g.role);
  for (const e of elevations) if (live(e, now)) roles.add(e.role);
  return [...roles].sort();
};
