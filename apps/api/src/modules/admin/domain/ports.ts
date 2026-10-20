import type {
  AdminRoleName,
  ApprovalKind,
  ApprovalRecord,
  ApprovalState,
  ElevationRecord,
  KycState,
  ReviewState,
  SuspensionReview,
} from "./bridge";

export interface ApprovalFilter {
  readonly states?: readonly ApprovalState[];
  readonly kinds?: readonly ApprovalKind[];
  readonly requesterId?: string;
  /** Row visible when requested by `actorId` or when its kind is in `kinds`; applied before `limit`. */
  readonly visibleTo?: { readonly actorId: string; readonly kinds: readonly ApprovalKind[] };
  readonly limit: number;
}

/** Approvals, elevations and suspension reviews. Every write is compare-and-set on the old state. */
export interface AdminStore {
  insertApproval(r: ApprovalRecord): Promise<void>;
  getApproval(id: string): Promise<ApprovalRecord | null>;
  /** Persists a decision. False when the row is no longer REQUESTED (lost a race). */
  saveApprovalDecision(r: ApprovalRecord): Promise<boolean>;
  listApprovals(f: ApprovalFilter): Promise<readonly ApprovalRecord[]>;

  /** One transaction: the approval and the elevation it gates appear together or not at all. */
  createElevationWithApproval(approval: ApprovalRecord, elevation: ElevationRecord): Promise<void>;
  getElevation(id: string): Promise<ElevationRecord | null>;
  /** False when the stored state is no longer `expected`. */
  saveElevation(e: ElevationRecord, expected: ElevationRecord["state"]): Promise<boolean>;
  /** ACTIVE and not past expiry at `nowMs`. */
  liveElevations(userId: string, nowMs: number): Promise<readonly ElevationRecord[]>;
  listElevations(f: { readonly userId?: string; readonly activeAtMs?: number; readonly limit: number }): Promise<readonly ElevationRecord[]>;

  insertReview(r: SuspensionReview): Promise<boolean>;
  getReview(id: string): Promise<SuspensionReview | null>;
  findOpenReviewBySeller(sellerId: string): Promise<SuspensionReview | null>;
  saveReview(r: SuspensionReview): Promise<boolean>;
  listReviews(f: { readonly state?: ReviewState; readonly limit: number }): Promise<readonly SuspensionReview[]>;
}

export interface SellerKycView {
  readonly sellerId: string;
  readonly state: KycState;
  readonly storeCount: number;
  readonly storeNames: readonly string[];
  readonly updatedAtMs: number;
}

/** Read model and state cache over the seller KYC state (stores.seller_kyc_state). */
export interface SellerKycPort {
  list(f: { readonly states?: readonly KycState[]; readonly limit: number }): Promise<readonly SellerKycView[]>;
  get(sellerId: string): Promise<SellerKycView | null>;
  /** Compare-and-set. False when the stored state is not `from`. */
  setState(sellerId: string, from: KycState, to: KycState, nowMs: number): Promise<boolean>;
}

export interface FlagView {
  readonly key: string;
  readonly kind: "kill_switch" | "release";
  readonly description: string;
  readonly enabled: boolean;
  /** True when the backend holds no explicit value and the fail-closed default applies. */
  readonly isDefault: boolean;
}

/**
 * Backend behind the admin flag API. Production wraps the OpenFeature-compatible provider and the
 * registry of packages/feature-flags; the registry decides which keys exist.
 */
export interface FlagAdminBackend {
  list(): Promise<readonly FlagView[]>;
  get(key: string): Promise<FlagView | null>;
  /** Sets an explicit value. Returns the view after the change, or null for an unknown key. */
  set(key: string, enabled: boolean): Promise<FlagView | null>;
}

export interface AdminAuditEntry {
  readonly action: string;
  /** null for system actors (automatic suspensions). */
  readonly actorId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  /** Mandatory for PII views, elevation and break-glass. */
  readonly reasonCode: string | null;
  /** PII-redacted: ids, states, counts, field NAMES. Never values. */
  readonly diff: Readonly<Record<string, string | number | boolean | null>>;
  readonly requestId: string | null;
  readonly atMs: number;
}

/** Appends to the hash-chained audit log. A failure must fail the action (closed). */
export interface AdminAuditPort {
  append(e: AdminAuditEntry): Promise<void>;
}

export const PII_FIELDS = ["display_name", "phone", "email", "default_address"] as const;
export type PiiField = (typeof PII_FIELDS)[number];

export interface PiiSourcePort {
  /** null when the subject does not exist. Only requested fields are returned. */
  fetch(subjectUserId: string, fields: readonly PiiField[]): Promise<Readonly<Partial<Record<PiiField, string>>> | null>;
}

export type { AdminRoleName };
