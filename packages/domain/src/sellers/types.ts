/** Brand application domain constants (docs/specs/sellers-module.md, ADR-0031, master prompt 19 and B5). */

export const APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "AUTO_CHECKS",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "WITHDRAWN",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const BRAND_KINDS = ["local", "global"] as const;
export type BrandKind = (typeof BRAND_KINDS)[number];

export const OWNERSHIP_BASES = ["brand_owner", "authorized_distributor", "third_party_reseller"] as const;
export type OwnershipBasis = (typeof OWNERSHIP_BASES)[number];

export const DOCUMENT_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];
export const UPLOAD_STATUSES = ["awaiting_upload", "uploaded", "expired"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];
export const SCAN_STATUSES = ["pending", "clean", "infected", "error"] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
export const REVIEW_STATUSES = ["unreviewed", "accepted", "rejected", "unreadable"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REQUESTED_ITEM_KINDS = ["document", "field", "domain_verification", "clarification"] as const;
export type RequestedItemKind = (typeof REQUESTED_ITEM_KINDS)[number];

export const DECISIONS = ["approved", "rejected", "needs_info"] as const;
export type Decision = (typeof DECISIONS)[number];
export const DECISION_REASON_CODES = [
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
export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export const APPLICATION_ACTIONS = ["edit", "submit", "resubmit", "withdraw", "appeal", "upload_document", "verify_domain"] as const;
export type ApplicationAction = (typeof APPLICATION_ACTIONS)[number];

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_UPLOADS_PER_HOUR = 20;
export const REAPPLY_COOLDOWN_DAYS = 30;
export const APPEAL_WINDOW_DAYS = 30;
export const DECISION_SLA_BUSINESS_DAYS = 5;
/** Signatory minimum age (master prompt 19). */
export const MIN_SIGNATORY_AGE = 21;
export const DAY_MS = 86_400_000;

/** Statuses in which the applicant may edit fields and documents. */
export const EDITABLE_STATUSES: readonly ApplicationStatus[] = ["DRAFT", "NEEDS_INFO"];
/** Statuses that occupy the (applicant, normalised brand name) uniqueness slot. */
export const ACTIVE_STATUSES: readonly ApplicationStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "AUTO_CHECKS",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED",
  "SUSPENDED",
];
