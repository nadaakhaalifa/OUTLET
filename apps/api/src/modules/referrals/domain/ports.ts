import type { ReferralStatus, RejectReason } from "./rules";

export interface Clock {
  nowMs(): number;
}

export interface IdPort {
  uuidV7(): string;
}

export interface TokenEntropy {
  randomBytes(length: number): Uint8Array;
}

export interface ReferralCodeRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly code: string;
  readonly createdAtMs: number;
}

export interface Referral {
  readonly id: string;
  readonly codeId: string;
  readonly referrerId: string;
  readonly refereeId: string;
  readonly status: ReferralStatus;
  readonly rejectReason: RejectReason | null;
  /** SHA-256 hex values only. */
  readonly refereeDeviceHashes: readonly string[];
  readonly orderId: string | null;
  readonly paymentFingerprintHash: string | null;
  readonly rewardAmount: bigint | null;
  readonly attributedAtMs: number;
  readonly settledAtMs: number | null;
}

/**
 * Events leave through the outbox in the same transaction as the state change. RewardEarned and
 * PlusMonthEarned are INTENTS: the rewards/store-credit modules decide whether and how to issue.
 */
export type ReferralEvent =
  | { readonly type: "referral.attributed"; readonly referralId: string; readonly referrerId: string; readonly refereeId: string }
  | {
      readonly type: "referral.attribution_rejected";
      readonly referralId: string;
      readonly referrerId: string;
      readonly refereeId: string;
      readonly reason: RejectReason;
    }
  | {
      readonly type: "referral.reward_earned";
      readonly referralId: string;
      readonly beneficiaryUserId: string;
      readonly amount: bigint;
      readonly currency: "EGP";
      readonly kind: "referral_credit";
      /** Stable: the consumer dedupes on it. */
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "referral.plus_month_earned";
      readonly referralId: string;
      readonly beneficiaryUserId: string;
      readonly months: number;
      readonly idempotencyKey: string;
    }
  | { readonly type: "referral.rejected"; readonly referralId: string; readonly referrerId: string; readonly reason: RejectReason };

export type CodeInsert =
  | { readonly kind: "created" | "existing"; readonly record: ReferralCodeRecord }
  | { readonly kind: "code_taken" };

export interface SettleInput {
  readonly referralId: string;
  readonly status: "rewarded" | "rejected";
  readonly rejectReason: RejectReason | null;
  readonly orderId: string;
  readonly paymentFingerprintHash: string | null;
  readonly rewardAmount: bigint | null;
  readonly settledAtMs: number;
  /** Required for status "rewarded": enforces cap + milestone atomically. */
  readonly guard?: RewardGuard;
}

/**
 * Cap and milestone are decided INSIDE the settle transaction, serialised per referrer, so
 * concurrent closures for different friends of one referrer cannot exceed the cap or double/skip
 * a milestone. The caller supplies the reward events; the store appends the Plus-month intent.
 */
export interface RewardGuard {
  readonly referrerId: string;
  readonly windowStartMs: number;
  readonly maxInWindow: number;
  readonly milestoneEvery: number;
  readonly milestonePlusMonths: number;
}

export type SettleResult =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "applied";
      readonly outcome: "rewarded" | "capped" | "already_settled" | "recorded";
      /** Months granted by this settlement (milestone index computed under the lock). */
      readonly plusMonths: number;
    };

export interface ReferralStore {
  /** Returns the owner's code, creating `candidate` if they have none. */
  ensureCode(input: { readonly id: string; readonly ownerUserId: string; readonly code: string; readonly nowMs: number }): Promise<CodeInsert>;
  findCode(code: string): Promise<ReferralCodeRecord | null>;
  getByReferee(refereeId: string): Promise<Referral | null>;
  listByReferrer(referrerId: string): Promise<readonly Referral[]>;
  /** Rewarded referrals of this referrer settled at or after `sinceMs`. */
  countRewarded(referrerId: string, sinceMs: number | null): Promise<number>;
  /** "exists" when the friend already has a referral (first attribution wins). */
  insertAttribution(referral: Referral, events: readonly ReferralEvent[]): Promise<"inserted" | "exists">;
  /**
   * Inbox + effect + outbox in ONE transaction. `change` null records the message as handled
   * without touching a referral (an order that belongs to nobody's referral). A repeated
   * messageId returns "duplicate" and changes nothing.
   */
  settle(input: {
    readonly consumer: string;
    readonly messageId: string;
    readonly change: SettleInput | null;
    readonly events: readonly ReferralEvent[];
  }): Promise<SettleResult>;
}

export interface PartyProfileView {
  readonly ageYears: number | null;
  readonly phoneIsNew: boolean;
  readonly priorOrderCount: number;
  readonly deviceHashes: readonly string[];
  readonly paymentFingerprintHashes: readonly string[];
  readonly deliveredOrderCount: number;
  readonly active: boolean;
}

/** Read side of users/orders/devices. Owned by other modules; wired by the integrator. */
export interface ReferralIdentityPort {
  profile(userId: string): Promise<PartyProfileView | null>;
}

/** Device attestation (App Attest / Play Integrity). Modelled as a port; verification lives in auth. */
export interface AppAttestPort {
  verify(input: { readonly userId: string; readonly assertion: string | null }): Promise<boolean>;
}

/** Consumed from the orders module (return window closed). Delivered through the inbox. */
export interface OrderClosedMessage {
  readonly messageId: string;
  readonly orderId: string;
  readonly userId: string;
  readonly isFirstOrder: boolean;
  readonly merchandiseSubtotal: bigint;
  readonly refunded: boolean;
  readonly paymentMethod: "cod" | "prepaid";
  readonly deliveredAtMs: number | null;
  readonly closedAtMs: number;
  /** SHA-256 hex of the PSP card fingerprint, never the fingerprint itself. */
  readonly paymentFingerprintHash: string | null;
}
