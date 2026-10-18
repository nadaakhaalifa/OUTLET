import type {
  AttemptState,
  AutoBuyMode,
  BudgetDecision,
  MandateLocale,
  MandateStatus,
  RiskDecision,
  TokenState,
} from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

// ---- ports owned by other modules (fakes live in adapters/in-memory.ts) -------------------------

/** `kill.price_drop_auto_buy` and `kill.auto_buy.charge`. Both default false; fail closed. */
export interface AutoBuyFlagsPort {
  /** Rules may be created and the evaluator may notify (mode A). */
  rulesEnabled(): Promise<boolean>;
  /** The unattended merchant-initiated charge may run (mode B). Needs VR-P3-01 and VR-P3-02. */
  chargeEnabled(): Promise<boolean>;
}

/** Subscriptions: Plus entitlement `auto_buy` is active, and the age policy for Plus is met. */
export interface MemberEligibilityPort {
  eligibility(userId: string): Promise<{ readonly plusActive: boolean; readonly ageOk: boolean }>;
}

export interface SkuQuote {
  readonly listed: boolean;
  /** Live price in piastres, read from the primary (never a cached search document). */
  readonly price: bigint;
  /** Verified per the Price Integrity Engine (spec 9). */
  readonly priceVerified: boolean;
  /** Price-integrity anomaly flag (seller error, ping-pong, spike). */
  readonly priceAnomaly: boolean;
  readonly sizeKnown: boolean;
  readonly sizeInStock: boolean;
  /** Drop SKUs are excluded from auto-buy (spec Reservation rule). */
  readonly dropSku: boolean;
  readonly itemLabelAr: string;
  readonly itemLabelEn: string;
}

export interface CatalogQuotePort {
  /** null when the SKU does not exist. */
  quote(skuId: string, sizeLabel: string): Promise<SkuQuote | null>;
}

export interface DeliverabilityPort {
  /** Default address of the shopper is covered by the courier coverage table for this SKU. */
  deliverable(userId: string, skuId: string): Promise<boolean>;
}

/** Fraud and risk (spec 20.7): decisions, never scores. */
export interface RiskPort {
  decide(input: { readonly userId: string; readonly stage: "create" | "charge"; readonly skuId: string; readonly amount: bigint }): Promise<RiskDecision>;
}

/** Budget suite: hard cap and soft cap at charge time. Never exposes the budget itself. */
export interface BudgetGatePort {
  evaluate(userId: string, amount: bigint): Promise<BudgetDecision>;
}

/** PSP vault: is this reference a live, owned CARD token (never BNPL, COD or store credit). */
export interface CardVaultPort {
  inspect(userId: string, tokenRef: string): Promise<TokenState>;
}

/** Inventory: the row-per-unit hold (spec 20.2). `holdKey` is the attempt id; release is idempotent. */
export interface InventoryHoldPort {
  reserve(input: { readonly holdKey: string; readonly skuId: string; readonly sizeLabel: string; readonly ttlMs: number }): Promise<"held" | "unavailable">;
  release(holdKey: string): Promise<void>;
}

export interface MitRequest {
  /** `auto_buy:{mandate}:{price_event}`. The same key must never create a second order. */
  readonly idempotencyKey: string;
  readonly userId: string;
  readonly skuId: string;
  readonly sizeLabel: string;
  readonly amount: bigint;
  readonly tokenRef: string;
  readonly holdKey: string;
}

export type MitResult =
  | { readonly kind: "placed"; readonly orderGroupId: string }
  | { readonly kind: "declined"; readonly code: string }
  | { readonly kind: "sca_required" }
  /** No answer within the PSP timeout and retries. NOT a failure: reconciled by idempotency key. */
  | { readonly kind: "pending" };

/**
 * Runs the NORMAL checkout saga with a merchant-initiated payment (ADR-0036: no parallel money
 * path; ledger-first posting happens inside the saga). Production binds an Unconfigured adapter.
 */
export interface MitCheckoutPort {
  placeOrder(req: MitRequest): Promise<MitResult>;
  /**
   * Tri-state-plus lookup by idempotency key. Fail closed: only `failed` (the saga reached a terminal
   * failure: declined, voided, refunded) proves nothing was or will be charged. `pending` means the
   * saga is still running (a late success is possible). `not_found` is NOT proof of no charge (replica
   * lag, a call that reached the PSP but never recorded); the sweep escalates it to manual review.
   */
  lookup(idempotencyKey: string): Promise<MitLookup>;
}

export type MitLookup =
  | { readonly kind: "placed"; readonly orderGroupId: string }
  | { readonly kind: "failed" }
  | { readonly kind: "pending" }
  | { readonly kind: "not_found" };

export type NoticeKind = "target_reached" | "pre_charge" | "charged" | "not_charged" | "sca_required";

export interface Notice {
  readonly userId: string;
  readonly kind: NoticeKind;
  readonly attemptId: string;
  readonly mandateId: string;
  /** Only for `pre_charge`: when the window closes. */
  readonly cancelDeadlineMs: number | null;
}

/** Notifications module. Push carries no PII and no amounts. "accepted" means durably enqueued. */
export interface NoticePort {
  send(notice: Notice): Promise<"accepted" | "failed">;
}

// ---- repository --------------------------------------------------------------------------------

export interface MandateRecord {
  readonly id: string;
  readonly userId: string;
  readonly skuId: string;
  readonly sizeLabel: string;
  readonly targetPrice: bigint;
  readonly maxPrice: bigint;
  readonly mode: AutoBuyMode;
  /** Reference into the PSP vault. Never a PAN, never returned by any API. */
  readonly pspTokenRef: string | null;
  readonly status: MandateStatus;
  readonly closedReason: string | null;
  readonly expiresAtMs: number;
  readonly mandateVersion: number;
  readonly mandateLocale: MandateLocale;
  readonly termsSha256: string;
  readonly acceptedAtMs: number;
  readonly acceptedDeviceId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AttemptRecord {
  readonly id: string;
  readonly mandateId: string;
  readonly userId: string;
  readonly priceEventId: string;
  readonly mode: AutoBuyMode;
  readonly state: AttemptState;
  readonly triggerPrice: bigint;
  readonly chargePrice: bigint | null;
  readonly noticeSentAtMs: number | null;
  readonly cancelDeadlineMs: number | null;
  readonly chargeStartedAtMs: number | null;
  readonly reservationRef: string | null;
  readonly orderGroupId: string | null;
  readonly failureReason: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface MandateTextRecord {
  readonly version: number;
  readonly locale: MandateLocale;
  readonly body: string;
  readonly bodySha256: string;
}

/** Outbox events (same transaction as the state change). Ids and enums only: no amounts. */
export type AutoBuyDomainEvent =
  | { readonly type: "auto_buy.armed"; readonly userId: string; readonly mandateId: string; readonly mode: AutoBuyMode }
  | { readonly type: "auto_buy.notified"; readonly userId: string; readonly mandateId: string; readonly attemptId: string; readonly mode: AutoBuyMode; readonly cancelDeadlineMs: number | null }
  | { readonly type: "auto_buy.cancelled"; readonly userId: string; readonly mandateId: string; readonly attemptId: string | null; readonly by: "user" | "system" }
  | { readonly type: "auto_buy.charged"; readonly userId: string; readonly mandateId: string; readonly attemptId: string; readonly orderGroupId: string }
  | { readonly type: "auto_buy.failed"; readonly userId: string; readonly mandateId: string; readonly attemptId: string; readonly reason: string }
  /** The PSP outcome could not be established; parked for a human. Not a failure notice to the shopper. */
  | { readonly type: "auto_buy.manual_review"; readonly userId: string; readonly mandateId: string; readonly attemptId: string; readonly reason: string }
  /** An operator closed a MANUAL_REVIEW attempt on PSP evidence. Ids and enums only (the note never leaves the audit log). */
  | {
      readonly type: "auto_buy.manual_review_resolved";
      readonly userId: string;
      readonly mandateId: string;
      readonly attemptId: string;
      readonly resolution: "purchased" | "not_charged";
      readonly resolverId: string;
    };

/** Everything a use case may do inside one transaction. Mutating getters take a row lock. */
export interface AutoBuyTx {
  getText(version: number, locale: MandateLocale): Promise<MandateTextRecord | null>;
  putText(record: MandateTextRecord): Promise<void>;
  /** Per-user transaction-scoped advisory lock: serialises the active-rule cap check (B-7). */
  lockUser(userId: string): Promise<void>;
  countArmed(userId: string): Promise<number>;
  insertMandate(record: MandateRecord): Promise<"inserted" | "duplicate_active">;
  /** Row lock. Any owner: callers that act for a shopper must use `getOwnedMandate`. */
  getMandateForUpdate(id: string): Promise<MandateRecord | null>;
  getOwnedMandateForUpdate(userId: string, id: string): Promise<MandateRecord | null>;
  closeMandate(id: string, status: Exclude<MandateStatus, "ARMED">, reason: string, atMs: number): Promise<void>;
  /** Creation time of the latest attempt that reached NOTIFIED (a skipped attempt starts no cooldown, B-6). */
  lastAttemptAt(mandateId: string): Promise<number | null>;
  insertAttempt(record: AttemptRecord): Promise<"inserted" | "exists">;
  getAttemptForUpdate(id: string): Promise<AttemptRecord | null>;
  getOwnedAttemptForUpdate(userId: string, id: string): Promise<AttemptRecord | null>;
  updateAttempt(record: AttemptRecord): Promise<void>;
  openAttemptsOfMandate(mandateId: string): Promise<readonly AttemptRecord[]>;
  emit(events: readonly AutoBuyDomainEvent[]): Promise<void>;
}

export interface MandateWithLatest {
  readonly mandate: MandateRecord;
  readonly latest: AttemptRecord | null;
}

export interface AutoBuyStore {
  /** One transaction under the system role. Row locks come from the `ForUpdate` getters. */
  run<T>(fn: (tx: AutoBuyTx) => Promise<T>): Promise<T>;
  /** Owner's rules, newest first, each with its latest attempt. */
  listForUser(userId: string, limit: number): Promise<readonly MandateWithLatest[]>;
  /** Armed rules for a SKU whose target is at or above `price` (so the price has reached it). */
  armedForSku(skuId: string, price: bigint, limit: number): Promise<readonly MandateRecord[]>;
  armedForUser(userId: string, tokenRef: string | null): Promise<readonly MandateRecord[]>;
  /** Unattended attempts in NOTIFIED whose window closed at or before `nowMs`, oldest deadline first. */
  dueAttempts(nowMs: number, limit: number): Promise<readonly AttemptRecord[]>;
  /** Unattended NOTIFIED notices whose cancel deadline is at or before `beforeMs` (stale), to be retired. */
  staleNotices(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]>;
  /** TRIGGERED attempts created at or before `beforeMs` (a crashed evaluation). */
  stuckTriggered(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]>;
  /** CHARGING attempts started at or before `beforeMs` with no outcome. */
  unresolvedCharges(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]>;
  /** MANUAL_REVIEW attempts, oldest first: re-looked-up every sweep so a late success is recorded (never charged twice). */
  manualReview(limit: number): Promise<readonly AttemptRecord[]>;
  /** REQUIRES_USER_ACTION attempts last touched at or before `beforeMs`. */
  abandonedSca(beforeMs: number, limit: number): Promise<readonly AttemptRecord[]>;
  /** ARMED rules whose expiry is at or before `nowMs`. */
  expiredMandates(nowMs: number, limit: number): Promise<readonly MandateRecord[]>;
  /** Armed rules of this user on this SKU (checkout closes them when the shopper buys it). */
  armedForUserSku(userId: string, skuId: string): Promise<readonly MandateRecord[]>;
}

/**
 * Append-only audit of operator actions (hash-chained admin audit log). A failure must fail the action:
 * the controller appends BEFORE it acts. `diff` carries ids, enums and digests only.
 */
export interface OpsAuditPort {
  append(entry: {
    readonly action: string;
    readonly actorId: string | null;
    readonly targetType: string | null;
    readonly targetId: string | null;
    readonly reasonCode: string | null;
    readonly diff: Readonly<Record<string, string | number | boolean | null>>;
    readonly requestId: string | null;
    readonly atMs: number;
  }): Promise<void>;
}
