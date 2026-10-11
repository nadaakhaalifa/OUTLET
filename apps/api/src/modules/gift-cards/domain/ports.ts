import type {
  ContributionStatus,
  DeliveryChannel,
  GiftCardDesign,
  GiftCardState,
  PotState,
  RedemptionView,
} from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) -----------------------

/** KMS-held HMAC key with versions, so a rotation never invalidates issued cards (spec 15.1). */
export interface SecretPort {
  currentVersion(): Promise<number>;
  /** HMAC-SHA256 of `data` under key `version`, lowercase hex. Throws for an unknown version. */
  hmac(version: number, data: string): Promise<string>;
  /** Versions a lookup must try, newest first. */
  activeVersions(): Promise<readonly number[]>;
}

/** CSPRNG. Production uses node:crypto randomBytes; tests may script it. */
export interface RandomPort {
  bytes(n: number): Uint8Array;
}

/** Envelope encryption of one field, bound to its row by `aad` (spec T5). */
export interface FieldCipherPort {
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<Uint8Array>;
}

/**
 * Store credit module: moves value into the shopper's `gift_card:{cardId}` sub-balance by the
 * ADR-0021 posting (Dr gift_card_liability / Cr store_credit). Idempotent on `idempotencyKey`.
 */
export interface StoreCreditPort {
  /**
   * Outcomes: a resolved promise = credited (idempotent, a replay returns the same entry);
   * `StoreCreditRejectedError` = a definite, typed refusal (nothing was or will be credited);
   * any other throw = UNKNOWN (timeout, dropped connection): the credit may have committed, so the
   * caller must keep the redemption pending and retry with the SAME key, never reverse the card.
   */
  creditGiftCard(input: {
    readonly userId: string;
    readonly cardId: string;
    readonly amount: bigint;
    readonly expiresAtMs: number;
    readonly scopeStoreId: string | null;
    readonly idempotencyKey: string;
  }): Promise<{ readonly journalEntryId: string }>;
}

/** Definite refusal by the store credit module (kill switch, expired lot, blocked user, scope). */
export class StoreCreditRejectedError extends Error {
  constructor(readonly reason: "kill_switch" | "insufficient" | "expired_lot" | "blocked" | "scope" | "invalid") {
    super(`store credit rejected: ${reason}`);
    this.name = "StoreCreditRejectedError";
  }
}

/** Append-only audit log (hash chained in production). Never receives a code or a code hash. */
export interface AuditPort {
  record(entry: {
    readonly action:
      | "gift_card.redeem_attempt"
      | "gift_card.redeemed"
      | "gift_card.issued"
      | "gift_card.voided"
      | "gift_card.expired"
      | "gift_pot.closed";
    readonly actorId: string | null;
    readonly targetId: string | null;
    readonly outcome: "ok" | "wrong" | "throttled" | "refused" | "n/a";
    readonly deviceHash: string | null;
    readonly ipHash: string | null;
    readonly atMs: number;
  }): Promise<void>;
}

/** packages/feature-flags: `kill.gift_card_sales` and `kill.gift_card_redemption`. Default off, fail closed. */
export interface GiftCardFlagsPort {
  salesEnabled(): Promise<boolean>;
  redemptionEnabled(): Promise<boolean>;
}

/** Purchaser age check from the privacy module's age bands (B6). */
export interface AgeGatePort {
  meetsMinimumAge(userId: string, minimumAge: 18 | 21): Promise<boolean>;
}

export type PaymentCancelResult = "cancelled" | "captured" | "unknown";

/** Payments module: creates the PSP intent. The card is paid by the PSP only, never by store credit. */
export interface PaymentIntentPort {
  create(input: {
    readonly referenceType: "gift_card" | "gift_pot_contribution";
    readonly referenceId: string;
    readonly userId: string;
    readonly amount: bigint;
    readonly method: string;
    readonly requireThreeDs: boolean;
    readonly idempotencyKey: string;
  }): Promise<{ readonly paymentIntentId: string; readonly clientAction: "redirect" | "native_sheet" | "none" }>;
  /** Refunds one captured payment to its original method (RefundRouter). Idempotent on `idempotencyKey`. */
  refund(input: {
    readonly paymentIntentId: string;
    readonly amount: bigint;
    readonly idempotencyKey: string;
  }): Promise<{ readonly ok: boolean }>;
  /**
   * Voids an uncaptured intent. `cancelled` = PSP confirmed the void; `captured` = the payer had
   * already paid (money must be refunded); `unknown` = not confirmed, keep it for reconciliation.
   */
  cancel(paymentIntentId: string): Promise<PaymentCancelResult>;
}

/** Notifications module: sends the code to the recipient (WhatsApp, then SMS, then email failover). */
export interface DeliveryPort {
  deliver(input: {
    readonly cardId: string;
    readonly channel: DeliveryChannel;
    readonly contact: string | null;
    readonly message: string | null;
    readonly design: GiftCardDesign;
    readonly code: string;
    readonly last4: string;
    /** Null = send now. The code is never stored, so a scheduled send is held by the provider. */
    readonly sendAtMs: number | null;
  }): Promise<{ readonly ok: boolean }>;
}

// ---- records ----------------------------------------------------------------------------------

export interface CardRecord {
  readonly id: string;
  readonly purchaserId: string;
  readonly codeHash: string | null;
  readonly codeKeyVersion: number | null;
  readonly last4: string | null;
  readonly amount: bigint;
  readonly remaining: bigint;
  readonly status: GiftCardState;
  readonly scopeStoreId: string | null;
  readonly expiresAtMs: number | null;
  readonly design: GiftCardDesign;
  readonly recipientChannel: DeliveryChannel;
  readonly recipientContactEnc: Uint8Array | null;
  readonly messageEnc: Uint8Array | null;
  readonly scheduledAtMs: number | null;
  readonly potId: string | null;
  readonly paymentIntentId: string | null;
  readonly idempotencyKey: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly issuedAtMs: number | null;
  readonly deliveredAtMs: number | null;
}

export type CardPatch = Partial<
  Pick<
    CardRecord,
    | "codeHash"
    | "codeKeyVersion"
    | "last4"
    | "status"
    | "expiresAtMs"
    | "paymentIntentId"
    | "issuedAtMs"
    | "deliveredAtMs"
    | "remaining"
  >
>;

export interface RedemptionRecord {
  readonly id: string;
  readonly cardId: string;
  readonly userId: string;
  readonly amount: bigint;
  readonly status: "pending" | "completed" | "reversed";
  readonly statusBefore: "ISSUED" | "DELIVERED";
  readonly journalEntryId: string | null;
  readonly createdAtMs: number;
}

export interface PotRecord {
  readonly id: string;
  readonly organiserId: string;
  readonly organiserNickname: string;
  readonly target: bigint;
  readonly closesAtMs: number;
  readonly status: PotState;
  readonly cardId: string;
  readonly shareTokenHash: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly closedAtMs: number | null;
}

export interface ContributionRecord {
  readonly id: string;
  readonly potId: string;
  readonly userId: string;
  readonly amount: bigint;
  readonly paymentIntentId: string | null;
  readonly status: ContributionStatus;
  readonly idempotencyKey: string;
  readonly createdAtMs: number;
}

export interface OutboxDraft {
  readonly type:
    | "gift_card.issued"
    | "gift_card.delivered"
    | "gift_card.redeemed"
    | "gift_card.expired"
    | "gift_card.voided"
    | "gift_pot.closed";
  readonly aggregateType: "gift_card" | "gift_pot";
  readonly aggregateId: string;
  /** Ids, enums and integer piastres only. Never a code, a hash, a contact or a message. */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AttemptRecord {
  readonly id: string;
  readonly accountId: string;
  readonly deviceHash: string;
  readonly ipHash: string;
  readonly outcome: "ok" | "wrong" | "throttled" | "pending";
  readonly atMs: number;
}

export type AdmitAttempt =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly scope: "account" | "device" | "ip"; readonly retryAfterMs: number };

export type ConfirmApply =
  | { readonly kind: "applied" }
  | { readonly kind: "excess"; readonly reason: "pot_closed" | "overshoot"; readonly contribution: ContributionRecord }
  | { readonly kind: "replayed" }
  | { readonly kind: "not_found" };

export type CasResult = { readonly kind: "ok"; readonly card: CardRecord } | { readonly kind: "conflict" } | { readonly kind: "not_found" };

export type BeginRedemption =
  | { readonly kind: "ok"; readonly redemption: RedemptionRecord; readonly card: CardRecord; readonly full: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable"; readonly status: GiftCardState }
  | { readonly kind: "empty" }
  | { readonly kind: "exceeds_balance"; readonly remaining: bigint };

/**
 * Persistence for cards and pots. Every method is atomic. Outbox drafts are written in the same
 * transaction as the state change (A2.7). In-memory and Kysely share one contract suite.
 */
export interface GiftCardStore {
  insertCard(card: CardRecord, events: readonly OutboxDraft[]): Promise<{ readonly kind: "created" | "duplicate"; readonly card: CardRecord }>;
  getCard(id: string): Promise<CardRecord | null>;
  findByCodeHash(hash: string): Promise<CardRecord | null>;
  listByPurchaser(userId: string, limit: number): Promise<readonly CardRecord[]>;
  /** Optimistic update; also returns `conflict` when the version moved. */
  updateCard(id: string, expectedVersion: number, patch: CardPatch, events: readonly OutboxDraft[]): Promise<CasResult>;
  listExpirable(nowMs: number, limit: number): Promise<readonly string[]>;

  /**
   * Row-locked: checks balance and state, decrements `remaining`, flips to REDEEMED at zero and
   * records a pending redemption. Conservation: sum(non-reversed redemptions) + remaining === amount.
   */
  beginRedemption(input: {
    readonly cardId: string;
    readonly userId: string;
    readonly requested: bigint | null;
    readonly redemptionId: string;
    readonly nowMs: number;
  }): Promise<BeginRedemption>;
  completeRedemption(redemptionId: string, journalEntryId: string, nowMs: number, events: readonly OutboxDraft[]): Promise<void>;
  /** Compensation when the store credit posting failed: restores balance and state. */
  reverseRedemption(redemptionId: string): Promise<void>;
  /** Pending redemptions created before `olderThanMs`, oldest first (resume sweeper). */
  listPendingRedemptions(olderThanMs: number, limit: number): Promise<readonly RedemptionRecord[]>;
  listRedemptions(cardId: string): Promise<readonly RedemptionRecord[]>;

  recordAttempt(a: AttemptRecord): Promise<void>;
  /**
   * Atomic throttle: inside one critical section (advisory locks on account, device and ip) counts
   * the failures in each window, then records the attempt as `pending` (allowed) or `throttled`.
   * Parallel attempts therefore cannot all pass the limit. `finalizeAttempt` sets the outcome.
   */
  admitAttempt(a: Omit<AttemptRecord, "outcome">): Promise<AdmitAttempt>;
  finalizeAttempt(id: string, outcome: "ok" | "wrong"): Promise<void>;
  failureTimes(
    scope: { readonly accountId: string } | { readonly deviceHash: string } | { readonly ipHash: string },
    sinceMs: number,
  ): Promise<readonly number[]>;
  purgeAttemptsBefore(cutoffMs: number): Promise<number>;

  insertPot(
    pot: PotRecord,
    card: CardRecord,
    events: readonly OutboxDraft[],
  ): Promise<{ readonly kind: "created" | "duplicate"; readonly pot: PotRecord; readonly card: CardRecord }>;
  getPot(id: string): Promise<PotRecord | null>;
  getPotByTokenHash(hash: string): Promise<PotRecord | null>;
  /** Optimistic; `card` is the POT_OPEN card changed in the same transaction when closing. */
  updatePot(
    id: string,
    expectedVersion: number,
    patch: { readonly status: PotState; readonly closedAtMs?: number },
    cardPatch: { readonly patch: CardPatch; readonly events: readonly OutboxDraft[] } | null,
    events: readonly OutboxDraft[],
  ): Promise<{ readonly kind: "ok"; readonly pot: PotRecord } | { readonly kind: "conflict" } | { readonly kind: "not_found" }>;
  listDuePots(nowMs: number, limit: number): Promise<readonly string[]>;
  listPotsInState(state: PotState, limit: number): Promise<readonly string[]>;
  insertContribution(c: ContributionRecord): Promise<{ readonly kind: "created" | "duplicate"; readonly contribution: ContributionRecord }>;
  getContribution(id: string): Promise<ContributionRecord | null>;
  /** `onlyFrom` makes the write conditional on the current status (compare-and-set); null = no match. */
  updateContribution(
    id: string,
    patch: { readonly status: ContributionStatus; readonly paymentIntentId?: string },
    onlyFrom?: readonly ContributionStatus[],
  ): Promise<ContributionRecord | null>;
  /**
   * Atomic apply of a success webhook: locks the pot row, and marks the contribution `paid` only
   * when the pot is OPEN and paid + amount <= target. Otherwise reports `excess` (caller refunds).
   * Accepts pending, pending_void and cancelled (a late success after a void is never dropped).
   */
  confirmContribution(contributionId: string, paymentIntentId: string): Promise<ConfirmApply>;
  listContributionsInStatus(status: ContributionStatus, limit: number): Promise<readonly ContributionRecord[]>;
  listContributions(potId: string): Promise<readonly ContributionRecord[]>;
}

export interface CardView {
  readonly id: string;
  readonly status: GiftCardState;
  readonly amount: bigint;
  readonly remaining: bigint;
  readonly redemption: RedemptionView;
  readonly last4: string | null;
  readonly expiresAtMs: number | null;
  readonly design: GiftCardDesign;
  readonly scopeStoreId: string | null;
  readonly createdAtMs: number;
  readonly potId: string | null;
}
