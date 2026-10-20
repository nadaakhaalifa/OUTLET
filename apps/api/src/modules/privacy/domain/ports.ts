import type { ConsentHistory, ConsentRecord } from "@outlet/privacy";
import type {
  BreachEntry,
  DeletionRequest,
  DeletionSnapshot,
  ErasurePlan,
  ExportRequest,
  PrivacyRequest,
} from "./bridge";

export type { ExporterDescriptor, ExporterExemption } from "./bridge";

/** Outbox event written in the SAME transaction as the state change (spec A2.7). Payloads are P0 to P2. */
export interface OutboxDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

/** Append-only consent store. Records are never updated or deleted by this port. */
export interface ConsentRepository {
  history(userId: string): Promise<ConsentHistory>;
  /** Appends records and their outbox events atomically. */
  append(records: readonly ConsentRecord[], events: readonly OutboxDraft[]): Promise<void>;
}

export type InsertOutcome<R> = { readonly kind: "created" | "existing"; readonly request: R };
export type UpdateOutcome = "ok" | "conflict" | "not_found";

/** Persistence for export and deletion requests. Every write carries its outbox events. */
export interface PrivacyRequestRepository {
  /** Creates the request unless the user already has an open one of that kind (then returns it). */
  insertExport(request: ExportRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<ExportRequest>>;
  insertDeletion(request: DeletionRequest, events: readonly OutboxDraft[]): Promise<InsertOutcome<DeletionRequest>>;
  get(id: string): Promise<PrivacyRequest | null>;
  /** Most recent export or deletion of the user (open ones win). */
  findLatest(userId: string, kind: "export"): Promise<ExportRequest | null>;
  findLatest(userId: string, kind: "delete"): Promise<DeletionRequest | null>;
  /** Compare-and-set on `version`: succeeds only when the stored version is `next.version - 1`. */
  update(next: PrivacyRequest, events: readonly OutboxDraft[]): Promise<UpdateOutcome>;
  listPendingExports(limit: number): Promise<readonly ExportRequest[]>;
  listExpiredExports(nowMs: number, limit: number): Promise<readonly ExportRequest[]>;
  /** Deletions needing worker action: cooling ended, on hold (re-check) or erasing (resume). */
  listDueDeletions(nowMs: number, limit: number): Promise<readonly DeletionRequest[]>;
  /** OPEN requests only (filter applied before `limit`), oldest first, so overdue ones come first. */
  listForQueue(limit: number): Promise<readonly PrivacyRequest[]>;
  /** Most recently requested CLOSED requests, newest first (queue view with includeClosed). */
  listRecentClosed(limit: number): Promise<readonly PrivacyRequest[]>;
  /** Every export request of the subject, any status (erasure removes their artifacts). */
  listExportsForUser(userId: string): Promise<readonly ExportRequest[]>;
}

export interface BreachRepository {
  insert(entry: BreachEntry, events: readonly OutboxDraft[]): Promise<void>;
  get(id: string): Promise<BreachEntry | null>;
  update(next: BreachEntry, events: readonly OutboxDraft[]): Promise<UpdateOutcome>;
  list(limit: number): Promise<readonly BreachEntry[]>;
}

/** Orders, returns, disputes and credit, owned by other modules. Fake in tests (spec section 2 Rules). */
export interface BlockersPort {
  snapshot(userId: string): Promise<DeletionSnapshot>;
}

export type ExportRow = Readonly<Record<string, unknown>>;
export interface ExportSection {
  /** Rows per inventory table. Only tables the exporter declared may appear. */
  readonly tables: Readonly<Record<string, readonly ExportRow[]>>;
}

/** One exporter per owning module. It must return the subject's P2/P3 fields for its declared tables. */
export interface ExporterPort {
  readonly key: string;
  readonly tables: readonly string[];
  collect(userId: string): Promise<ExportSection>;
  /**
   * Declared tables this exporter cannot serve on this deployment (the owning module is not
   * composed or the table does not exist yet). They are omitted from the archive and listed in
   * its manifest `gaps`, never exported as an empty table that looks complete.
   */
  gaps?(): Promise<readonly string[]>;
}

/** Decrypt-only view of the field cipher (KMS envelope). P2/P3 fields are decrypted only through this port. */
export interface FieldDecryptPort {
  decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array>;
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresAtMs: number;
}

export interface ObjectStorePort {
  /** False on a deployment without a real object store: exports then wait in `requested` instead of failing. */
  readonly configured?: boolean;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  signGetUrl(key: string, ttlSeconds: number, nowMs: number): Promise<SignedUrl>;
}

/**
 * A step that must complete BEFORE the user's rows are erased (it needs the user id, which erasure tombstones): for
 * example NULLing the pseudonymous shopper keys in seller-analytics facts (H3). MUST be idempotent. A throw makes the
 * request fail this attempt (backoff, then parked for the DPO) and the erasure does not proceed.
 */
export interface PreErasureStepPort {
  readonly name: string;
  run(userId: string): Promise<void>;
}

/** Applies an erasure plan for one user. MUST be idempotent: a crashed run is resumed by re-running it. */
export interface ErasureExecutorPort {
  /**
   * `artifactKeys` are the subject's export ZIP object keys: the executor MUST delete them (object
   * deletion of an absent key is a no-op) before returning, so "erased" never leaves personal data
   * in the object store.
   */
  execute(input: {
    readonly userId: string;
    readonly pseudonym: string;
    readonly plan: ErasurePlan;
    readonly artifactKeys?: readonly string[];
  }): Promise<void>;
}
