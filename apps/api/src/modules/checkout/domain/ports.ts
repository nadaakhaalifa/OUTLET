import type {
  CheckoutLine,
  CheckoutMethod,
  CheckoutQuote,
  JournalEntry,
  Money,
  SagaFacts,
  StoreTermsForCheckout,
  SubBalanceSpend,
  SubBalanceState,
  promotions,
} from "./bridge";

export type { CheckoutMethod };

export interface LocalizedText {
  readonly ar: string;
  readonly en?: string;
}

// --------------------------------------------------------------------------- upstream read ports

export interface BagLine extends CheckoutLine {
  readonly available: boolean;
  readonly title: LocalizedText;
  readonly sizeLabel?: string;
  /** Tax category code for the tax engine. */
  readonly taxCategoryCode: string;
}

export interface BagStoreTerms extends StoreTermsForCheckout {
  readonly open: boolean;
  readonly commissionBps: number;
}

export interface BagSnapshot {
  readonly lines: readonly BagLine[];
  readonly stores: ReadonlyMap<string, BagStoreTerms>;
  readonly plusMember: boolean;
}

/** Server-side bag, already priced from the catalog (cart module). */
export interface CartPort {
  snapshot(userId: string): Promise<BagSnapshot>;
  /** Removes purchased lines after placement. Best effort and idempotent. */
  removePurchased(userId: string, lineIds: readonly string[]): Promise<void>;
}

export interface PromotionsPort {
  evaluate(input: {
    readonly userId: string;
    readonly lines: readonly promotions.EvalLine[];
    readonly shippingFees: readonly promotions.ShippingFee[];
    readonly codes: readonly string[];
    readonly paymentMethod: promotions.PaymentMethod | null;
    readonly isPlus: boolean;
    readonly atMs: number;
  }): Promise<promotions.EvaluationResult>;
}

export interface TaxQuote {
  readonly lines: readonly { readonly id: string; readonly vat: Money }[];
  readonly vatBps: bigint;
}

export interface TaxPort {
  quote(input: {
    readonly lines: readonly { readonly id: string; readonly unitGross: Money; readonly qty: number; readonly categoryCode: string }[];
    readonly orderDiscount: Money;
  }): Promise<TaxQuote>;
}

export type RiskDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "require_confirmation" }
  | { readonly kind: "require_prepayment" }
  | { readonly kind: "prepaid_only" }
  | { readonly kind: "limit_value"; readonly maxAmount: Money }
  | { readonly kind: "block" };

export interface RiskPort {
  /** COD risk decision (spec 20.7). Called for every quote that lists COD and at commit. */
  assessCod(input: {
    readonly userId: string;
    readonly deviceId: string | null;
    readonly total: Money;
    readonly addressId: string | null;
  }): Promise<RiskDecision>;
}

export type AgeGate = { readonly allowed: true } | { readonly allowed: false; readonly minAge: number; readonly provider?: string };

export interface AgePolicyPort {
  /** Capability gate for the method (BNPL follows the provider's rule, spec B6). */
  checkMethod(userId: string, method: CheckoutMethod): Promise<AgeGate>;
}

export interface KillSwitchPort {
  /** Payment methods switched off right now (spec A2.12). */
  disabledMethods(): Promise<ReadonlySet<CheckoutMethod>>;
}

export interface DeliveryContact {
  readonly firstName: string | null;
  readonly phoneRelay: string | null;
  readonly governorateCode: string;
}

export type AddressResolution =
  | { readonly kind: "ok"; readonly contact: DeliveryContact }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_covered" };

export interface AddressPort {
  resolve(userId: string, addressId: string): Promise<AddressResolution>;
}

export interface AppAttestPort {
  verify(input: { readonly userId: string; readonly deviceId: string | null; readonly assertion: string | null }): Promise<boolean>;
}

// --------------------------------------------------------------------------- saga effect ports

export type ReserveResult =
  | { readonly kind: "reserved"; readonly reservationId: string; readonly expiresAtMs: number }
  | { readonly kind: "insufficient"; readonly shortfalls: readonly { readonly skuId: string; readonly requested: number; readonly available: number }[] }
  | { readonly kind: "rejected"; readonly code: string };

export type ClaimResult =
  | { readonly kind: "claimed" | "claimed_late" | "already_claimed" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "not_found" };

/** Inventory effects. All idempotent per order group. */
export interface InventoryPort {
  reserve(input: {
    readonly orderGroupId: string;
    readonly userId: string;
    readonly method: CheckoutMethod;
    readonly lines: readonly { readonly skuId: string; readonly qty: number }[];
  }): Promise<ReserveResult>;
  claim(orderGroupId: string): Promise<ClaimResult>;
  /** Releases an ACTIVE reservation; a claimed one is returned to stock where the store supports it. */
  release(orderGroupId: string, reason: "payment_failed" | "cancelled" | "abandoned"): Promise<void>;
  /**
   * R-2: returns CLAIMED stock for a group whose orders were never placed (stock is only returned
   * when the order will not be placed). Idempotent; a noop for anything that is not CLAIMED.
   */
  unclaim(orderGroupId: string, reason: "payment_failed" | "cancelled" | "abandoned"): Promise<void>;
}

export type HoldResult =
  | { readonly kind: "held"; readonly holdId: string }
  | { readonly kind: "insufficient" };

export type CaptureResult = { readonly kind: "captured" } | { readonly kind: "not_held" } | { readonly kind: "not_found" };

/** Closed-loop store credit holds (spec 15.2). Idempotent on `holdId`. */
export interface StoreCreditPort {
  balances(userId: string): Promise<readonly SubBalanceState[]>;
  hold(input: {
    readonly holdId: string;
    readonly userId: string;
    readonly plan: readonly SubBalanceSpend[];
    /** How long the hold must live: the method's payment window plus a grace. A hold never outlives a live saga. */
    readonly ttlSeconds: number;
  }): Promise<HoldResult>;
  /**
   * `orderEntryKey` is the ledger key under which the saga posts the order recognition entry.
   * `not_held` (released or expired) and `not_found` are hard failures the caller must act on.
   * Capturing again under the same key is a replay and returns `captured`.
   */
  capture(input: { readonly holdId: string; readonly userId: string; readonly orderEntryKey: string }): Promise<CaptureResult>;
  release(input: { readonly holdId: string; readonly userId: string }): Promise<void>;
}

export type ClientAction =
  | { readonly type: "none" }
  | { readonly type: "redirect"; readonly url: string }
  | { readonly type: "sdk"; readonly sdk: string; readonly token: string }
  | { readonly type: "fawry_reference"; readonly reference: string; readonly expiresAtMs: number }
  | { readonly type: "await_confirmation"; readonly channel: "otp" | "whatsapp" };

export type CreateIntentResult =
  | {
      readonly kind: "created";
      readonly intentId: string;
      readonly provider: string;
      readonly clientAction: ClientAction;
    }
  | { readonly kind: "rejected"; readonly code: string };

export interface PaymentEvent {
  readonly eventId: string;
  readonly provider: string;
  readonly intentId: string;
  readonly orderGroupId: string;
  readonly kind: "succeeded" | "failed";
  readonly amount: Money;
  readonly occurredAtMs: number;
}

export type WebhookVerification =
  | { readonly ok: true; readonly event: PaymentEvent }
  | { readonly ok: false; readonly reason: "bad_signature" | "stale_timestamp" | "malformed" | "unknown_provider" };

/** The only thing checkout knows about a PSP (spec 7). Adapters: in-repo fake, recorded fixtures. */
export interface PaymentProviderPort {
  readonly provider: string;
  createIntent(input: {
    /** = order_group_id: the PSP idempotency key (ADR-0021 d6). */
    readonly idempotencyKey: string;
    readonly amount: Money;
    readonly method: CheckoutMethod;
    readonly userId: string;
  }): Promise<CreateIntentResult>;
  voidIntent(intentId: string): Promise<{ readonly kind: "voided" | "already_voided" } | { readonly kind: "not_voidable_succeeded" }>;
  refund(input: { readonly intentId: string; readonly amount: Money; readonly idempotencyKey: string }): Promise<void>;
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>, nowMs: number): WebhookVerification;
}

export interface LedgerPort {
  /** Idempotent on `entry.idempotencyKey`. A same key with different postings is a LedgerKeyConflictError. */
  post(entry: JournalEntry): Promise<{ readonly kind: "posted" | "duplicate" }>;
  find(idempotencyKey: string): Promise<JournalEntry | null>;
}

export class LedgerKeyConflictError extends Error {
  constructor(readonly key: string) {
    super(`idempotency key ${key} already used with different postings`);
    this.name = "LedgerKeyConflictError";
  }
}

export interface PlaceOrdersCommand {
  readonly groupId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly paymentMethod: CheckoutMethod;
  readonly paidAtMs: number;
  readonly storeCredit: Money;
  readonly sellerOrders: readonly {
    readonly id: string;
    readonly storeId: string;
    readonly commissionRateBps: number;
    readonly shipping: Money;
    readonly discount: Money;
    readonly vat: Money;
    readonly lines: readonly {
      readonly id: string;
      readonly skuId: string;
      readonly productId: string;
      readonly qty: number;
      readonly unitPrice: Money;
      readonly discountAlloc: Money;
      readonly vat: Money;
      readonly title: LocalizedText;
      readonly sizeLabel?: string;
    }[];
    readonly buyer: DeliveryContact;
  }[];
}

/** = orders PlaceOrders. Idempotent on `idempotencyKey`. */
export interface OrdersIntakePort {
  place(cmd: PlaceOrdersCommand): Promise<{ readonly kind: "created" | "duplicate"; readonly groupId: string }>;
}

export interface MetricsPort {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}

// --------------------------------------------------------------------------- persistence

export interface StoredLine {
  readonly lineId: string;
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly discount: Money;
  readonly vat: Money;
  readonly title: LocalizedText;
  readonly sizeLabel?: string;
}

export interface StoredQuote {
  readonly quote: CheckoutQuote;
  readonly lines: readonly StoredLine[];
  readonly commissionBps: Readonly<Record<string, number>>;
  readonly buyer: DeliveryContact;
  readonly addressId: string | null;
  /** Expiry of the signed price lock this checkout was committed under (absent on rows written before F-14). */
  readonly lockExpiresAtMs?: number;
}

export interface SagaRecord {
  readonly orderGroupId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly cartHash: string;
  readonly facts: SagaFacts;
  readonly stored: StoredQuote;
  readonly provider: string | null;
  readonly clientAction: ClientAction | null;
  readonly version: number;
  readonly attempts: number;
  readonly nextWakeAtMs: number | null;
  readonly lastError: string | null;
  readonly stuck: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface OutboxDraft {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export type CreateSagaResult =
  | { readonly kind: "created" }
  | { readonly kind: "duplicate_key"; readonly existing: SagaRecord }
  | { readonly kind: "duplicate_cart"; readonly existing: SagaRecord };

export interface PaymentEventRecord {
  readonly id: string;
  readonly provider: string;
  readonly eventId: string;
  readonly orderGroupId: string | null;
  readonly intentId: string | null;
  readonly kind: "succeeded" | "failed" | "rejected";
  readonly amount: bigint | null;
  readonly signatureOk: boolean;
  readonly rejectReason: string | null;
  readonly body: string;
  readonly receivedAtMs: number;
}

export interface SagaRepository {
  create(record: SagaRecord, events: readonly OutboxDraft[]): Promise<CreateSagaResult>;
  get(orderGroupId: string): Promise<SagaRecord | null>;
  /** Owner-scoped read: another user's saga is null (BOLA, 404). */
  getForUser(orderGroupId: string, userId: string): Promise<SagaRecord | null>;
  findByKey(userId: string, idempotencyKey: string): Promise<SagaRecord | null>;
  /** Compare-and-swap on `version`. Events are written in the same transaction. */
  save(next: SagaRecord, expectedVersion: number, events: readonly OutboxDraft[]): Promise<boolean>;
  /** Non-terminal, not stuck sagas whose wake time has passed, oldest first. */
  due(nowMs: number, limit: number): Promise<readonly SagaRecord[]>;
  recordPaymentEvent(e: PaymentEventRecord): Promise<"new" | "duplicate">;
  markPaymentEventApplied(provider: string, eventId: string, atMs: number): Promise<void>;
}

/** Provider routing: the PSP chosen for a method (primary, failover via kill switch) and lookup by name. */
export interface PaymentRegistry {
  forMethod(method: CheckoutMethod): PaymentProviderPort | null;
  byName(name: string): PaymentProviderPort | null;
}

export type JournalEntryLike = JournalEntry;

/** Verifies the OTP or WhatsApp reply that confirms a risk-gated COD order (spec 20.7). */
export interface CodConfirmationPort {
  verify(input: { readonly userId: string; readonly orderGroupId: string; readonly code: string }): Promise<boolean>;
}
