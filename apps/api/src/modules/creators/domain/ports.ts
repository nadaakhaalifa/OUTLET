import type {
  ApprovalRecord,
  ClickFact,
  CommissionState,
  CreatorFraudReason,
  CreatorKycState,
  CreatorStatus,
  EntryMeta,
  JournalEntry,
  LinkTargetType,
  PartyIdentifiers,
  PayoutPref,
  PayoutState,
  RefundPlan,
  UaClass,
} from "./bridge";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}
export interface TokenEntropy {
  randomBytes(length: number): Uint8Array;
}

// ---- records -------------------------------------------------------------------------------------

export interface CreatorAccount {
  readonly id: string;
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly status: CreatorStatus;
  readonly kycState: CreatorKycState;
  readonly termsVersion: number;
  readonly termsAcceptedAtMs: number;
  readonly payoutPref: PayoutPref;
  readonly statusReason: string | null;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
}

/** Sealed (envelope-encrypted) KYC. The store never sees plaintext; the module never returns it. */
export interface SealedKyc {
  readonly keyId: string;
  readonly legalNameEnc: Uint8Array;
  readonly nationalIdEnc: Uint8Array;
  /** HMAC blind index: one identity document backs one creator. */
  readonly nationalIdHash: Uint8Array;
  readonly payoutIbanEnc: Uint8Array | null;
  readonly payoutNameEnc: Uint8Array | null;
  /** VERIFY BEFORE LAUNCH (VR-P3-03): shape pending Tax counsel. */
  readonly taxIdEnc: Uint8Array | null;
  readonly taxFormEnc: Uint8Array | null;
}

export interface AffiliateLink {
  readonly id: string;
  readonly creatorId: string;
  readonly targetType: LinkTargetType;
  readonly targetId: string;
  readonly slug: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly createdAtMs: number;
}

export type LookStatus = "DRAFT" | "PUBLISHED" | "TAKEN_DOWN" | "ARCHIVED";
export interface CreatorLook {
  readonly id: string;
  readonly creatorId: string;
  readonly title: string;
  readonly status: LookStatus;
  readonly takedownReason: string | null;
  readonly productIds: readonly string[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Why an attribution earns nothing. `referral_stacking`: the order already carries a referral reward (A-4). */
export type AttributionVoidReason = CreatorFraudReason | "creator_ineligible" | "referral_stacking";

export interface Attribution {
  readonly orderGroupId: string;
  readonly creatorId: string;
  readonly linkId: string;
  readonly clickId: string;
  readonly clickAtMs: number;
  readonly buyerUserId: string;
  /** Rates frozen at attribution time. */
  readonly rateSnapshot: { readonly defaultBps: number; readonly categoryBps: Readonly<Record<string, number>> };
  readonly windowEndMs: number;
  /**
   * HELD (A-3): the fraud gate could not run (creator identity profile unavailable). Never accrues,
   * is re-evaluated by AttributeOrder on the next call, and is surfaced to review.
   */
  readonly status: "ACTIVE" | "VOIDED" | "HELD";
  readonly voidReason: AttributionVoidReason | null;
  readonly holdReason?: "identity_unavailable" | null;
  readonly createdAtMs: number;
}

export interface Commission {
  readonly id: string;
  readonly creatorId: string;
  readonly orderGroupId: string;
  readonly orderLineId: string;
  readonly base: bigint;
  readonly rateBps: bigint;
  /** Accrual target in piastres (what this line earns before clawbacks). */
  readonly amount: bigint;
  readonly clawedBack: bigint;
  readonly refundedBase: bigint;
  readonly state: CommissionState;
  readonly holdReason: "monthly_cap" | "creator_not_active" | null;
  readonly voidReason: string | null;
  readonly monthKey: string;
  readonly closedAtMs: number;
  readonly accruedAtMs: number | null;
  readonly payoutId: string | null;
}

export interface CreatorPayout {
  readonly id: string;
  readonly creatorId: string;
  readonly amount: bigint;
  readonly state: PayoutState;
  readonly holdReason: string | null;
  readonly attempt: number;
  readonly providerRef: string | null;
  readonly failureReason: string | null;
  readonly createdBy: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

// ---- events (outbox) -----------------------------------------------------------------------------

export type CreatorEvent =
  | { readonly type: "creator.applied"; readonly creatorId: string }
  | { readonly type: "creator.approved"; readonly creatorId: string }
  | { readonly type: "creator.rejected"; readonly creatorId: string; readonly reason: string }
  | { readonly type: "creator.suspended"; readonly creatorId: string; readonly reason: string }
  | { readonly type: "affiliate.link_created"; readonly creatorId: string; readonly linkId: string }
  | { readonly type: "affiliate.click_recorded"; readonly creatorId: string; readonly linkId: string; readonly counted: boolean }
  /** Aggregated: at most one per creator per minute, so click flooding cannot grow the outbox. */
  | { readonly type: "affiliate.clicks_active"; readonly creatorId: string; readonly minuteMs: number }
  | { readonly type: "creator.attribution_held"; readonly creatorId: string; readonly orderGroupId: string; readonly reason: string }
  | { readonly type: "creator.commission_over_cap"; readonly creatorId: string; readonly commissionId: string; readonly amount: bigint }
  | { readonly type: "creator.order_attributed"; readonly creatorId: string; readonly orderGroupId: string }
  /** Silent: never shown to the creator. Feeds the fraud review queue. */
  | { readonly type: "creator.attribution_voided"; readonly creatorId: string; readonly orderGroupId: string; readonly reason: string }
  | { readonly type: "commission.accrued"; readonly creatorId: string; readonly commissionId: string; readonly amount: bigint }
  | { readonly type: "commission.held"; readonly creatorId: string; readonly commissionId: string; readonly reason: string }
  | { readonly type: "commission.clawed_back"; readonly creatorId: string; readonly commissionId: string; readonly amount: bigint }
  | { readonly type: "creator.balance_negative"; readonly creatorId: string; readonly owes: bigint }
  | { readonly type: "creator_payout.requested"; readonly creatorId: string; readonly payoutId: string; readonly amount: bigint }
  | { readonly type: "creator_payout.settled"; readonly creatorId: string; readonly payoutId: string; readonly amount: bigint }
  | { readonly type: "creator_payout.failed"; readonly creatorId: string; readonly payoutId: string; readonly reason: string };

// ---- store -----------------------------------------------------------------------------------------

export type CreateAccountResult = { readonly kind: "created" } | { readonly kind: "exists" } | { readonly kind: "handle_taken" } | { readonly kind: "identity_in_use" };

export type LinkInsert =
  | { readonly kind: "created"; readonly link: AffiliateLink }
  | { readonly kind: "exists"; readonly link: AffiliateLink }
  | { readonly kind: "slug_taken" };

export interface NewCommission {
  readonly id: string;
  readonly creatorId: string;
  readonly orderGroupId: string;
  readonly orderLineId: string;
  readonly base: bigint;
  readonly rateBps: bigint;
  readonly amount: bigint;
  readonly refundedBase: bigint;
  readonly monthKey: string;
  readonly closedAtMs: number;
  /** Creator is not ACTIVE right now: hold instead of accrue. */
  readonly creatorActive: boolean;
  readonly monthlyCap: bigint;
}

/** A ledger entry the module owes. Posted idempotently under creator_commission:{commissionId}:{seq}. */
export interface PostingIntent {
  readonly commissionId: string;
  readonly seq: number;
  readonly kind: "accrual" | "clawback";
  readonly amount: bigint;
  readonly creatorUserId: string;
  readonly orderGroupId: string;
}

export type ClaimResult =
  | { readonly kind: "duplicate" }
  /** The attribution was voided (or held) before this claim ran: nothing accrues (A-3 race guard). */
  | { readonly kind: "attribution_inactive" }
  | { readonly kind: "exists"; readonly commission: Commission }
  | { readonly kind: "claimed"; readonly commission: Commission };

export type RefundClaim =
  | { readonly kind: "duplicate" }
  | { readonly kind: "no_commission" }
  | { readonly kind: "applied"; readonly commission: Commission; readonly plan: RefundPlan };

export interface CreatorStore {
  // accounts
  getByUser(userId: string): Promise<CreatorAccount | null>;
  getById(id: string): Promise<CreatorAccount | null>;
  getByHandle(handle: string): Promise<CreatorAccount | null>;
  listByStatus(status: CreatorStatus, limit: number): Promise<readonly CreatorAccount[]>;
  createAccount(account: CreatorAccount, kyc: SealedKyc, events: readonly CreatorEvent[]): Promise<CreateAccountResult>;
  decide(input: {
    readonly creatorId: string;
    readonly status: CreatorStatus;
    readonly kycState: CreatorKycState;
    readonly reason: string | null;
    readonly reviewerId: string;
    readonly nowMs: number;
    readonly events: readonly CreatorEvent[];
  }): Promise<CreatorAccount | null>;
  setPayoutPref(creatorId: string, pref: PayoutPref, nowMs: number): Promise<boolean>;
  // links
  insertLink(link: AffiliateLink, events: readonly CreatorEvent[]): Promise<LinkInsert>;
  listLinks(creatorId: string): Promise<readonly AffiliateLink[]>;
  getLink(id: string): Promise<AffiliateLink | null>;
  findLinkBySlug(slug: string): Promise<AffiliateLink | null>;
  disableLink(creatorId: string, linkId: string, nowMs: number): Promise<boolean>;
  disableLinksOf(creatorId: string, nowMs: number): Promise<number>;
  // looks
  insertLook(look: CreatorLook): Promise<void>;
  listLooks(creatorId: string): Promise<readonly CreatorLook[]>;
  getLook(id: string): Promise<CreatorLook | null>;
  updateLook(look: CreatorLook): Promise<void>;
  // clicks
  countedClicksSince(creatorId: string, ipHash: string, sinceMs: number): Promise<number>;
  /**
   * Ingest guard counters in one round trip: counted clicks of this hour keyed on the identifiers
   * actually used (ip hash per creator, device hash, link), whether this device already clicked this
   * link inside the dedupe window, and whether the creator already has a click in this minute.
   */
  clickCountsSince(input: {
    readonly creatorId: string;
    readonly linkId: string;
    readonly ipHash: string;
    readonly deviceHash: string;
    readonly hourSinceMs: number;
    readonly dedupeSinceMs: number;
    readonly minuteSinceMs: number;
  }): Promise<{ readonly ip: number; readonly device: number; readonly link: number; readonly duplicate: boolean; readonly creatorThisMinute: number }>;
  /**
   * Partition maintenance and retention for affiliate_clicks: creates monthly partitions up to
   * `monthsAhead`, drops partitions entirely older than `retainMonths` and deletes the remaining
   * rows older than the cutoff. Idempotent.
   */
  maintainClickPartitions(input: { readonly nowMs: number; readonly monthsAhead: number; readonly retainMonths: number }): Promise<{ readonly created: number; readonly dropped: number; readonly deletedRows: number }>;
  insertClick(click: ClickFact & { readonly ipHash: string }, events: readonly CreatorEvent[]): Promise<void>;
  clicksForDevices(deviceHashes: readonly string[], sinceMs: number, untilMs: number): Promise<readonly ClickFact[]>;
  clickStats(creatorId: string, sinceMs: number): Promise<{ readonly total: number; readonly counted: number }>;
  // attribution
  getAttribution(orderGroupId: string): Promise<Attribution | null>;
  insertAttribution(a: Attribution, events: readonly CreatorEvent[]): Promise<"inserted" | "exists">;
  /** Status flip only, NO clawback. Application code must use voidOrderGroup (VoidAttribution use case). */
  voidAttribution(orderGroupId: string, reason: AttributionVoidReason, events: readonly CreatorEvent[]): Promise<void>;
  attributedBuyers(creatorId: string, limit: number): Promise<readonly string[]>;
  /** HELD to ACTIVE or VOIDED once the fraud gate could run. False when it is no longer HELD. */
  resolveHeldAttribution(a: Attribution, events: readonly CreatorEvent[]): Promise<boolean>;
  /**
   * Void an ACTIVE or HELD attribution and, in the SAME transaction, plan the full clawback of every
   * commission of the order group (planVoid): held ones are voided, accrued and paid ones get a
   * clawback posting intent. Returns the touched commission ids so the caller can post them.
   */
  voidOrderGroup(input: {
    readonly orderGroupId: string;
    readonly reason: AttributionVoidReason;
    readonly events: readonly CreatorEvent[];
  }): Promise<{ readonly kind: "not_found" | "already_voided" } | { readonly kind: "voided"; readonly commissionIds: readonly string[]; readonly clawedBack: bigint }>;
  // commissions
  /**
   * Inbox + insert (unique per line and creator) + atomic monthly-cap check + posting intent in ONE
   * transaction. The store appends commission.accrued or commission.held itself.
   */
  claimAccrual(input: { readonly consumer: string; readonly messageId: string; readonly commission: NewCommission }): Promise<ClaimResult>;
  /**
   * Inbox + planRefund + state change + posting intent in ONE transaction. The store appends
   * commission.clawed_back itself; `refundedGross` is cumulative for the line, `lineGross` its value.
   */
  claimRefund(input: { readonly consumer: string; readonly messageId: string; readonly orderLineId: string; readonly lineGross: bigint; readonly refundedGross: bigint }): Promise<RefundClaim>;
  /** Standalone outbox append for events that have no state change of their own. */
  emit(events: readonly CreatorEvent[]): Promise<void>;
  recordInbox(consumer: string, messageId: string): Promise<"recorded" | "duplicate">;
  /** Unposted intents of one commission, in seq order. */
  intentsFor(commissionId: string): Promise<readonly PostingIntent[]>;
  listUnpostedIntents(limit: number): Promise<readonly PostingIntent[]>;
  /** True only for the call that moved the intent from unposted to posted (once-per-transition side effects key off it). */
  markPosted(commissionId: string, seq: number, nowMs: number): Promise<boolean>;
  listHeld(limit: number): Promise<readonly Commission[]>;
  /**
   * Release a held commission: ACCRUING to ACCRUED, bumping the monthly counter with the SAME
   * conditional upsert the accrual path uses (A-5). Null when it is no longer held or has no room.
   */
  releaseHeld(commissionId: string, monthKey: string, monthlyCap: bigint): Promise<Commission | null>;
  getCommission(id: string): Promise<Commission | null>;
  listCommissions(creatorId: string, limit: number, beforeMs: number | null): Promise<readonly Commission[]>;
  monthAccrued(creatorId: string, monthKey: string): Promise<bigint>;
  commissionTotals(creatorId: string): Promise<{
    readonly pending: bigint;
    readonly accrued: bigint;
    readonly clawedBack: bigint;
    readonly paid: bigint;
    readonly held: bigint;
  }>;
  // terms (A-7)
  /** Insert-or-verify the exact accepted text. "mismatch" means the stored text differs: never overwritten. */
  ensureTerms(version: number, texts: readonly TermsText[]): Promise<"ok" | "mismatch">;
  // payouts
  reservableTotal(creatorId: string): Promise<bigint>;
  createPayout(input: { readonly payout: CreatorPayout; readonly events: readonly CreatorEvent[] }): Promise<"created" | "open_exists">;
  getPayout(id: string): Promise<CreatorPayout | null>;
  listPayouts(filter: { readonly creatorId?: string; readonly state?: PayoutState; readonly limit: number }): Promise<readonly CreatorPayout[]>;
  /** Compare-and-set on the state. Returns null when the payout is no longer in `from`. */
  transitionPayout(input: {
    readonly id: string;
    readonly from: PayoutState;
    readonly to: PayoutState;
    readonly holdReason?: string | null;
    readonly attempt?: number;
    readonly providerRef?: string | null;
    readonly failureReason?: string | null;
    readonly nowMs: number;
    /** SETTLED marks reserved commissions PAID; CANCELLED releases them. */
    readonly events: readonly CreatorEvent[];
  }): Promise<CreatorPayout | null>;
}

// ---- collaborators -------------------------------------------------------------------------------

export interface TermsText {
  readonly locale: "ar" | "en";
  readonly body: string;
  /** SHA-256 hex of body. */
  readonly sha256: string;
}

export interface CreatorProfileView extends PartyIdentifiers {
  /**
   * Start of the buyer's most recent first-party (authenticated app) session, or null. Feeds the
   * click protection window (A-1). `deviceHashes` MUST be produced with `clickDeviceHash(salt, id)`
   * from the registered device ids so they match stored click hashes.
   */
  readonly sessionStartedAtMs?: number | null;
  readonly ageYears: number | null;
  readonly active: boolean;
  /** Stores the user is staff of (seller conflict rule). */
  readonly sellerStoreIds: readonly string[];
}

/**
 * Referral side of the one-reward-per-order rule (A-4). Owner default: when a referral reward or
 * referee discount applies to the order, the creator commission is voided silently. The referrals
 * module is untouched; this port is the only coupling.
 */
export interface CreatorReferralPort {
  rewardAppliesTo(input: { readonly orderGroupId: string; readonly buyerUserId: string }): Promise<boolean>;
}

export interface CreatorIdentityPort {
  profile(userId: string): Promise<CreatorProfileView | null>;
}

export interface LinkTargetView {
  readonly exists: boolean;
  readonly storeId: string | null;
}
export interface CreatorCatalogPort {
  resolveTarget(type: LinkTargetType, id: string): Promise<LinkTargetView>;
  /** Product ids that exist and are sellable now. Used to validate a look. */
  existingProducts(ids: readonly string[]): Promise<ReadonlySet<string>>;
}

/** Ledger gateway. Idempotent on the entry's idempotency key. */
export interface CreatorLedgerPort {
  post(entry: JournalEntry): Promise<{ readonly kind: "posted" | "replayed" }>;
  /** Natural (credit-normal) balance of creator_payable:{userId}; negative means the creator owes us. */
  payableBalance(creatorUserId: string): Promise<bigint>;
  /** True when an entry with this idempotency key exists (payout orphan recovery, A-2). */
  hasEntry(idempotencyKey: string): Promise<boolean>;
}

export interface CreatorFlagsPort {
  /** `kill.creator_program`. */
  programEnabled(): Promise<boolean> | boolean;
  /** `kill.creator_payouts`. */
  payoutsEnabled(): Promise<boolean> | boolean;
}

export interface CreatorKycVaultPort {
  seal(input: {
    readonly legalName: string;
    readonly nationalId: string;
    readonly payoutIban: string | null;
    readonly payoutName: string | null;
    readonly taxId: string | null;
    readonly taxForm: string | null;
  }): Promise<SealedKyc>;
  /** The payout account holder name matches the legal name (decrypted inside the vault). Fails closed. */
  payoutIdentityMatched(creatorId: string): Promise<boolean>;
}

export interface CreatorApprovalsPort {
  forPayout(payoutId: string): Promise<readonly ApprovalRecord[]>;
}

export type ProviderOutcome =
  | { readonly kind: "accepted"; readonly providerRef: string }
  | { readonly kind: "settled"; readonly providerRef: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "unavailable" };

/** Bank or PSP rail for creators. Default: Unconfigured (ADR-0037, VR-P3-03). */
export interface CreatorPayoutProviderPort {
  readonly configured: boolean;
  send(input: {
    readonly idempotencyKey: string;
    readonly amount: bigint;
    readonly creatorId: string;
    readonly reference: string;
  }): Promise<ProviderOutcome>;
}

export interface TermsPort {
  /** Current terms version, null when none is published (applications are refused). */
  currentVersion(): Promise<number | null>;
  /** The exact published text of a version, so the accepted text is stored (A-7). Optional: absent means unverifiable. */
  texts?(version: number): Promise<readonly TermsText[]>;
}

export type { EntryMeta, ApprovalRecord, PartyIdentifiers, UaClass, CommissionState };
export type { CreatorFraudReason, LinkTargetType };
