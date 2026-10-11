import type { CreditLot, JournalEntry, Money, StoreCreditSub } from "./bridge";

export type CreditReason = "refund" | "gift_card" | "cashback" | "referral" | "goodwill" | "order" | "expiry";
export type CreditTxnKind = "credit_added" | "credit_used" | "credit_expired";

export interface CreditTxn {
  readonly id: string;
  readonly userId: string;
  readonly kind: CreditTxnKind;
  readonly reason: CreditReason;
  readonly sub: StoreCreditSub;
  readonly amount: bigint;
  readonly ref: string | null;
  /** Unique: the write is idempotent on it. */
  readonly dedupeKey: string;
  readonly createdAtMs: number;
}

export interface NewLot extends CreditLot {
  /** Unique idempotency key of whatever created the lot (ledger entry key or refund leg). */
  readonly sourceKey: string;
}

export type HoldStatus = "held" | "captured" | "released";

export interface HoldLine {
  readonly lotId: string;
  readonly sub: StoreCreditSub;
  readonly amount: bigint;
}

export interface HoldRecord {
  readonly id: string;
  readonly userId: string;
  readonly ref: string;
  readonly status: HoldStatus;
  readonly amount: bigint;
  readonly expiresAtMs: number;
  readonly orderEntryKey: string | null;
  readonly createdAtMs: number;
  readonly resolvedAtMs: number | null;
  readonly lines: readonly HoldLine[];
}

export type PlaceHoldResult =
  | { readonly kind: "held"; readonly hold: HoldRecord }
  | { readonly kind: "exists"; readonly hold: HoldRecord }
  | { readonly kind: "insufficient"; readonly available: bigint };

export interface StoreCreditStore {
  /** Lot and its `credit_added` transaction in one unit; idempotent on `sourceKey`. */
  addLot(input: { readonly lot: NewLot; readonly txn: CreditTxn }): Promise<"added" | "exists">;
  /** Lots with remaining credit, oldest first. */
  listLots(userId: string): Promise<readonly CreditLot[]>;
  /** Plans with `planLotSpend` over locked lots and holds in one unit. Idempotent on (userId, ref). */
  placeHold(input: {
    readonly id: string;
    readonly userId: string;
    readonly ref: string;
    readonly amount: Money;
    readonly nowMs: number;
    readonly expiresAtMs: number;
  }): Promise<PlaceHoldResult>;
  getHold(userId: string, ref: string): Promise<HoldRecord | null>;
  releaseHold(userId: string, ref: string, nowMs: number): Promise<"released" | "not_found" | "not_held">;
  captureHold(input: {
    readonly userId: string;
    readonly ref: string;
    readonly orderEntryKey: string;
    readonly nowMs: number;
  }): Promise<{ readonly kind: "captured"; readonly hold: HoldRecord } | { readonly kind: "not_found" } | { readonly kind: "not_held" }>;
  listExpiredHolds(nowMs: number, limit: number): Promise<readonly HoldRecord[]>;
  /** Expired, unheld lots with credit left, platform sub-balances only. */
  listSweepable(nowMs: number, limit: number): Promise<readonly CreditLot[]>;
  /** remaining -> 0 and an `credit_expired` transaction, if still sweepable. Idempotent. */
  expireLot(input: { readonly lotId: string; readonly txn: CreditTxn }): Promise<"expired" | "stale">;
  listTransactions(
    userId: string,
    page: { readonly after: { readonly createdAtMs: number; readonly id: string } | null; readonly limit: number },
  ): Promise<readonly CreditTxn[]>;
  listUserIds(after: string | null, limit: number): Promise<readonly string[]>;
  /** Credit consumed by captured holds, per sub-balance, with the order entry that should post it. */
  listCaptured(userId: string): Promise<readonly { readonly subKey: string; readonly amount: bigint; readonly orderEntryKey: string }[]>;
}

export interface CreditLedgerPort {
  post(entry: JournalEntry): Promise<{ readonly kind: "posted" | "replayed" }>;
  /** Credit-normal balance per sub-balance key, derived from postings (never from the projection). */
  balances(userId: string): Promise<ReadonlyMap<string, bigint>>;
  hasEntry(idempotencyKey: string): Promise<boolean>;
}

export interface IdPort {
  uuidV7(): string;
}
export interface ClockPort {
  nowMs(): number;
}

/**
 * R-6: asks the business process that owns a hold whether it is still live (a non-terminal
 * checkout saga). The sweeper never releases a live hold. Satisfied by the checkout module.
 */
export interface HoldLivenessPort {
  isLive(holdRef: string): Promise<boolean>;
}
