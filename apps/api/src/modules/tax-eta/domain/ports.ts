import type {
  DocumentKind,
  EtaReportedItem,
  ExemptionAuditEntry,
  SigningDelegation,
  SubmissionState,
  TaxCategory,
  TaxDocument,
} from "./bridge";

export class TaxEtaDependencyUnavailableError extends Error {
  constructor(readonly dependency: string) {
    super(`${dependency} is unavailable`);
    this.name = "TaxEtaDependencyUnavailableError";
  }
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface StoredDocument {
  readonly id: string;
  readonly document: TaxDocument;
  /** Seller (recipient of an e-invoice, issuer of a goods receipt). Null for shopper receipts. */
  readonly storeId: string | null;
  /** Shopper (recipient of an own-supply receipt). Null for seller documents. */
  readonly userId: string | null;
  readonly createdAtMs: number;
}

export interface SubmissionRecord {
  readonly documentId: string;
  readonly internalId: string;
  readonly state: SubmissionState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAtMs: number;
  readonly lastSubmittedAtMs: number | null;
  readonly lastError: string | null;
  readonly etaUuid: string | null;
  readonly signedDocumentRef: string | null;
  readonly rejectionReasons: readonly string[] | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly decidedAtMs: number | null;
}

export interface DocumentWithSubmission {
  readonly stored: StoredDocument;
  readonly submission: SubmissionRecord;
}

export type CreateDocumentOutcome =
  | { readonly kind: "created"; readonly value: DocumentWithSubmission }
  | { readonly kind: "duplicate"; readonly value: DocumentWithSubmission };

export interface AdminDocumentFilter {
  readonly state?: SubmissionState;
  readonly kind?: DocumentKind;
}

export type SaveCategoryOutcome = "ok" | "conflict" | "not_found";

export interface TaxConfigRepository {
  listCategories(): Promise<readonly TaxCategory[]>;
  getCategory(code: string): Promise<TaxCategory | null>;
  /** Atomic: the category row moves from `next.version - 1` to `next.version` and the audit row is appended. */
  saveCategoryWithAudit(next: TaxCategory, audit: ExemptionAuditEntry): Promise<SaveCategoryOutcome>;
  listAudit(categoryCode: string | null, limit: number): Promise<readonly ExemptionAuditEntry[]>;
}

export interface TaxDocumentRepository {
  /** Idempotent on (kind, sourceRef, version): a duplicate returns the existing row and creates nothing. */
  createWithSubmission(
    stored: StoredDocument,
    submission: SubmissionRecord,
  ): Promise<CreateDocumentOutcome>;
  findById(id: string): Promise<DocumentWithSubmission | null>;
  findByInternalId(internalId: string): Promise<DocumentWithSubmission | null>;
  listForStores(
    storeIds: readonly string[],
    kinds: readonly DocumentKind[],
    cursor: string | null,
    limit: number,
  ): Promise<Page<DocumentWithSubmission> | "invalid_cursor">;
  listAll(filter: AdminDocumentFilter, cursor: string | null, limit: number): Promise<Page<DocumentWithSubmission> | "invalid_cursor">;
  /** QUEUED or RETRY rows whose nextAttemptAt has passed, oldest first. */
  listDue(nowMs: number, limit: number): Promise<readonly DocumentWithSubmission[]>;
  /** SUBMITTED rows last submitted at or before `olderThanMs`. */
  listAwaitingStatus(olderThanMs: number, limit: number): Promise<readonly DocumentWithSubmission[]>;
  /** Compare-and-set on `expectedVersion`; the stored version becomes expectedVersion + 1. */
  updateSubmission(next: SubmissionRecord, expectedVersion: number): Promise<boolean>;
  listIssuedBetween(startMs: number, endMs: number): Promise<readonly DocumentWithSubmission[]>;
}

export type EtaSubmitResult =
  | { readonly kind: "accepted"; readonly etaUuid: string; readonly signed: SignedPayload }
  | { readonly kind: "pending"; readonly etaUuid: string | null }
  | { readonly kind: "rejected"; readonly reasons: readonly string[] }
  | { readonly kind: "transient_error"; readonly message: string };

export type EtaStatusResult =
  | { readonly kind: "accepted"; readonly etaUuid: string; readonly signed: SignedPayload }
  | { readonly kind: "pending" }
  | { readonly kind: "rejected"; readonly reasons: readonly string[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "transient_error"; readonly message: string };

export interface SignedPayload {
  readonly contentType: string;
  readonly body: string;
}

/**
 * ETA (Egyptian Tax Authority) portal port. The production adapter (live calls, signing) is not
 * built here: HARD LIMIT of this module. `submit` must be idempotent on `document.internalId`.
 */
export interface EtaPort {
  submit(document: TaxDocument): Promise<EtaSubmitResult>;
  status(internalId: string): Promise<EtaStatusResult>;
  /** ETA's own list of documents received in [startMs, endMs). Null when ETA cannot be queried. */
  dayReport(startMs: number, endMs: number): Promise<readonly EtaReportedItem[] | null>;
}

export interface SignedDocumentStore {
  put(internalId: string, payload: SignedPayload): Promise<{ readonly ref: string; readonly sha256: string }>;
  get(ref: string): Promise<(SignedPayload & { readonly sha256: string }) | null>;
}

/** Delegated signing grants (optional feature). Absent grant means the seller issues their own receipts. */
export interface SigningDelegationPort {
  find(storeId: string): Promise<SigningDelegation | null>;
}

export type TaxEtaEvent =
  | { readonly type: "tax_document.issued"; readonly internalId: string; readonly kind: DocumentKind }
  | { readonly type: "eta.submission_accepted"; readonly internalId: string; readonly etaUuid: string }
  | { readonly type: "eta.submission_rejected"; readonly internalId: string; readonly reasons: readonly string[] }
  | { readonly type: "eta.submission_dead_lettered"; readonly internalId: string };

/** Outbox publisher. Events carry no PII (internal ids only). */
export interface TaxEtaEventPublisher {
  publish(event: TaxEtaEvent): Promise<void>;
}
