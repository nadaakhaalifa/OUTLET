import { DomainError } from "../errors";
import { defineMachine, guard } from "../state-machine/machine";
import { MS_PER_HOUR, type AdminRoleName } from "./roles";

/**
 * Dual-approval workflow (spec 23 Admin security, A2.6). This file only models the APPROVAL RECORD:
 * it never moves money, changes a price or grants a role. The module that owns the guarded action
 * must see an APPROVED, unexpired, not-yet-consumed approval for the exact same subject.
 */
export const APPROVAL_KINDS = [
  "role_grant",
  "plan_price_change",
  "data_export",
  "refund",
  "payout",
  "role_elevation",
  "break_glass",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATES = ["REQUESTED", "APPROVED", "REJECTED", "EXPIRED"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const APPROVAL_EVENTS = ["APPROVE", "REJECT", "EXPIRE"] as const;
export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];

export interface ApprovalGuardContext {
  readonly approverIsRequester: boolean;
  readonly approverHasScope: boolean;
  readonly expired: boolean;
}

const canApprove = guard<ApprovalGuardContext>(
  "distinctApproverWithScopeBeforeExpiry",
  (c) => !c.approverIsRequester && c.approverHasScope && !c.expired,
);
const canReject = guard<ApprovalGuardContext>(
  "scopedApproverOrRequesterWithdrawingBeforeExpiry",
  (c) => !c.expired && (c.approverHasScope || c.approverIsRequester),
);
const hasExpired = guard<ApprovalGuardContext>("pastExpiry", (c) => c.expired);

export const approvalMachine = defineMachine<ApprovalState, ApprovalEvent, ApprovalGuardContext>({
  name: "AdminApproval",
  states: APPROVAL_STATES,
  events: APPROVAL_EVENTS,
  initial: "REQUESTED",
  terminal: ["APPROVED", "REJECTED", "EXPIRED"],
  transitions: {
    REQUESTED: {
      APPROVE: { to: "APPROVED", guard: canApprove },
      REJECT: { to: "REJECTED", guard: canReject },
      EXPIRE: { to: "EXPIRED", guard: hasExpired },
    },
    APPROVED: {},
    REJECTED: {},
    EXPIRED: {},
  },
});

/** Who may ASK for each kind of action. Anything else is refused (deny by default). */
export const REQUESTER_ROLES: Readonly<Record<ApprovalKind, readonly AdminRoleName[]>> = {
  role_grant: ["super_admin"],
  plan_price_change: ["finance"],
  data_export: ["dpo"],
  refund: ["support", "finance"],
  payout: ["finance"],
  role_elevation: ["ops", "finance", "trust_safety", "support", "marketing", "dpo", "security", "super_admin"],
  break_glass: ["super_admin"],
};

/** Who may APPROVE each kind. The requester is excluded separately, whatever roles they hold. */
export const APPROVER_ROLES: Readonly<Record<ApprovalKind, readonly AdminRoleName[]>> = {
  role_grant: ["security", "super_admin"],
  plan_price_change: ["finance", "super_admin"],
  data_export: ["dpo", "security"],
  refund: ["finance", "super_admin"],
  payout: ["finance", "super_admin"],
  role_elevation: ["security", "super_admin"],
  break_glass: ["security", "super_admin"],
};

export interface ApprovalConfig {
  /** Refunds at or above this many piastres need dual approval. */
  readonly refundThresholdMinor: bigint;
  readonly payoutThresholdMinor: bigint;
  /** How long a REQUESTED approval stays decidable. */
  readonly requestTtlMs: number;
}

export const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  refundThresholdMinor: 500_000n, // 5,000 EGP, admin-editable with audit
  payoutThresholdMinor: 5_000_000n, // 50,000 EGP
  requestTtlMs: 24 * MS_PER_HOUR,
};

export class InvalidApprovalConfigError extends DomainError {}
export class InvalidApprovalRequestError extends DomainError {}

export function validateApprovalConfig(c: ApprovalConfig): ApprovalConfig {
  if (c.refundThresholdMinor < 0n || c.payoutThresholdMinor < 0n) {
    throw new InvalidApprovalConfigError("thresholds must not be negative");
  }
  if (!Number.isSafeInteger(c.requestTtlMs) || c.requestTtlMs <= 0 || c.requestTtlMs > 7 * 24 * MS_PER_HOUR) {
    throw new InvalidApprovalConfigError("requestTtlMs must be between 1 ms and 7 days");
  }
  return c;
}

/**
 * Money kinds need a second pair of eyes at or above the threshold, and when the amount is missing
 * (fail closed). Every other kind always needs it.
 */
export function requiresDualApproval(kind: ApprovalKind, amountMinor: bigint | null, cfg: ApprovalConfig): boolean {
  if (kind === "refund") return amountMinor === null || amountMinor >= cfg.refundThresholdMinor;
  if (kind === "payout") return amountMinor === null || amountMinor >= cfg.payoutThresholdMinor;
  return true;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly kind: ApprovalKind;
  /** The object the approval covers (order id, plan id, user id, export id ...). Binds the approval to it. */
  readonly subjectType: string;
  readonly subjectId: string;
  readonly amountMinor: bigint | null;
  readonly reasonCode: string;
  readonly requesterId: string;
  readonly state: ApprovalState;
  readonly approverId: string | null;
  readonly requestedAtMs: number;
  readonly expiresAtMs: number;
  readonly decidedAtMs: number | null;
  readonly decisionNote: string | null;
}

const hasAny = (held: readonly AdminRoleName[], allowed: readonly AdminRoleName[]): boolean =>
  held.some((r) => allowed.includes(r));

export type RequestApprovalResult =
  | { readonly kind: "created"; readonly record: ApprovalRecord }
  | { readonly kind: "not_required" }
  | { readonly kind: "denied"; readonly reason: "requester_role_not_allowed" };

export interface RequestApprovalInput {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly amountMinor: bigint | null;
  readonly reasonCode: string;
  readonly requesterId: string;
  readonly requesterRoles: readonly AdminRoleName[];
  readonly nowMs: number;
}

export function requestApproval(input: RequestApprovalInput, cfg: ApprovalConfig): RequestApprovalResult {
  if (input.amountMinor !== null && input.amountMinor < 0n) {
    throw new InvalidApprovalRequestError("amount must not be negative");
  }
  if (!hasAny(input.requesterRoles, REQUESTER_ROLES[input.kind])) {
    return { kind: "denied", reason: "requester_role_not_allowed" };
  }
  if (!requiresDualApproval(input.kind, input.amountMinor, cfg)) return { kind: "not_required" };
  return {
    kind: "created",
    record: {
      id: input.id,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      amountMinor: input.amountMinor,
      reasonCode: input.reasonCode,
      requesterId: input.requesterId,
      state: approvalMachine.initial,
      approverId: null,
      requestedAtMs: input.nowMs,
      expiresAtMs: input.nowMs + cfg.requestTtlMs,
      decidedAtMs: null,
      decisionNote: null,
    },
  };
}

export type ApprovalDenyReason =
  | "self_approval"
  | "approver_scope_missing"
  | "expired"
  | "not_pending";

export type DecideApprovalResult =
  | { readonly kind: "decided"; readonly record: ApprovalRecord }
  /** Expiry is discovered lazily: the caller persists `record` (state EXPIRED) and answers 409. */
  | { readonly kind: "expired"; readonly record: ApprovalRecord }
  | { readonly kind: "denied"; readonly reason: Exclude<ApprovalDenyReason, "expired"> };

export interface DecideApprovalInput {
  readonly approverId: string;
  readonly approverRoles: readonly AdminRoleName[];
  readonly decision: "APPROVE" | "REJECT";
  readonly note: string | null;
  readonly nowMs: number;
}

/** The effective state: a REQUESTED approval past its expiry is EXPIRED even before it is persisted. */
export function effectiveApprovalState(r: ApprovalRecord, nowMs: number): ApprovalState {
  return r.state === "REQUESTED" && nowMs >= r.expiresAtMs ? "EXPIRED" : r.state;
}

export function decideApproval(r: ApprovalRecord, input: DecideApprovalInput): DecideApprovalResult {
  if (r.state !== "REQUESTED") return { kind: "denied", reason: "not_pending" };
  const expired = input.nowMs >= r.expiresAtMs;
  if (expired) {
    return {
      kind: "expired",
      record: { ...r, state: approvalMachine.transition("REQUESTED", "EXPIRE", ctxOf(r, input, true)), decidedAtMs: input.nowMs },
    };
  }
  const approverIsRequester = input.approverId === r.requesterId;
  const approverHasScope = hasAny(input.approverRoles, APPROVER_ROLES[r.kind]);
  if (input.decision === "APPROVE") {
    if (approverIsRequester) return { kind: "denied", reason: "self_approval" };
    if (!approverHasScope) return { kind: "denied", reason: "approver_scope_missing" };
  } else if (!approverIsRequester && !approverHasScope) {
    return { kind: "denied", reason: "approver_scope_missing" };
  }
  const to = approvalMachine.transition(
    "REQUESTED",
    input.decision,
    { approverIsRequester, approverHasScope, expired: false },
  );
  return {
    kind: "decided",
    record: { ...r, state: to, approverId: input.approverId, decidedAtMs: input.nowMs, decisionNote: input.note },
  };
}

function ctxOf(r: ApprovalRecord, input: DecideApprovalInput, expired: boolean): ApprovalGuardContext {
  return {
    approverIsRequester: input.approverId === r.requesterId,
    approverHasScope: hasAny(input.approverRoles, APPROVER_ROLES[r.kind]),
    expired,
  };
}

/** Sweeper helper: the EXPIRED record for a stale REQUESTED approval, or null when it is not stale. */
export function expireIfStale(r: ApprovalRecord, nowMs: number): ApprovalRecord | null {
  if (r.state !== "REQUESTED" || nowMs < r.expiresAtMs) return null;
  return {
    ...r,
    state: approvalMachine.transition("REQUESTED", "EXPIRE", {
      approverIsRequester: false,
      approverHasScope: false,
      expired: true,
    }),
    decidedAtMs: nowMs,
  };
}

/**
 * True when `r` authorises acting on exactly (kind, subject) right now. Money amount is checked as
 * an upper bound so an approval for 5,000 EGP cannot cover a 50,000 EGP refund.
 */
export function approvalCovers(
  r: ApprovalRecord,
  want: { readonly kind: ApprovalKind; readonly subjectType: string; readonly subjectId: string; readonly amountMinor: bigint | null },
  nowMs: number,
): boolean {
  if (r.state !== "APPROVED" || r.approverId === null || r.approverId === r.requesterId) return false;
  if (r.kind !== want.kind || r.subjectType !== want.subjectType || r.subjectId !== want.subjectId) return false;
  if (nowMs >= r.expiresAtMs) return false;
  if (want.amountMinor === null) return r.amountMinor === null;
  return r.amountMinor !== null && want.amountMinor <= r.amountMinor;
}
