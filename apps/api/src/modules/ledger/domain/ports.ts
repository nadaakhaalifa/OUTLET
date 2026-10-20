import type { AccountId, ChainLink, JournalEntry, PostingCommand } from "./bridge";
import type { CompletedRunData, IntegrityRunKind, LatestAttempt, StoredRun } from "./integrity-runs";

/** Minimal transaction handle the posting service needs: events go out in the SAME transaction. */
export interface LedgerTxn {
  emit(event: LedgerEvent): Promise<unknown>;
}

export interface LedgerEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: "ledger.entry_posted" | "ledger.entry_reversed";
  readonly orderingKey?: string | null;
  readonly payload: { readonly [key: string]: string | number | boolean | null };
}

export interface StoredEntry {
  readonly entry: JournalEntry;
  readonly link: ChainLink;
}

/**
 * Persistence for the posting service. Every method takes the caller's transaction handle, so the
 * posting commits or rolls back with the caller's state change and outbox events.
 */
export interface LedgerStore<T extends LedgerTxn> {
  // ISOLATION REQUIREMENT (F-14). The posting service's replay logic (find by key, take the chain
  // lock, find again, append) is only race-free under READ COMMITTED: the re-check after the lock
  // must see the winner's committed row. Under REPEATABLE READ or SERIALIZABLE the re-check reads
  // the old snapshot, so callers MUST NOT post inside such a transaction. The unique-key violation
  // that would result is mapped to `IdempotencyKeyTaken` and re-read by the service as a last line.
  /** Runs `fn` with the privilege posting needs (system role for the Postgres adapter). */
  privileged<R>(tx: T, fn: () => Promise<R>): Promise<R>;
  findByKey(tx: T, idempotencyKey: string): Promise<StoredEntry | null>;
  findById(tx: T, id: string): Promise<StoredEntry | null>;
  /**
   * Serialises chain appends for the rest of the transaction. Implementations must make a second
   * caller wait until the first commits, then the caller re-checks `findByKey`.
   */
  lockChain(tx: T): Promise<void>;
  /** Hash of the newest link, or the genesis hash when the chain is empty. Only valid after lockChain. */
  chainHead(tx: T): Promise<string>;
  /**
   * Writes the entry, its postings and its chain link. Returns the stored link. A unique violation
   * on the idempotency key must surface as `IdempotencyKeyTaken` so the service can re-read.
   */
  append(tx: T, entry: JournalEntry, link: { prevHash: string; entryHash: string }): Promise<StoredEntry>;
  reversalOf(tx: T, entryId: string): Promise<StoredEntry | null>;
}

export class IdempotencyKeyTaken extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key taken: ${idempotencyKey}`);
    this.name = "IdempotencyKeyTaken";
  }
}

export interface PostingFlags {
  /** Kill switch for gift-card sales and redemption entries. Off by default (ADR-0003). */
  giftCardSalesEnabled(): Promise<boolean> | boolean;
}

export interface PostOutcome {
  readonly kind: "posted" | "replayed";
  readonly stored: StoredEntry;
}

export interface BalanceRow {
  readonly account: AccountId;
  readonly type: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly subKey: string;
  readonly currency: string;
  /** Signed sum of postings: positive is a debit. */
  readonly raw: bigint;
  /** Natural sign of the account type: positive means the account holds what it normally holds. */
  readonly natural: bigint;
  readonly postingCount: number;
}

export interface BalanceQuery {
  readonly type?: string;
  readonly ownerType?: string;
  readonly ownerId?: string;
  readonly limit: number;
}

export interface ReadScope {
  readonly actorId: string;
  /** DB role used for RLS. Only finance and super_admin can read the ledger. */
  readonly role: "finance" | "super_admin";
}

/** Read side for finance and admin. Own transaction, RLS applies. Never joins a write transaction. */
export interface LedgerReadModel {
  balances(scope: ReadScope, query: BalanceQuery): Promise<readonly BalanceRow[]>;
  entry(scope: ReadScope, id: string): Promise<StoredEntry | null>;
}

export interface ChainRow {
  readonly entry: JournalEntry;
  readonly link: ChainLink;
}

export interface IntegritySource {
  /** Sum of all postings by currency. */
  trialBalance(): Promise<ReadonlyMap<string, bigint>>;
  /** Entries with their links ordered by seq, strictly after `afterSeq` (null = from the start). */
  chainPage(afterSeq: bigint | null, limit: number): Promise<readonly ChainRow[]>;
  /** Raw per-account balances for store_credit accounts. */
  storeCreditBalances(): Promise<readonly { account: AccountId; currency: string; raw: bigint }[]>;
}

/** Gives the job one consistent snapshot (REPEATABLE READ in Postgres). */
export interface IntegritySnapshots {
  withSnapshot<R>(fn: (source: IntegritySource) => Promise<R>): Promise<R>;
}

export interface ProjectionSource {
  /** Cached wallet projection; natural sign. Supplied by the store-credit module. */
  rows(): Promise<readonly { userId: string; sub: string; balance: bigint }[]>;
}

export type { PostingCommand };

// ---------------------------------------------------------------------------------------------
// Persisted integrity result (ADR-0046, dashboard foundations track 3).
// ---------------------------------------------------------------------------------------------

export interface IntegrityAuditInput {
  /** Occurred-at of the audit row (also selects the monthly chain `ledger-integrity:YYYY-MM`). */
  readonly atMs: number;
  readonly runId: string;
  readonly ok: boolean;
  readonly reportSha256: string;
}

/** The audit insert failed, so the whole completed-run transaction rolled back (H4). */
export class IntegrityAuditWriteError extends Error {
  constructor() {
    super("integrity audit write failed");
    this.name = "IntegrityAuditWriteError";
  }
}

/**
 * A final row for this attempt already exists (unique index lir_attempt_final_uq, 0093). The earlier
 * commit is the record, so the recorder treats this as success: no second completed row, no second audit row.
 */
export class IntegrityAlreadyRecordedError extends Error {
  constructor() {
    super("integrity run already recorded for this attempt");
    this.name = "IntegrityAlreadyRecordedError";
  }
}

export interface IntegrityRunIds {
  /** Primary key of the row this call writes (a different id per row). */
  readonly id: string;
  /** Groups the `started` row with its final row. */
  readonly attemptId: string;
  readonly kind: IntegrityRunKind;
}

/** Writes run rows. Rows are append-only: there is no update. Runs under the system role. */
export interface IntegrityRunStore {
  recordStarted(a: IntegrityRunIds): Promise<void>;
  /**
   * ONE transaction: the completed row, its drift sample rows AND the `ledger.integrity.run` audit row.
   * Any failure (audit included, as `IntegrityAuditWriteError`) leaves nothing behind.
   */
  completeRun(a: IntegrityRunIds & { readonly data: CompletedRunData; readonly audit: IntegrityAuditInput }): Promise<void>;
  recordFailure(a: IntegrityRunIds & { readonly outcome: "error" | "timeout"; readonly errorCode: string }): Promise<void>;
}

export interface IntegrityReadScope {
  readonly actorId: string | null;
  /** DB role used for RLS: finance (HTTP read path) or system (metrics exporter). */
  readonly role: "finance" | "super_admin" | "system";
}

export interface IntegritySnapshot {
  readonly latest: StoredRun | null;
  readonly latestAttempt: LatestAttempt | null;
  readonly firstStartedAtMs: number | null;
}

/** Opaque to callers: `ts` is the row's started_at as an ISO string, `id` its uuid. */
export interface RunCursor {
  readonly ts: string;
  readonly id: string;
}

export interface IntegrityRunReader {
  /** Latest completed run, latest attempt and the table's first row, read in one transaction. */
  snapshot(scope: IntegrityReadScope): Promise<IntegritySnapshot>;
  /** Completed runs newest first, keyset on (started_at, id). */
  listCompleted(scope: IntegrityReadScope, q: { readonly limit: number; readonly before: RunCursor | null }): Promise<{ readonly items: readonly StoredRun[]; readonly next: RunCursor | null }>;
}
