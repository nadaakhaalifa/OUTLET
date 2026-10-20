import type { Application, ApplicationStatus, DecisionReason, RequestedItem } from "../api/schemas-onboarding";
import type { Locale, MessageKey } from "../i18n";

/** Status page model: a calm timeline, what is asked of the applicant, and which actions are allowed. */

export type TimelineStepId = "submitted" | "checks" | "review" | "decision";
export type TimelineState = "done" | "current" | "upcoming" | "problem";

export interface TimelineStep {
  readonly id: TimelineStepId;
  readonly labelKey: MessageKey;
  readonly state: TimelineState;
}

const LABEL: Readonly<Record<TimelineStepId, MessageKey>> = {
  submitted: "ob.timeline.submitted",
  checks: "ob.timeline.checks",
  review: "ob.timeline.review",
  decision: "ob.timeline.decision",
};

/** Index of the step an application currently sits on (0..3), or -1 for a draft. */
function position(s: ApplicationStatus): number {
  switch (s) {
    case "DRAFT": return -1;
    case "SUBMITTED": return 0;
    case "AUTO_CHECKS": return 1;
    case "IN_REVIEW": return 2;
    case "NEEDS_INFO": return 2;
    case "APPROVED":
    case "REJECTED":
    case "SUSPENDED":
    case "WITHDRAWN": return 3;
  }
}

export function timeline(status: ApplicationStatus): readonly TimelineStep[] {
  const pos = position(status);
  const ids: TimelineStepId[] = ["submitted", "checks", "review", "decision"];
  return ids.map((id, i) => {
    let state: TimelineState;
    if (pos < 0) state = "upcoming";
    else if (i < pos) state = "done";
    else if (i === pos) {
      if (status === "APPROVED") state = "done";
      else if (status === "REJECTED" || status === "SUSPENDED" || status === "WITHDRAWN" || status === "NEEDS_INFO") state = "problem";
      else state = "current";
    } else state = "upcoming";
    return { id, labelKey: LABEL[id], state };
  });
}

export const STATUS_KEY: Readonly<Record<ApplicationStatus, MessageKey>> = {
  DRAFT: "ob.status.DRAFT",
  SUBMITTED: "ob.status.SUBMITTED",
  AUTO_CHECKS: "ob.status.AUTO_CHECKS",
  IN_REVIEW: "ob.status.IN_REVIEW",
  NEEDS_INFO: "ob.status.NEEDS_INFO",
  APPROVED: "ob.status.APPROVED",
  REJECTED: "ob.status.REJECTED",
  SUSPENDED: "ob.status.SUSPENDED",
  WITHDRAWN: "ob.status.WITHDRAWN",
};

export const REASON_KEY: Readonly<Record<DecisionReason, MessageKey>> = {
  ok: "ob.reason.ok",
  ownership_not_proven: "ob.reason.ownership_not_proven",
  documents_unreadable: "ob.reason.documents_unreadable",
  documents_inconsistent: "ob.reason.documents_inconsistent",
  identity_mismatch: "ob.reason.identity_mismatch",
  domain_not_verified: "ob.reason.domain_not_verified",
  trademark_owner_mismatch: "ob.reason.trademark_owner_mismatch",
  not_a_brand: "ob.reason.not_a_brand",
  prohibited_category: "ob.reason.prohibited_category",
  counterfeit_confirmed: "ob.reason.counterfeit_confirmed",
  sanctions_hit: "ob.reason.sanctions_hit",
  duplicate_claim: "ob.reason.duplicate_claim",
  incomplete_information: "ob.reason.incomplete_information",
  other: "ob.reason.other",
};

export interface StatusVM {
  readonly status: ApplicationStatus;
  readonly timeline: readonly TimelineStep[];
  readonly requested: readonly { readonly code: string; readonly kind: RequestedItem["kind"]; readonly message: string; readonly satisfied: boolean }[];
  readonly unsatisfiedCount: number;
  readonly canFix: boolean;
  readonly canResubmit: boolean;
  readonly canWithdraw: boolean;
  readonly canAppeal: boolean;
  readonly appealUsed: boolean;
  readonly decision: { readonly reasonKey: MessageKey; readonly message: string; readonly decidedAt: string; readonly reapplyAfter: string | null } | null;
  readonly decisionDueAt: string | null;
  readonly storeId: string | null;
}

export function statusVM(app: Application, locale: Locale): StatusVM {
  const actions = new Set(app.allowed_actions);
  const requested = app.requested_items.map((r) => ({
    code: r.code, kind: r.kind, message: locale === "ar" ? r.message_ar : r.message_en, satisfied: r.satisfied === true,
  }));
  const unsatisfied = requested.filter((r) => !r.satisfied).length;
  const d = app.decision ?? null;
  return {
    status: app.status,
    timeline: timeline(app.status),
    requested,
    unsatisfiedCount: unsatisfied,
    canFix: actions.has("edit"),
    // Resubmit is only offered once every requested item is marked satisfied; the server enforces it too.
    canResubmit: actions.has("resubmit") && unsatisfied === 0,
    canWithdraw: actions.has("withdraw"),
    canAppeal: actions.has("appeal") && d?.appeal_allowed !== false && app.appeal_used !== true,
    appealUsed: app.appeal_used === true,
    decision: d === null ? null : {
      reasonKey: REASON_KEY[d.reason_code],
      message: locale === "ar" ? d.message_ar : d.message_en,
      decidedAt: d.decided_at,
      reapplyAfter: d.reapply_after ?? null,
    },
    decisionDueAt: app.decision_due_at ?? null,
    storeId: app.store_id ?? null,
  };
}

export const isEditable = (app: Application): boolean => app.allowed_actions.includes("edit");

export function validateAppeal(statement: string): MessageKey | null {
  const s = statement.trim();
  if (s.length < 20) return "ob.appeal.err.short";
  if (s.length > 2000) return "ob.appeal.err.long";
  return null;
}
