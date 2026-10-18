import type { sellers } from "@outlet/domain";

export type ApplicationStatus = sellers.ApplicationStatus;

/** Requested item as stored (jsonb) and shown. */
export interface RequestedItem {
  readonly code: string;
  readonly kind: sellers.RequestedItemKind;
  readonly messageAr: string;
  readonly messageEn: string;
  readonly satisfied: boolean;
}

export interface PublicDecision {
  readonly decision: sellers.Decision;
  readonly reasonCode: sellers.DecisionReasonCode;
  readonly messageAr: string;
  readonly messageEn: string;
  readonly decidedAtMs: number;
  readonly reapplyAfterMs: number | null;
  readonly appealAllowed: boolean;
}

export interface DomainVerificationState {
  readonly method: "dns_txt" | "email";
  readonly domain: string;
  readonly status: "pending" | "verified" | "failed" | "expired";
  readonly txtRecordName?: string;
  readonly txtRecordValue?: string;
  readonly emailSentToMasked?: string;
  readonly expiresAtMs?: number;
  readonly verifiedAtMs: number | null;
}

/** Stored form. Personal fields are ciphertext (AAD `brand_application:<id>:pii|national_id`). */
export interface ApplicationRow {
  readonly id: string;
  readonly applicantId: string;
  readonly status: ApplicationStatus;
  readonly version: number;
  readonly brandKind: sellers.BrandKind;
  readonly country: string;
  readonly brandName: string;
  readonly brandNameNorm: string;
  readonly ownershipBasis: sellers.OwnershipBasis | null;
  readonly trademarkRegister: string | null;
  readonly trademarkNumber: string | null;
  readonly trademarkOwnerName: string | null;
  readonly commercialRegisterNo: string | null;
  readonly taxCardNo: string | null;
  readonly companyRegNo: string | null;
  readonly companyRegCountry: string | null;
  readonly vatOrTaxId: string | null;
  readonly websiteDomain: string | null;
  readonly socialHandles: Readonly<Record<string, string>>;
  readonly etaRegistration: string | null;
  readonly descriptionAr: string | null;
  readonly descriptionEn: string | null;
  readonly acknowledgements: Readonly<Record<string, string | boolean>>;
  readonly piiEnc: Uint8Array | null;
  readonly nationalIdEnc: Uint8Array | null;
  readonly nationalIdBlind: Uint8Array | null;
  readonly domainVerification: DomainVerificationState | null;
  readonly appealUsed: boolean;
  readonly appealStatement: string | null;
  readonly submittedAtMs: number | null;
  readonly decision: PublicDecision | null;
  readonly decisionDueAtMs: number | null;
  readonly rejectedAtMs: number | null;
  readonly storeId: string | null;
  readonly assigneeId: string | null;
  readonly claimedAtMs: number | null;
  readonly requestedItems: readonly RequestedItem[];
  readonly requestedAtMs: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface DocumentRow {
  readonly id: string;
  readonly applicationId: string;
  readonly applicantId: string;
  readonly requirementCode: string;
  readonly originalFilenameEnc: Uint8Array | null;
  readonly contentType: sellers.DocumentContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly uploadStatus: sellers.UploadStatus;
  readonly scanStatus: sellers.ScanStatus;
  readonly reviewStatus: sellers.ReviewStatus;
  readonly reviewNotePublic: string | null;
  readonly reviewNoteInternal: string | null;
  readonly createdAtMs: number;
  readonly uploadedAtMs: number | null;
}

export interface AggregateRow {
  readonly app: ApplicationRow;
  readonly documents: readonly DocumentRow[];
}

export type RepoScope =
  | { readonly kind: "applicant"; readonly applicantId: string }
  | { readonly kind: "system" };

export type EventPayload = Readonly<Record<string, string | number | boolean | null>>;
export interface OutboxEventDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: EventPayload;
}

export interface HistoryDraft {
  readonly id: string;
  readonly fromStatus: ApplicationStatus;
  readonly toStatus: ApplicationStatus;
  readonly event: string;
  readonly actorType: "APPLICANT" | "SYSTEM" | "ADMIN";
  readonly actorId: string | null;
  readonly reasonCode: string | null;
  readonly occurredAtMs: number;
}

export interface Commit {
  readonly scope: RepoScope;
  readonly expectedVersion: number;
  /** New state; its version MUST be expectedVersion + 1. */
  readonly app: ApplicationRow;
  readonly documentsUpsert: readonly DocumentRow[];
  readonly documentsDelete: readonly string[];
  readonly history: HistoryDraft | null;
  readonly events: readonly OutboxEventDraft[];
}
export type CommitResult = "ok" | "conflict" | "not_found" | "duplicate_active";

export interface Cursor {
  readonly createdAtMs: number;
  readonly id: string;
}
export interface Page<T> {
  readonly items: readonly T[];
  readonly next: Cursor | null;
}

export interface ReviewQueueQuery {
  readonly status?: ApplicationStatus;
  readonly kind?: sellers.BrandKind;
  readonly country?: string;
  readonly assigneeId?: string | "unassigned";
  readonly slaBreachedAtMs?: number;
  readonly after: Cursor | null;
  readonly limit: number;
}

export interface HistoryRow extends HistoryDraft {
  readonly applicationId: string;
}

export interface BrandApplicationRepository {
  insert(row: ApplicationRow, history: HistoryDraft, events: readonly OutboxEventDraft[]): Promise<"created" | "duplicate_active">;
  get(id: string, scope: RepoScope): Promise<AggregateRow | null>;
  listForApplicant(applicantId: string, after: Cursor | null, limit: number): Promise<Page<AggregateRow>>;
  /** Rejection time of the most recent REJECTED application of this applicant for this normalised name. */
  lastRejectedAtMs(applicantId: string, brandNameNorm: string): Promise<number | null>;
  countDocumentsSince(applicationId: string, sinceMs: number): Promise<number>;
  commit(c: Commit): Promise<CommitResult>;
  /** System scope: review queue ordered by (created_at, id). */
  listForReview(q: ReviewQueueQuery): Promise<Page<AggregateRow>>;
  history(applicationId: string): Promise<readonly HistoryRow[]>;
  /** Other open applications using the same national id blind index (duplicate claim signal). */
  countOtherByNationalId(blind: Uint8Array, excludeId: string): Promise<number>;
}

// ----------------------------------------------------------------- providers

export interface UploadTarget {
  readonly url: string;
  readonly method: "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
}

/** Private KYC bucket. Keys carry no personal data. Unconfigured in production => 503 provider_not_configured. */
export interface BrandDocumentStore {
  createUploadUrl(i: { key: string; contentType: string; sizeBytes: number; sha256: string; ttlSeconds: number }): Promise<UploadTarget>;
  /** Null when no object exists at the key. `head` is the first bytes for the magic-byte check. */
  stat(key: string): Promise<{ readonly sizeBytes: number; readonly head: Uint8Array } | null>;
  delete(key: string): Promise<void>;
  signReadUrl(key: string, ttlSeconds: number): Promise<{ readonly url: string; readonly expiresAtMs: number }>;
}

export interface ScanPort {
  /** Starts (or runs) a malware scan. `pending` means the verdict arrives later through `applyScanVerdict`. */
  scan(key: string): Promise<"pending" | "clean" | "infected" | "error">;
}

/** What the sellers module needs from brand-verification (which owns domain verification, ADR-0031). */
export interface AutoCheckSnapshot {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly kind: sellers.BrandKind;
  readonly country: string;
  readonly brandName: string;
  readonly legalName: string;
  readonly websiteDomain: string | null;
  readonly trademark: { readonly office: "WIPO" | "EUIPO" | "USPTO" | "EGYPT-IP" | "OTHER"; readonly number: string } | null;
  readonly submittedAtMs: number | null;
}
export interface VerificationLink {
  /** Domain verification state as recorded by the brand-verification module (null when never started). */
  domainState(applicationId: string): Promise<DomainVerificationState | null>;
  /** Runs the automatic checks; the brand-verification module stores the report. */
  runAutoChecks(snapshot: AutoCheckSnapshot): Promise<void>;
}

export interface FunnelEvent {
  readonly name:
    | "brand_application_started"
    | "brand_document_uploaded"
    | "brand_application_submitted"
    | "brand_application_resubmitted"
    | "brand_application_withdrawn"
    | "brand_application_appealed";
  readonly props: Readonly<Record<string, string | number | boolean>>;
}
/** Enums and counts only. The adapter decides whether consent allows sending. */
export interface FunnelAnalyticsPort {
  track(e: FunnelEvent): void;
}

export interface FieldCipherPort {
  encrypt(plaintext: string, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<string>;
  blindIndex(purpose: string, value: string): Promise<Uint8Array>;
}

// ----------------------------------------------------------------- admin port (public contract)

export interface AdminApplicationSummary {
  readonly id: string;
  readonly status: ApplicationStatus;
  readonly version: number;
  readonly brandKind: sellers.BrandKind;
  readonly country: string;
  readonly brandName: string;
  readonly submittedAtMs: number | null;
  readonly decisionDueAtMs: number | null;
  readonly slaBreached: boolean;
  readonly assigneeId: string | null;
  readonly appealUsed: boolean;
  readonly createdAtMs: number;
}

export interface AdminDocumentView {
  readonly id: string;
  readonly requirementCode: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadStatus: string;
  readonly scanStatus: string;
  readonly reviewStatus: string;
  readonly reviewNotePublic: string | null;
  readonly reviewNoteInternal: string | null;
  readonly originalFilename: string | null;
}

export interface AdminApplicationDetail extends AdminApplicationSummary {
  readonly applicantId: string;
  readonly legalName: string | null;
  readonly registration: Readonly<Record<string, string>>;
  readonly trademark: Readonly<Record<string, string>>;
  readonly ownershipBasis: string | null;
  readonly websiteDomain: string | null;
  readonly domainVerification: DomainVerificationState | null;
  readonly contact: Readonly<Record<string, string>>;
  readonly signatory: { readonly fullName: string | null; readonly nationalIdLast4: string | null; readonly dateOfBirth: string | null };
  readonly duplicateNationalIdApplications: number;
  readonly documents: readonly AdminDocumentView[];
  readonly requestedItems: readonly RequestedItem[];
  readonly decision: PublicDecision | null;
  readonly storeId: string | null;
  readonly history: readonly HistoryDraft[];
}

export type AdminResult =
  | { readonly kind: "ok"; readonly application: AdminApplicationDetail }
  | { readonly kind: "not_found" }
  | { readonly kind: "version_conflict"; readonly currentVersion: number }
  | { readonly kind: "invalid_transition"; readonly from: ApplicationStatus }
  | { readonly kind: "guard_rejected"; readonly guard: string }
  | { readonly kind: "conflict_of_interest" }
  | { readonly kind: "not_claimed_by_actor" }
  | { readonly kind: "already_claimed"; readonly assigneeId: string }
  | { readonly kind: "invalid_input"; readonly code: string };

export interface AdminDecisionInput {
  readonly decision: sellers.Decision;
  readonly reasonCode: sellers.DecisionReasonCode;
  readonly messageAr: string;
  readonly messageEn: string;
  /** Required for needs_info. */
  readonly requestedItems?: readonly Pick<RequestedItem, "code" | "kind" | "messageAr" | "messageEn">[];
  /** Evidence the reviewer attests for approval (feeds the KYC approval guard). */
  readonly sanctionsClear?: boolean;
  readonly documentReviews?: readonly {
    readonly documentId: string;
    readonly reviewStatus: sellers.ReviewStatus;
    readonly notePublic?: string;
    readonly noteInternal?: string;
  }[];
}

/**
 * PUBLIC port the admin review API calls (index.ts export). All methods act as the platform, never as the
 * applicant; the admin module authorises the admin (passkey, ops or trust_safety role, dual approval where
 * required) BEFORE calling. Every mutation is optimistic: `expectedVersion` is compared with the stored version.
 */
export interface BrandApplicationsAdminPort {
  list(q: ReviewQueueQuery): Promise<Page<AdminApplicationSummary>>;
  get(id: string): Promise<AdminApplicationDetail | null>;
  claim(i: { id: string; adminId: string; expectedVersion: number }): Promise<AdminResult>;
  release(i: { id: string; adminId: string; expectedVersion: number }): Promise<AdminResult>;
  /** SUBMITTED -> AUTO_CHECKS, AUTO_CHECKS -> IN_REVIEW (automation worker). */
  advanceChecks(i: { id: string; event: "START_CHECKS" | "FINISH_CHECKS"; expectedVersion: number }): Promise<AdminResult>;
  applyDecision(i: { id: string; adminId: string; expectedVersion: number; input: AdminDecisionInput }): Promise<AdminResult>;
  readDocumentUrl(i: { id: string; documentId: string; adminId: string; reasonCode: string }): Promise<
    | { readonly kind: "ok"; readonly url: string; readonly expiresAtMs: number }
    | { readonly kind: "not_found" }
    | { readonly kind: "not_scanned_clean" }
  >;
  /** Applicant-side effect of provisioning: records the created store on an APPROVED application. */
  markProvisioned(i: { id: string; storeId: string; expectedVersion: number }): Promise<AdminResult>;
  /**
   * SUBMITTED -> AUTO_CHECKS, runs BrandVerificationPort.runAutoChecks (report stored by that module), then
   * AUTO_CHECKS -> IN_REVIEW. Called by the outbox consumer of brand_application.submitted.
   */
  runAutoChecks(i: { id: string; expectedVersion: number }): Promise<AdminResult>;
}
