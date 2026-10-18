import { addBusinessDays, SUSPENSION_REVIEW_SLA_BUSINESS_DAYS } from "../domain/bridge";

/**
 * Brand application review: ports this slice CONSUMES and the pure rules around them. The `sellers`
 * module (applications) and `brand-verification` implement these ports; wiring lives in
 * composition/brand-wiring.ts. Spec: docs/specs/brand-review-and-provisioning.md.
 */

export const BRAND_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "AUTO_CHECKS",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "WITHDRAWN",
  "PROVISIONING_FAILED",
] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export const BRAND_KINDS = ["local", "global"] as const;
export type BrandKind = (typeof BRAND_KINDS)[number];

export const BRAND_DECISIONS = ["approve", "reject", "needs_info"] as const;
export type BrandDecision = (typeof BRAND_DECISIONS)[number];

export const BRAND_REASON_CODES = [
  "ok",
  "ownership_not_proven",
  "documents_unreadable",
  "documents_inconsistent",
  "identity_mismatch",
  "domain_not_verified",
  "trademark_owner_mismatch",
  "not_a_brand",
  "prohibited_category",
  "counterfeit_confirmed",
  "sanctions_hit",
  "duplicate_claim",
  "incomplete_information",
  "other",
] as const;
export type BrandReasonCode = (typeof BRAND_REASON_CODES)[number];

export const DOCUMENT_READ_REASONS = ["kyc_review", "appeal_review", "fraud_investigation", "legal_request"] as const;
export type DocumentReadReason = (typeof DOCUMENT_READ_REASONS)[number];

/** Roles for every brand review route (admin spec 23; contract "Admin" table). */
export const BRAND_REVIEW_ROLES = ["ops", "trust_safety"] as const;

/** Signed document URLs live at most this long (spec section 9). */
export const MAX_READ_URL_TTL_MS = 15 * 60_000;
/** A first approval waiting for its cosigner lapses after this long. */
export const COSIGN_TTL_MS = 24 * 3_600_000;

export interface RequestedItem {
  readonly code: string;
  readonly kind: "document" | "field" | "domain_verification" | "clarification";
  readonly messageAr: string;
  readonly messageEn: string;
}

export interface AutoCheck {
  readonly code: string;
  readonly result: "pass" | "warn" | "fail" | "skipped" | "error";
  readonly detail: string | null;
  readonly ranAtMs: number;
}

export interface DocumentMeta {
  readonly id: string;
  readonly requirementCode: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly scanStatus: "pending" | "clean" | "infected" | "error";
  readonly uploadStatus: "awaiting_upload" | "uploaded";
}

export interface AutoCheckReport {
  readonly checks: readonly AutoCheck[];
  /** GLOBAL + (high-risk country or a sanctions warn/fail): a second admin must cosign. */
  readonly dualApprovalRequired: boolean;
  readonly riskScore: number | null;
}

export interface HistoryEntry {
  readonly atMs: number;
  readonly actorType: "applicant" | "admin" | "system";
  readonly event: string;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
}

export interface PendingCosign {
  readonly firstApproverId: string;
  readonly requestedAtMs: number;
}

export interface PublicDecision {
  readonly decision: BrandDecision;
  readonly reasonCode: BrandReasonCode;
  readonly messageAr: string;
  readonly messageEn: string;
  readonly decidedAtMs: number;
}

/** Admin read model of an application. Internal notes and risk score never reach the applicant. */
export interface BrandApplicationRecord {
  readonly id: string;
  /** Optimistic lock. */
  readonly version: number;
  readonly status: BrandStatus;
  readonly brandName: string;
  readonly brandKind: BrandKind;
  readonly country: string;
  readonly applicantUserId: string;
  readonly applicantShopperUserId: string | null;
  readonly applicantPhoneHash: string | null;
  readonly brandDomain: string | null;
  readonly assigneeId: string | null;
  readonly submittedAtMs: number;
  /** Set by the sellers module at submit and resubmit (5 business days, Cairo). */
  readonly decisionDueAtMs: number;
  readonly appeal: boolean;
  readonly highRiskCountry: boolean;
  readonly riskScore: number | null;
  readonly pendingCosign: PendingCosign | null;
  readonly claimConflictOpen: boolean;
  readonly duplicateClaimApplicationIds: readonly string[];
  readonly requestedItems: readonly RequestedItem[];
  readonly decision: PublicDecision | null;
  readonly internalNotes: readonly { readonly adminId: string; readonly note: string; readonly atMs: number }[];
  readonly history: readonly HistoryEntry[];
  readonly storeId: string | null;
  readonly provisioningFailure: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ListFilter {
  readonly status?: BrandStatus;
  readonly kind?: BrandKind;
  readonly country?: string;
  readonly assignee?: "me" | "unassigned" | "any";
  readonly adminId: string;
  /** When set, only open applications whose decision_due_at is before this instant. */
  readonly slaBreachedAtMs?: number;
  readonly appeal?: boolean;
}

export interface DecisionCommand {
  readonly decision: BrandDecision;
  readonly reasonCode: BrandReasonCode;
  readonly publicMessageAr: string | null;
  readonly publicMessageEn: string | null;
  readonly requestedItems: readonly RequestedItem[];
  readonly internalNote: string | null;
  readonly reapplyAfterDays: number | null;
  readonly slug: string | null;
  readonly decidedBy: string;
  readonly cosignedBy: string | null;
  /** The reviewer-visible sanctions check passed: evidence the implementation's approve guard needs. */
  readonly sanctionsClear: boolean;
  readonly atMs: number;
}

export type WriteResult =
  | { readonly kind: "ok"; readonly record: BrandApplicationRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "version_conflict" }
  | { readonly kind: "invalid_state"; readonly status: BrandStatus }
  | { readonly kind: "already_claimed" };

/**
 * Implemented by the `sellers` module. Every write is compare-and-set on `version` and, for
 * applyDecision, atomic with the outbox event (`brand_application.approved|rejected|needs_info`).
 */
export interface BrandApplicationsAdminPort {
  list(
    f: ListFilter,
    cursor: string | null,
    limit: number,
  ): Promise<{ readonly items: readonly BrandApplicationRecord[]; readonly nextCursor: string | null }>;
  get(id: string): Promise<BrandApplicationRecord | null>;
  claim(id: string, adminId: string, expectedVersion: number, atMs: number): Promise<WriteResult>;
  release(id: string, expectedVersion: number, atMs: number): Promise<WriteResult>;
  /** First approval of a dual-approval application: stays IN_REVIEW with pendingCosign set. */
  requestCosign(id: string, expectedVersion: number, firstApproverId: string, atMs: number): Promise<WriteResult>;
  applyDecision(id: string, expectedVersion: number, cmd: DecisionCommand): Promise<WriteResult>;
}

export type ReadUrlResult =
  | { readonly kind: "ok"; readonly url: string; readonly expiresAtMs: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_readable" };

/** Implemented by `brand-verification`. */
export interface BrandVerificationPort {
  autoCheckReport(applicationId: string): Promise<AutoCheckReport | null>;
  documents(applicationId: string): Promise<readonly DocumentMeta[]>;
  createReadUrl(
    applicationId: string,
    documentId: string,
    ttlMs: number,
    nowMs: number,
    ctx: { readonly adminId: string; readonly reasonCode: string },
  ): Promise<ReadUrlResult>;
}

export interface ReviewerIdentity {
  readonly userId: string;
  readonly phoneHash: string | null;
  readonly emailDomain: string | null;
}

/** Linked-identity lookup for the reviewer (admin directory). */
export interface ReviewerIdentityPort {
  identity(adminUserId: string): Promise<ReviewerIdentity>;
}

/** Reviewer must not be the applicant: same user, same phone hash, or work e-mail on the brand domain. */
export function reviewerIsApplicant(
  app: Pick<BrandApplicationRecord, "applicantUserId" | "applicantShopperUserId" | "applicantPhoneHash" | "brandDomain">,
  reviewer: ReviewerIdentity,
): boolean {
  if (reviewer.userId === app.applicantUserId || reviewer.userId === app.applicantShopperUserId) return true;
  if (reviewer.phoneHash !== null && app.applicantPhoneHash !== null && reviewer.phoneHash === app.applicantPhoneHash) return true;
  if (reviewer.emailDomain !== null && app.brandDomain !== null) {
    const d = reviewer.emailDomain.toLowerCase();
    const b = app.brandDomain.toLowerCase();
    if (d === b || d.endsWith(`.${b}`)) return true;
  }
  return false;
}

const OPEN_FOR_SLA: ReadonlySet<BrandStatus> = new Set(["SUBMITTED", "AUTO_CHECKS", "IN_REVIEW"]);

/** NEEDS_INFO pauses the clock (spec section 2). */
export function slaBreached(app: Pick<BrandApplicationRecord, "status" | "decisionDueAtMs">, nowMs: number): boolean {
  return OPEN_FOR_SLA.has(app.status) && nowMs > app.decisionDueAtMs;
}

/** Human review SLA: 5 business days on the Africa/Cairo calendar from submit/resubmit. */
export const computeDecisionDueAt = (submittedAtMs: number): number =>
  addBusinessDays(submittedAtMs, SUSPENSION_REVIEW_SLA_BUSINESS_DAYS);

export interface FieldProblem {
  readonly pointer: string;
  readonly code: string;
}

export interface DecisionInput {
  readonly decision: BrandDecision;
  readonly reasonCode: BrandReasonCode;
  readonly publicMessageAr?: string | undefined;
  readonly publicMessageEn?: string | undefined;
  readonly requestedItems?: readonly RequestedItem[] | undefined;
}

const blank = (s: string | undefined): boolean => s === undefined || s.trim() === "";

/** Reject needs a reason and both public messages; needs_info needs >= 1 item; approve is reason `ok`. */
export function validateDecision(d: DecisionInput): readonly FieldProblem[] {
  const out: FieldProblem[] = [];
  if (d.decision === "approve") {
    if (d.reasonCode !== "ok") out.push({ pointer: "/body/reason_code", code: "approve_requires_ok" });
    return out;
  }
  if (d.reasonCode === "ok") out.push({ pointer: "/body/reason_code", code: "reason_required" });
  if (blank(d.publicMessageAr)) out.push({ pointer: "/body/public_message_ar", code: "required" });
  if (blank(d.publicMessageEn)) out.push({ pointer: "/body/public_message_en", code: "required" });
  if (d.decision === "needs_info" && (d.requestedItems === undefined || d.requestedItems.length === 0)) {
    out.push({ pointer: "/body/requested_items", code: "at_least_one_required" });
  }
  return out;
}

/** Mirrors approvalCovers for the cosign record (the admin approval kinds are a closed enum). */
export function cosignCovers(
  pending: PendingCosign | null,
  cosigner: string,
  nowMs: number,
): "ok" | "none" | "same_admin" | "expired" {
  if (pending === null) return "none";
  if (pending.firstApproverId === cosigner) return "same_admin";
  if (nowMs >= pending.requestedAtMs + COSIGN_TTL_MS) return "expired";
  return "ok";
}

/** True only when a sanctions check exists and passed. Absent or errored means not clear (fail closed). */
export const sanctionsClearIn = (checks: readonly AutoCheck[]): boolean =>
  checks.some((c) => (c.code === "sanctions" || c.code === "sanctions_screen") && c.result === "pass");

export type OverlayFailureCode = "store_name_conflict" | "provisioning_error";

/**
 * State the sellers module does not model: the first approver of a dual-approval application and the
 * PROVISIONING_FAILED parking flag (migration 0054 `brand_review_overlay`). Every method is idempotent.
 */
export interface BrandReviewOverlay {
  getCosign(applicationId: string): Promise<PendingCosign | null>;
  setCosign(applicationId: string, c: PendingCosign): Promise<void>;
  clearCosign(applicationId: string): Promise<void>;
  getFailure(applicationId: string): Promise<OverlayFailureCode | null>;
  /** Parks the application. Keeps an already recorded conflicting store id. */
  setFailure(applicationId: string, code: OverlayFailureCode): Promise<void>;
  /** Provisioning succeeded: clears the failure, the conflicting store id and the retry counters. */
  clearFailure(applicationId: string): Promise<void>;
  /** Parked application ids, oldest failure first. */
  listFailures(limit: number): Promise<readonly string[]>;
  /** Admin conflict queue entry: the existing store whose name clashes. */
  recordConflict(applicationId: string, conflictingStoreId: string): Promise<void>;
  conflictingStoreId(applicationId: string): Promise<string | null>;
  /** Admin retry bookkeeping (count and time of the last manual retry). */
  recordRetry(applicationId: string): Promise<void>;
}

export type ProvisioningRetryOutcome =
  | { readonly kind: "provisioned" }
  | { readonly kind: "provisioning_failed"; readonly code: OverlayFailureCode }
  | { readonly kind: "ignored" };

/** Re-runs store provisioning for a parked application (stores module `RetryFailedProvisioning`). Idempotent. */
export interface ProvisioningRetryPort {
  retry(applicationId: string): Promise<ProvisioningRetryOutcome>;
}

/** What the outbox relay needs from the provisioning consumer (stores `BrandApplicationEventConsumer`). */
export interface BrandEventConsumerPort {
  handle(e: { readonly messageId: string; readonly type: string; readonly payload: unknown }): Promise<unknown>;
}
