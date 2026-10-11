import type { AffordabilityContext, CapDecision, Commitment, PlanItem, SpendEvent } from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) ----------------------

/** Privacy module: is the `budget_insights` consent currently granted. Never pre-ticked. */
export interface BudgetConsentPort {
  isGranted(userId: string): Promise<boolean>;
}

/** Envelope encryption of one field. `aad` binds the ciphertext to its row and purpose (spec T5). */
export interface FieldCipherPort {
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array>;
}

/** Orders module: net spend movements for one shopper in a window (reconciliation and backfill). */
export interface OrderSpendSourcePort {
  listSpend(userId: string, fromMs: number, toMs: number): Promise<readonly SpendEvent[]>;
}

/** Cart module: the shopper's own bag total in piastres. */
export interface BagTotalPort {
  bagTotal(userId: string): Promise<bigint>;
}

/** Wishlists module: items to plan, null when the list does not exist or is not the caller's. */
export interface WishlistPlanSourcePort {
  planItems(userId: string, wishlistId: string | null): Promise<readonly PlanItem[] | null>;
}

/** packages/feature-flags: `release.budget_suite` and `kill.budget_caps`. Fail closed in production. */
export interface BudgetFlagsPort {
  suiteEnabled(): Promise<boolean>;
  capsEnabled(): Promise<boolean>;
}

// ---- the request-time filter other modules may consume ---------------------------------------

/**
 * Implemented by `budget`, consumed by feed, search, stylist and wishlist on the shopper's own
 * request. Returns ONLY a price ceiling in piastres (null = no filter). Callers must not persist,
 * log, cache across requests or forward it to sellers, ads or ranking features (spec 12).
 */
export interface AffordabilityFilterPort {
  priceCeilingFor(userId: string, context: AffordabilityContext): Promise<bigint | null>;
}

/** Consumed by checkout. Fails open for soft caps and closed only for an already active hard cap. */
export interface CheckoutCapPort {
  authorize(input: {
    readonly userId: string;
    readonly orderKey: string;
    readonly orderTotal: bigint;
    /** Soft cap: when the shopper started the 10 s hold, as reported by the client and verified here. */
    readonly softHeldSinceMs: number | null;
  }): Promise<CapDecision>;
  /** Releases the provisional spend recorded by `authorize` when the order fails or is abandoned. */
  release(userId: string, orderKey: string): Promise<void>;
}

// ---- repository (ciphertext only for P3 fields) ---------------------------------------------

export interface BudgetRecord {
  readonly userId: string;
  readonly amountEnc: Uint8Array;
  readonly perCategoryEnc: Uint8Array | null;
  readonly payday: number;
  readonly capMode: "off" | "soft" | "hard";
  readonly holdUntilMs: number | null;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CycleRecord {
  readonly userId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly spentEnc: Uint8Array;
  readonly refundedEnc: Uint8Array;
  readonly refundReceivedEnc: Uint8Array;
  readonly rolledAtMs: number;
  readonly updatedAtMs: number;
}

export interface SpendEventRecord {
  readonly userId: string;
  readonly key: string;
  readonly kind: "placed" | "refund" | "cod_refusal";
  readonly orderPlacedAtMs: number;
  readonly occurredAtMs: number;
  readonly detailEnc: Uint8Array;
}

export interface CommitmentRecord {
  readonly userId: string;
  readonly provider: string;
  readonly source: "provider" | "user";
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly monthlyEnc: Uint8Array;
}

export interface GoalRecord {
  readonly id: string;
  readonly userId: string;
  readonly titleEnc: Uint8Array;
  readonly targetAmountEnc: Uint8Array;
  readonly targetDate: string | null;
}

export interface UnlockRequestRecord {
  readonly id: string;
  readonly userId: string;
  readonly requestedAtMs: number;
  readonly unlockAtMs: number;
}

/** Outbox events (same transaction as the state change). No amounts, no names (spec Events). */
export type BudgetEvent =
  | { readonly type: "budget.set"; readonly userId: string; readonly capMode: "off" | "soft" | "hard"; readonly hasCategories: boolean }
  | { readonly type: "budget.cycle_rolled"; readonly userId: string; readonly cycleStartMs: number }
  | { readonly type: "budget.cap_unlock_requested"; readonly userId: string; readonly unlockAtMs: number }
  | { readonly type: "budget.data_purged"; readonly userId: string; readonly reason: "consent_withdrawn" | "user_request" | "account_deleted" };

/** Everything a use case may do for one user inside one transaction. */
export interface BudgetTx {
  getBudget(): Promise<BudgetRecord | null>;
  putBudget(record: BudgetRecord): Promise<void>;
  getCycle(startMs: number): Promise<CycleRecord | null>;
  /** Upsert by (user, cycle start). Returns "inserted" when the cycle row is new. */
  putCycle(record: CycleRecord): Promise<"inserted" | "updated">;
  /** Events whose placement or occurrence is at or after `sinceMs`, oldest first. */
  listSpendEvents(sinceMs: number): Promise<readonly SpendEventRecord[]>;
  insertSpendEvent(record: SpendEventRecord): Promise<"inserted" | "exists">;
  deleteSpendEvent(key: string): Promise<boolean>;
  listCommitments(): Promise<readonly CommitmentRecord[]>;
  replaceCommitments(source: "provider" | "user", records: readonly CommitmentRecord[]): Promise<void>;
  listGoals(): Promise<readonly GoalRecord[]>;
  insertUnlockRequest(record: UnlockRequestRecord): Promise<void>;
  latestUnlockRequest(): Promise<UnlockRequestRecord | null>;
  listCycles(limit: number): Promise<readonly CycleRecord[]>;
  /** Removes every row of this user across all budget tables. Returns the number of tables touched with rows. */
  deleteAll(): Promise<number>;
  emit(events: readonly BudgetEvent[]): Promise<void>;
}

export interface BudgetStore {
  /** One transaction, serialized per user (row lock on `budgets`; spec edge case on concurrent orders). */
  run<T>(userId: string, fn: (tx: BudgetTx) => Promise<T>): Promise<T>;
  /** One transaction without the exclusive lock. Must not write. */
  read<T>(userId: string, fn: (tx: BudgetTx) => Promise<T>): Promise<T>;
  /** Users that hold any budget data, keyset by user id. */
  usersWithBudget(after: string | null, limit: number): Promise<readonly string[]>;
}

export type { Commitment };
