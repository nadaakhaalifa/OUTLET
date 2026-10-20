import type {
  AutoCheckReport,
  BrandKind,
  ClaimView,
  ConflictOutcome,
  ConflictReason,
  DomainRejection,
  EmailLocalPart,
  OwnerMatchBand,
} from "./bridge";

export type { Clock, IdGenerator } from "../../../platform/ports";

export const TRADEMARK_OFFICES = ["WIPO", "EUIPO", "USPTO", "EGYPT-IP", "OTHER"] as const;
export type TrademarkOffice = (typeof TRADEMARK_OFFICES)[number];
export const MARK_STATUSES = ["registered", "pending", "expired", "cancelled", "unknown"] as const;
export type MarkStatus = (typeof MARK_STATUSES)[number];

/** What this module needs to know about an application. The sellers module supplies it (ApplicationOwnershipPort). */
export interface ApplicationSnapshot {
  readonly applicationId: string;
  /** seller_user id of the applicant (owner). */
  readonly applicantId: string;
  readonly kind: BrandKind;
  readonly country: string;
  readonly brandName: string;
  readonly legalName: string;
  readonly websiteDomain: string | null;
  readonly trademark: { readonly office: TrademarkOffice; readonly number: string } | null;
  readonly submittedAtMs: number | null;
}

/** Looks up an application by id. Null for unknown ids; the caller compares applicantId to the token subject. */
export interface ApplicationOwnershipPort {
  find(applicationId: string): Promise<ApplicationSnapshot | null>;
}

// ------------------------------------------------------------------ external ports

export type DnsTxtResult =
  | { readonly kind: "ok"; readonly answers: readonly string[] }
  | { readonly kind: "nxdomain" }
  | { readonly kind: "error" };
export interface DnsResolverPort {
  resolveTxt(name: string): Promise<DnsTxtResult>;
}

export interface TrademarkRegistryRecord {
  readonly ownerName: string;
  readonly markText: string;
  readonly classes: readonly number[];
  readonly status: MarkStatus;
  readonly registeredOn: string | null;
  readonly expiresOn: string | null;
}
export type TrademarkRegistryResult =
  | { readonly kind: "found"; readonly record: TrademarkRegistryRecord }
  | { readonly kind: "not_found" };
export interface TrademarkRegistryPort {
  lookup(input: { readonly office: TrademarkOffice; readonly number: string }): Promise<TrademarkRegistryResult>;
}

export interface SanctionsScreeningPort {
  screen(input: { readonly name: string; readonly country: string }): Promise<{
    readonly outcome: "clear" | "warn" | "fail";
    readonly matchedListIds: readonly string[];
    readonly listVersion: string;
  }>;
}

export interface VerificationEmailPort {
  sendCode(input: { readonly to: string; readonly code: string; readonly requestId: string }): Promise<"sent" | "unavailable" | "invalid_recipient">;
}

export interface VerificationSecretPort {
  /** HMAC key for DNS tokens and code hashes (KMS-held in production). */
  hmacKey(): string;
}

// ------------------------------------------------------------------ records

export type DomainMethod = "dns_txt" | "email";
export type DomainStatus = "pending" | "verified" | "failed" | "expired";

export interface DomainVerificationRecord {
  readonly applicationId: string;
  readonly applicantId: string;
  readonly domain: string;
  readonly method: DomainMethod;
  readonly status: DomainStatus;
  readonly nonce: string;
  readonly emailLocal: EmailLocalPart | null;
  readonly emailCodeHash: string | null;
  readonly attempts: number;
  readonly expiresAtMs: number;
  readonly verifiedAtMs: number | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ConflictRecord {
  readonly id: string;
  readonly conflictKey: string;
  readonly applicationIds: readonly string[];
  readonly reasons: readonly ConflictReason[];
  readonly status: "open" | "resolved";
  readonly outcome: ConflictOutcome | null;
  readonly winnerApplicationId: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAtMs: number | null;
  readonly createdAtMs: number;
}

export interface TrademarkLookupRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly source: "registry" | "manual";
  readonly office: TrademarkOffice;
  readonly registerNumber: string;
  readonly found: boolean;
  readonly ownerName: string | null;
  readonly markText: string | null;
  readonly classes: readonly number[];
  readonly status: MarkStatus | null;
  readonly registeredOn: string | null;
  readonly expiresOn: string | null;
  readonly ownerScore: number | null;
  readonly ownerBand: OwnerMatchBand | null;
  readonly recordedBy: string | null;
  readonly retrievedAtMs: number;
  readonly createdAtMs: number;
}

export interface ScreeningRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly outcome: "clear" | "warn" | "fail" | "error";
  readonly matchedListIds: readonly string[];
  readonly listVersion: string;
  readonly screenedAtMs: number;
}

export interface ReportRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly report: AutoCheckReport;
  readonly createdAtMs: number;
}

/** Outbox payloads carry ids and enums only (never names, domains or owners). */
export interface OutboxDraft {
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
}
export interface HistoryDraft {
  readonly applicationId: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly refId: string | null;
}
export interface Effects {
  readonly outbox: readonly OutboxDraft[];
  readonly history: readonly HistoryDraft[];
}

export interface ClaimCandidateQuery {
  readonly exceptApplicationId: string;
  readonly country: string;
  readonly domain: string | null;
  readonly trademarkKey: string | null;
}

export interface NewConflict {
  readonly id: string;
  readonly applicationIds: readonly string[];
  readonly reasons: readonly ConflictReason[];
  readonly createdAtMs: number;
}

export type ResolveConflictStore =
  | { readonly kind: "resolved"; readonly conflict: ConflictRecord }
  | { readonly kind: "already_resolved"; readonly conflict: ConflictRecord }
  | { readonly kind: "not_found" };

/** One interface, two adapters (in-memory, Kysely) on a shared contract suite. Every write commits its effects atomically. */
export interface BrandVerificationStore {
  getDomainVerification(applicationId: string): Promise<DomainVerificationRecord | null>;
  /** `expectedVersion` null inserts; otherwise compare-and-set on version. */
  saveDomainVerification(rec: DomainVerificationRecord, expectedVersion: number | null, fx: Effects): Promise<"saved" | "version_conflict">;

  getClaim(applicationId: string): Promise<ClaimView | null>;
  upsertClaim(claim: ClaimView): Promise<void>;
  findClaimCandidates(q: ClaimCandidateQuery): Promise<readonly ClaimView[]>;

  /** Idempotent on the sorted application-id set; merges reasons into an existing open conflict. */
  openConflict(c: NewConflict, fx: Effects): Promise<{ readonly conflict: ConflictRecord; readonly created: boolean }>;
  listConflictsFor(applicationId: string): Promise<readonly ConflictRecord[]>;
  resolveConflict(i: { id: string; outcome: ConflictOutcome; winnerApplicationId: string | null; resolvedBy: string; atMs: number }, fx: Effects): Promise<ResolveConflictStore>;

  insertTrademarkLookup(rec: TrademarkLookupRecord, fx: Effects): Promise<void>;
  listTrademarkLookups(applicationId: string): Promise<readonly TrademarkLookupRecord[]>;
  insertScreening(rec: ScreeningRecord): Promise<void>;
  latestScreening(applicationId: string): Promise<ScreeningRecord | null>;
  insertReport(rec: ReportRecord, fx: Effects): Promise<void>;
  latestReport(applicationId: string): Promise<ReportRecord | null>;
}

// ------------------------------------------------------------------ public port (sellers and admin call this)

export interface DomainVerificationView {
  readonly method: DomainMethod;
  readonly domain: string;
  readonly status: DomainStatus;
  readonly txtRecordName?: string;
  readonly txtRecordValue?: string;
  readonly emailSentToMasked?: string;
  readonly expiresAtMs: number;
  readonly verifiedAtMs: number | null;
}

export type StartDomainResult =
  | { readonly kind: "started"; readonly verification: DomainVerificationView }
  | { readonly kind: "invalid_domain"; readonly reason: DomainRejection | "email_local_part_required" }
  | { readonly kind: "email_unavailable" }
  | { readonly kind: "conflict" };

export type ConfirmDomainResult =
  | { readonly kind: "confirmed"; readonly verification: DomainVerificationView }
  | { readonly kind: "pending"; readonly verification: DomainVerificationView }
  | { readonly kind: "not_started" }
  | { readonly kind: "code_required" }
  | { readonly kind: "wrong_code"; readonly attemptsRemaining: number }
  | { readonly kind: "locked" }
  | { readonly kind: "expired" }
  | { readonly kind: "conflict" };

export interface TrademarkEvidenceView {
  readonly id: string;
  readonly source: "registry" | "manual";
  readonly office: TrademarkOffice;
  readonly registerNumber: string;
  readonly found: boolean;
  readonly ownerName: string | null;
  readonly status: MarkStatus | null;
  readonly classes: readonly number[];
  readonly ownerMatchesApplicant: "yes" | "no" | "unknown";
  readonly ownerScore: number | null;
  readonly retrievedAtMs: number;
}

export interface ManualTrademarkInput {
  readonly office: TrademarkOffice;
  readonly registerNumber: string;
  readonly found: boolean;
  readonly ownerName?: string;
  readonly markText?: string;
  readonly status?: MarkStatus;
  readonly classes?: readonly number[];
}

export type RecordTrademarkResult =
  | { readonly kind: "recorded"; readonly evidence: TrademarkEvidenceView }
  | { readonly kind: "no_trademark_claimed" };

export interface ConflictDetection {
  readonly conflicts: readonly ConflictRecord[];
  /** The caller's own priority position among all claims in the open conflicts: 1 is the first. */
  readonly priorityRank: number | null;
}

export type ResolveConflictResult =
  | { readonly kind: "resolved" | "replayed"; readonly conflict: ConflictRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_resolved_differently"; readonly conflict: ConflictRecord };

export interface BrandVerificationPort {
  startDomainVerification(i: {
    readonly snapshot: ApplicationSnapshot;
    readonly rawDomain: string;
    readonly method: DomainMethod;
    readonly emailLocalPart?: EmailLocalPart;
  }): Promise<StartDomainResult>;
  confirmDomainVerification(i: { readonly snapshot: ApplicationSnapshot; readonly code?: string }): Promise<ConfirmDomainResult>;
  runAutoChecks(snapshot: ApplicationSnapshot): Promise<AutoCheckReport>;
  recordTrademarkLookup(i: {
    readonly snapshot: ApplicationSnapshot;
    readonly mode: "auto" | "manual";
    readonly manual?: ManualTrademarkInput;
    readonly actorId: string | null;
  }): Promise<RecordTrademarkResult>;
  detectConflicts(snapshot: ApplicationSnapshot): Promise<ConflictDetection>;
  resolveConflict(i: {
    readonly applicationId: string;
    readonly outcome: ConflictOutcome;
    readonly actorId: string;
    readonly internalNote: string;
  }): Promise<ResolveConflictResult>;
}
