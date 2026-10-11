import {
  approvalCovers,
  DEFAULT_APPROVAL_CONFIG,
  requiresDualApproval,
  type ApprovalConfig,
  type ApprovalRecord,
} from "../admin/approval";

export type PayoutApprovalStatus =
  | { readonly kind: "not_required" }
  | { readonly kind: "missing" }
  | { readonly kind: "covered"; readonly approvalId: string }
  | { readonly kind: "not_covering" };

/** Subject binding used for payout approvals: the approval is bound to this payout id and amount. */
export const PAYOUT_APPROVAL_SUBJECT_TYPE = "payout";

/**
 * Decides whether a payout may be approved with respect to dual approval (ADR-0021 point 7).
 * At or above the threshold (or with a missing amount, fail closed) an APPROVED, unexpired record
 * for exactly this payout and amount is required. `approvalCovers` already rejects a record whose
 * approver is its requester.
 */
export function payoutApprovalStatus(input: {
  readonly payoutId: string;
  readonly amountMinor: bigint;
  readonly records: readonly ApprovalRecord[];
  readonly nowMs: number;
  readonly config?: ApprovalConfig;
}): PayoutApprovalStatus {
  const cfg = input.config ?? DEFAULT_APPROVAL_CONFIG;
  if (!requiresDualApproval("payout", input.amountMinor, cfg)) return { kind: "not_required" };
  if (input.records.length === 0) return { kind: "missing" };
  const want = {
    kind: "payout" as const,
    subjectType: PAYOUT_APPROVAL_SUBJECT_TYPE,
    subjectId: input.payoutId,
    amountMinor: input.amountMinor,
  };
  const covering = [...input.records]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .find((r) => approvalCovers(r, want, input.nowMs));
  return covering === undefined ? { kind: "not_covering" } : { kind: "covered", approvalId: covering.id };
}

export const approvalRequirementMet = (s: PayoutApprovalStatus): boolean =>
  s.kind === "not_required" || s.kind === "covered";
