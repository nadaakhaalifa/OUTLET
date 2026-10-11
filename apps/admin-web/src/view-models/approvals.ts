import { admin } from "@outlet/domain";
import type { ApprovalWire } from "../api/schemas";
import { parseMinor } from "../lib/format";
import type { MessageKey } from "../i18n";
import type { Role } from "./common";

export type BlockedReason = "self_approval" | "approver_scope_missing" | "expired" | "not_pending";

/** The exact binding an approval grants, as `approvalCovers` evaluates it (kind + subject + up-to amount). */
export interface CoversBinding {
  readonly kind: admin.ApprovalKind;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly amountMinor: bigint | null;
}

export interface ApprovalRow {
  readonly id: string;
  readonly kind: admin.ApprovalKind;
  readonly kindKey: MessageKey;
  readonly reasonCode: string;
  readonly requestedByMe: boolean;
  readonly effectiveState: admin.ApprovalState;
  readonly covers: CoversBinding;
  readonly expiresAtMs: number;
  /** For APPROVED rows: does the binding still cover itself right now (not expired, approver differs). */
  readonly coversNow: boolean;
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly blocked: BlockedReason | null;
}

const KIND_KEYS: Readonly<Record<admin.ApprovalKind, MessageKey>> = {
  role_grant: "approval.kind.role_grant",
  plan_price_change: "approval.kind.plan_price_change",
  data_export: "approval.kind.data_export",
  refund: "approval.kind.refund",
  payout: "approval.kind.payout",
  role_elevation: "approval.kind.role_elevation",
  break_glass: "approval.kind.break_glass",
};

export function toRecord(w: ApprovalWire): admin.ApprovalRecord {
  return {
    id: w.id,
    kind: w.kind,
    subjectType: w.subject_type,
    subjectId: w.subject_id,
    amountMinor: w.amount_minor === null ? null : parseMinor(w.amount_minor),
    reasonCode: w.reason_code,
    requesterId: w.requester_id,
    state: w.state,
    approverId: w.approver_id,
    requestedAtMs: Date.parse(w.requested_at),
    expiresAtMs: Date.parse(w.expires_at),
    decidedAtMs: w.decided_at === null ? null : Date.parse(w.decided_at),
    decisionNote: null,
  };
}

export interface ApprovalContext {
  readonly nowMs: number;
  readonly selfId: string;
  readonly selfRoles: readonly Role[];
}

/**
 * Pre-computes what the API will say, using the SAME domain function the API uses (decideApproval), so
 * the UI cannot drift from the rules. It only decides whether to OFFER the buttons; the server decides.
 */
export function approvalRow(w: ApprovalWire, ctx: ApprovalContext): ApprovalRow {
  const rec = toRecord(w);
  const effectiveState = admin.effectiveApprovalState(rec, ctx.nowMs);
  const base = { approverId: ctx.selfId, approverRoles: ctx.selfRoles, note: null, nowMs: ctx.nowMs } as const;
  const approve = admin.decideApproval(rec, { ...base, decision: "APPROVE" });
  const reject = admin.decideApproval(rec, { ...base, decision: "REJECT" });
  const covers: CoversBinding = { kind: rec.kind, subjectType: rec.subjectType, subjectId: rec.subjectId, amountMinor: rec.amountMinor };
  let blocked: BlockedReason | null = null;
  if (approve.kind === "expired" || effectiveState === "EXPIRED") blocked = "expired";
  else if (approve.kind === "denied") blocked = approve.reason;
  return {
    id: rec.id,
    kind: rec.kind,
    kindKey: KIND_KEYS[rec.kind],
    reasonCode: rec.reasonCode,
    requestedByMe: rec.requesterId === ctx.selfId,
    effectiveState,
    covers,
    expiresAtMs: rec.expiresAtMs,
    coversNow: effectiveState === "APPROVED" && admin.approvalCovers(rec, covers, ctx.nowMs),
    canApprove: approve.kind === "decided",
    canReject: reject.kind === "decided",
    blocked: effectiveState === "REQUESTED" && approve.kind === "decided" ? null : blocked,
  };
}

export interface ApprovalInbox {
  /** Pending and approvable by me. */
  readonly actionable: readonly ApprovalRow[];
  /** Pending but I cannot approve (my own request, wrong scope). */
  readonly waiting: readonly ApprovalRow[];
  readonly decided: readonly ApprovalRow[];
}

export function approvalInbox(items: readonly ApprovalWire[], ctx: ApprovalContext): ApprovalInbox {
  const rows = items.map((w) => approvalRow(w, ctx));
  const byExpiry = (a: ApprovalRow, b: ApprovalRow): number => a.expiresAtMs - b.expiresAtMs || a.id.localeCompare(b.id);
  return {
    actionable: rows.filter((r) => r.effectiveState === "REQUESTED" && r.canApprove).sort(byExpiry),
    waiting: rows.filter((r) => r.effectiveState === "REQUESTED" && !r.canApprove).sort(byExpiry),
    decided: rows.filter((r) => r.effectiveState !== "REQUESTED").sort((a, b) => b.expiresAtMs - a.expiresAtMs),
  };
}
