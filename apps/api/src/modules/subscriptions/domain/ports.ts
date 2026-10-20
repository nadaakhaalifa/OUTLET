import type {
  CommerceBenefitKey,
  EntitlementGroup,
  JournalEntry,
  PlusPlan,
  PlusSubscription,
  SubscriptionState,
} from "./bridge";

export interface IdPort {
  uuidV7(): string;
}

export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) ----------------------

/** Users and age policy: `age_policy.plus_min_age` (ADR-0012) and the user's age in whole years. */
export interface AgePolicyPort {
  plusMinAge(): Promise<number>;
  /** null when no verified date of birth exists. Never returns the date of birth itself. */
  ageYears(userId: string): Promise<number | null>;
}

/** Users module: stable phone hash for the trial key. Never the phone number. */
export interface PersonKeyPort {
  phoneHash(userId: string): Promise<string | null>;
}

/** Payments module: resolves a PSP token the user owns to its card fingerprint. Card data never reaches Z-OUTLET. */
export interface CardVaultPort {
  describe(userId: string, tokenRef: string): Promise<{ readonly fingerprint: string } | null>;
}

export interface ChargeRequest {
  /** `sub:{id}:cycle:{n}:attempt:{k}` or the signup charge key. Same key, same result. */
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly pspTokenRef: string;
  readonly amountMinor: bigint;
  readonly currency: "EGP";
  readonly description: "plus";
}

export type ClientAction =
  | { readonly type: "redirect"; readonly url: string }
  | { readonly type: "sdk"; readonly token: string };

export type ChargeOutcome =
  | { readonly kind: "succeeded"; readonly provider: string; readonly pspRef: string }
  | { readonly kind: "failed"; readonly provider: string; readonly reason: string }
  | { readonly kind: "requires_action"; readonly provider: string; readonly pspRef: string; readonly action: ClientAction };

/** PSP tokenised recurring charge (kill switch per method, VR-04). Production adapter belongs to payments. */
export interface RecurringChargePort {
  charge(req: ChargeRequest): Promise<ChargeOutcome>;
}

/** Refund router (spec 15.6): original method only, never wallet unless the shopper chooses. */
export interface PlusRefundPort {
  refund(req: {
    readonly idempotencyKey: string;
    readonly userId: string;
    readonly invoiceId: string;
    readonly pspRef: string | null;
    readonly amountMinor: bigint;
  }): Promise<{ readonly kind: "initiated" } | { readonly kind: "failed"; readonly reason: string }>;
}

/** Ledger module. Posting is idempotent on `entry.idempotencyKey`. Entries must already balance. */
export interface LedgerPort {
  post(entry: JournalEntry): Promise<void>;
}

/** tax-eta module: ETA e-receipt for each Plus charge (B4). Idempotent on invoiceId. */
export interface TaxReceiptPort {
  queuePlusReceipt(input: {
    readonly invoiceId: string;
    readonly userId: string;
    readonly grossMinor: bigint;
    readonly vatMinor: bigint;
  }): Promise<void>;
}

export type MemberNoticeTemplate =
  | "plus_trial_reminder"
  | "plus_payment_failed"
  | "plus_expired"
  | "plus_price_change"
  | "family_member_joined"
  | "family_member_left"
  | "family_member_removed"
  | "family_plan_ending"
  | "family_plan_ended"
  | "student_status_expiring"
  | "student_price_ended";

/** Notifications module. Transactional messages (no marketing consent needed). */
export interface MemberNoticePort {
  send(input: {
    readonly userId: string;
    readonly template: MemberNoticeTemplate;
    readonly data: Readonly<Record<string, string | number>>;
  }): Promise<void>;
}

/** Feature flags (packages/feature-flags). Fail closed: false when unknown. */
export interface FeatureGatePort {
  enabled(key: string): Promise<boolean>;
}

/** Admin module dual approval for plan price changes (consume once). */
export interface PlanPriceApprovalPort {
  consume(input: {
    readonly approvalId: string;
    readonly planCode: string;
    readonly priceMinor: bigint;
    readonly actorId: string;
  }): Promise<boolean>;
}

/** HMAC of an identifier (trial keys are stored hashed). */
export interface KeyHasherPort {
  hash(value: string): string;
}

export const PLUS_FLAGS = {
  sales: "kill.plus.sales",
  /** Family plan sales, invites and seat changes (spec P3-03). Off by default. */
  family: "kill.plus.family",
  /** Student plan verification and sales (spec P3-03, VR-P3-09). Off by default. */
  student: "kill.plus.student",
  recurring: (method: string): string => `kill.plus.recurring.${method}`,
} as const;

export const PAYMENT_METHODS = ["card", "mobile_wallet", "apple_pay"] as const;
export type PlusPaymentMethod = (typeof PAYMENT_METHODS)[number];

// ---- events (outbox, same transaction as the state change) -----------------------------------

export type PlusEvent =
  | { readonly type: "plus.subscribed"; readonly subscriptionId: string; readonly userId: string; readonly planCode: string; readonly trial: boolean }
  | { readonly type: "plus.renewed"; readonly subscriptionId: string; readonly userId: string; readonly cycle: number; readonly invoiceId: string }
  | { readonly type: "plus.payment_failed"; readonly subscriptionId: string; readonly userId: string; readonly attempt: number }
  | { readonly type: "plus.expired"; readonly subscriptionId: string; readonly userId: string; readonly reason: "grace_elapsed" | "trial_unpaid" | "period_ended" | "refunded" }
  | { readonly type: "plus.paused"; readonly subscriptionId: string; readonly userId: string; readonly untilMs: number }
  | { readonly type: "plus.resumed"; readonly subscriptionId: string; readonly userId: string }
  | { readonly type: "plus.cancel_requested"; readonly subscriptionId: string; readonly userId: string; readonly effectiveAtMs: number }
  | { readonly type: "plus.reactivated"; readonly subscriptionId: string; readonly userId: string }
  | {
      readonly type: "plus.plan_switched";
      readonly subscriptionId: string;
      readonly userId: string;
      readonly from: string;
      readonly to: string;
      readonly immediate: boolean;
    }
  | { readonly type: "plus.refunded"; readonly subscriptionId: string; readonly userId: string; readonly invoiceId: string; readonly amountMinor: string }
  | { readonly type: "plus.plan_published"; readonly planId: string; readonly code: string; readonly version: number; readonly effectiveFromMs: number }
  | { readonly type: "plus.benefit_used"; readonly userId: string; readonly orderGroupId: string; readonly benefit: string }
  | { readonly type: "plus.benefit_reversed"; readonly userId: string; readonly orderGroupId: string }
  | { readonly type: "entitlement.granted"; readonly userId: string; readonly subscriptionId: string }
  | { readonly type: "entitlement.revoked"; readonly userId: string; readonly subscriptionId: string };

// ---- persistence -----------------------------------------------------------------------------

export type InvoiceKind = "first" | "renewal" | "dunning" | "upgrade";
export type InvoiceStatus = "PAID" | "FAILED" | "REFUNDED";

export interface InvoiceRecord {
  readonly id: string;
  readonly subscriptionId: string;
  readonly userId: string;
  readonly cycle: number;
  readonly attempt: number;
  readonly kind: InvoiceKind;
  readonly amountMinor: bigint;
  readonly vatMinor: bigint;
  readonly creditAppliedMinor: bigint;
  readonly netRecognitionMinor: bigint;
  readonly periodsTotal: number;
  readonly periodsRecognised: number;
  readonly periodStartMs: number;
  readonly status: InvoiceStatus;
  readonly provider: string | null;
  readonly pspRef: string | null;
  readonly issuedAtMs: number;
  readonly chargedAtMs: number | null;
  readonly refundedAtMs: number | null;
}

export interface EntitlementRow {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly group: EntitlementGroup;
  readonly key: string;
  readonly validFromMs: number;
  readonly validToMs: number;
}

export interface SavingsRow {
  readonly id: string;
  readonly userId: string;
  readonly orderGroupId: string;
  readonly benefit: CommerceBenefitKey | string;
  readonly amountSavedMinor: bigint;
  readonly createdAtMs: number;
  readonly reversedAtMs: number | null;
}

export type SignupStatus = "PENDING" | "COMPLETED" | "FAILED";

export interface SignupRecord {
  readonly id: string;
  readonly userId: string;
  readonly planId: string;
  readonly chargeKey: string;
  readonly tokenRef: string;
  readonly deviceId: string | null;
  readonly amountMinor: bigint;
  readonly status: SignupStatus;
  readonly pspRef: string | null;
  readonly clientAction: ClientAction | null;
  readonly subscriptionId: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/**
 * One atomic change. The store applies every part in a single transaction, writes the events to
 * the outbox in that same transaction, and applies nothing when it returns a non-"ok" result.
 */
export interface SubscriptionChange {
  readonly subscription?: { readonly value: PlusSubscription; readonly expectedVersion: number | null };
  readonly invoices?: readonly InvoiceRecord[];
  /** Replaces every entitlement row of the subscription (empty array revokes). */
  readonly entitlements?: { readonly subscriptionId: string; readonly rows: readonly EntitlementRow[] };
  readonly trialClaims?: { readonly keyHashes: readonly string[]; readonly subscriptionId: string; readonly atMs: number };
  readonly webhookEvent?: { readonly provider: string; readonly eventId: string };
  readonly signup?: SignupRecord;
  readonly events: readonly PlusEvent[];
}

export type CommitResult = "ok" | "conflict" | "trial_taken" | "duplicate_event" | "already_subscribed";

export interface MetricsCounts {
  readonly byStatus: Readonly<Record<SubscriptionState, number>>;
  /** Subscriptions created on or after `sinceMs`. */
  readonly createdSince: number;
  /** Subscriptions that existed before `sinceMs` and were live then. */
  readonly liveAtStart: number;
  /** Of those, how many are EXPIRED now with period end inside the window. */
  readonly endedSince: number;
}

export interface SubscriptionStore {
  listPlanVersions(code?: string): Promise<readonly PlusPlan[]>;
  getPlan(id: string): Promise<PlusPlan | null>;
  savePlan(plan: PlusPlan, events: readonly PlusEvent[]): Promise<"ok" | "exists">;

  getSubscription(id: string): Promise<PlusSubscription | null>;
  /** The non-EXPIRED subscription, or null. */
  getLiveByUser(userId: string): Promise<PlusSubscription | null>;
  /** Live one first, else the most recently created. */
  getLatestByUser(userId: string): Promise<PlusSubscription | null>;
  listDue(nowMs: number, limit: number): Promise<readonly PlusSubscription[]>;
  listLiveByPlanCode(code: string): Promise<readonly PlusSubscription[]>;
  /** Admin metrics: plain counts from stored rows. `sinceMs` opens the churn window. */
  metricsCounts(sinceMs: number): Promise<MetricsCounts>;

  claimedTrialKeys(keyHashes: readonly string[]): Promise<ReadonlySet<string>>;

  getInvoice(id: string): Promise<InvoiceRecord | null>;
  latestPaidInvoice(subscriptionId: string): Promise<InvoiceRecord | null>;
  listInvoices(subscriptionId: string): Promise<readonly InvoiceRecord[]>;
  listForRecognition(limit: number): Promise<readonly InvoiceRecord[]>;

  getSignup(id: string): Promise<SignupRecord | null>;
  getSignupByChargeKey(key: string): Promise<SignupRecord | null>;

  entitlementRows(userId: string): Promise<readonly EntitlementRow[]>;

  addSavings(row: SavingsRow, events: readonly PlusEvent[]): Promise<"added" | "exists">;
  /** Marks all non-reversed rows of the order group reversed. Returns how many changed. */
  reverseSavings(orderGroupId: string, atMs: number, events: (userId: string) => readonly PlusEvent[]): Promise<number>;
  benefitUsedSince(userId: string, sinceMs: number): Promise<boolean>;
  listSavings(userId: string, limit: number): Promise<readonly SavingsRow[]>;
  totalSavedMinor(userId: string): Promise<bigint>;

  commit(change: SubscriptionChange): Promise<CommitResult>;
}

export type { PlusPlan, PlusSubscription, SubscriptionState };

/** A verified, normalized PSP recurring event (the payments adapter maps provider payloads to this). */
export type RecurringWebhookEvent =
  | { readonly provider: string; readonly eventId: string; readonly kind: "signup.charge_succeeded"; readonly signupId: string; readonly pspRef: string }
  | { readonly provider: string; readonly eventId: string; readonly kind: "signup.charge_failed"; readonly signupId: string }
  | {
      readonly provider: string;
      readonly eventId: string;
      readonly kind: "renewal.charge_succeeded";
      readonly subscriptionId: string;
      readonly cycle: number;
      readonly pspRef: string;
    };


/** Verifies the PSP MAC, IP allow-list and timestamp (±5 min) of a recurring webhook. Payments owns the keys. */
export interface RecurringWebhookVerifierPort {
  verify(input: {
    readonly provider: string;
    readonly rawBody: Uint8Array;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly ip: string | undefined;
  }): Promise<{ readonly kind: "ok"; readonly event: RecurringWebhookEvent } | { readonly kind: "rejected" }>;
}
