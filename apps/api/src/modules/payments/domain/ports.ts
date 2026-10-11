import type { ClientAction, SavedCardInput } from "./schemas";
import type {
  IntentView,
  NormalizedPaymentEvent,
  PaymentDomainEvent,
  PaymentIntentStatus,
  PaymentMethodId,
  ProviderId,
} from "./seam";
import type { JsonValue } from "./card-data-guard";

export type { JsonValue };

// ---- provider port ----------------------------------------------------------------------------

/** Closed set of failure kinds a PSP call can produce. Adapters never throw for PSP behaviour. */
export type ProviderFailure =
  /** Business decline. The PSP is healthy. */
  | { readonly kind: "declined"; readonly code: string }
  /** The PSP definitively did not accept the call (connect error, 5xx before processing). Safe to fail over. */
  | { readonly kind: "unavailable"; readonly code: string }
  /** No answer in time. AMBIGUOUS: the PSP may have processed it. Never fail over. */
  | { readonly kind: "timeout" }
  /** Response failed schema validation (API10). AMBIGUOUS like a timeout. */
  | { readonly kind: "invalid_response" }
  /** Our request was refused as malformed or unsupported (a bug or an unsupported method). */
  | { readonly kind: "invalid_request"; readonly code: string };

export type ProviderResult<T> = { readonly kind: "ok"; readonly value: T } | ProviderFailure;

export interface PayerContact {
  readonly userId: string;
  readonly phoneE164: string | null;
  readonly email: string | null;
}

export interface CreateIntentRequest {
  /** Also the PSP idempotency key (spec 7 saga step 4). */
  readonly orderGroupId: string;
  readonly idempotencyKey: string;
  readonly method: PaymentMethodId;
  readonly amount: bigint;
  readonly currency: string;
  readonly payer: PayerContact;
  /** Provider-side validity window for the payment, ms. */
  readonly expiresInMs: number;
}

export interface CreatedIntent {
  readonly providerRef: string;
  readonly clientAction: ClientAction;
  /** A hard PSP-side expiry when the PSP reports one (Fawry reference). */
  readonly expiresAtMs: number | null;
}

export interface RetrievedIntent {
  readonly providerRef: string;
  readonly status: PaymentIntentStatus;
  readonly amount: bigint;
  readonly currency: string;
  readonly failureCode: string | null;
}

export interface RefundOutcome {
  readonly providerRefundRef: string;
  readonly status: "succeeded" | "pending";
}

export type WebhookRejectReason =
  | "missing_signature"
  | "missing_timestamp"
  | "bad_signature"
  | "timestamp_out_of_window"
  | "timestamp_in_seconds"
  | "unparseable";

export type WebhookVerification =
  | { readonly ok: true; readonly eventId: string; readonly timestampMs: number }
  | { readonly ok: false; readonly reason: WebhookRejectReason };

export type ParsedWebhook =
  | { readonly type: "payment"; readonly event: NormalizedPaymentEvent }
  | { readonly type: "card_token"; readonly eventId: string; readonly userId: string; readonly card: SavedCardInput }
  | { readonly type: "ignored"; readonly reason: string }
  | { readonly type: "invalid"; readonly reason: string };

export interface WebhookInput {
  readonly rawBody: Uint8Array;
  /** Header names lower-cased. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly nowMs: number;
}

/**
 * Port every PSP adapter implements (spec 7, B8, 15.6). All money in integer piastres. No card
 * data crosses this port in either direction.
 */
export interface PaymentProviderPort {
  readonly id: ProviderId;
  /** Static capability: which methods this provider can serve at all. */
  readonly methods: readonly PaymentMethodId[];
  /** Idempotent by `orderGroupId`: the same request returns the same PSP intent. */
  createIntent(req: CreateIntentRequest): Promise<ProviderResult<CreatedIntent>>;
  capture(req: { providerRef: string; amount: bigint; idempotencyKey: string }): Promise<ProviderResult<{ status: "succeeded" }>>;
  void(req: { providerRef: string; idempotencyKey: string }): Promise<ProviderResult<{ status: "voided" }>>;
  refund(req: { providerRef: string; amount: bigint; idempotencyKey: string; reason: string }): Promise<ProviderResult<RefundOutcome>>;
  /** Lookup by PSP reference, or by order group when the reference was never persisted. */
  retrieve(req: { providerRef: string | null; orderGroupId: string }): Promise<ProviderResult<RetrievedIntent | null>>;
  deleteToken(req: { pspToken: string }): Promise<ProviderResult<{ status: "deleted" }>>;
  verifyWebhook(input: WebhookInput): WebhookVerification;
  /** Only called with the sanitized JSON of a body that passed `verifyWebhook`. */
  parseWebhook(body: JsonValue): ParsedWebhook;
}

// ---- other ports --------------------------------------------------------------------------------

/** Kill switch port; production adapter wraps `FlagClient.isPaymentMethodEnabled` (fails closed). */
export interface PaymentMethodSwitchPort {
  isEnabled(method: PaymentMethodId): Promise<boolean>;
}

export interface WebhookIpAllowListPort {
  isAllowed(provider: ProviderId, ip: string | undefined): Promise<boolean>;
}

export interface IdPort {
  uuidV7(): string;
}

// ---- store ----------------------------------------------------------------------------------

export interface PaymentIntentRecord {
  readonly id: string;
  readonly orderGroupId: string;
  readonly userId: string;
  readonly provider: ProviderId;
  readonly providerRef: string | null;
  readonly method: PaymentMethodId;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: PaymentIntentStatus;
  readonly refundedAmount: bigint;
  readonly clientAction: ClientAction | null;
  readonly idempotencyKey: string;
  readonly failureCode: string | null;
  readonly expiresAtMs: number;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface RawEventRecord {
  readonly id: string;
  readonly provider: ProviderId;
  readonly eventId: string;
  readonly signatureOk: boolean;
  readonly rejectReason: string | null;
  readonly body: JsonValue;
  readonly bodySha256: string;
  readonly receivedAtMs: number;
  readonly processedAtMs: number | null;
  readonly processOutcome: string | null;
}

export interface RefundRecord {
  readonly id: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly amount: bigint;
  readonly status: "pending" | "succeeded" | "failed";
  readonly providerRefundRef: string | null;
  readonly failureCode: string | null;
  readonly reason: string;
  readonly createdAtMs: number;
}

export interface SavedCardRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: ProviderId;
  readonly pspToken: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly fingerprint: string;
  readonly createdAtMs: number;
}

export type IntentPatch = Partial<
  Pick<PaymentIntentRecord, "provider" | "providerRef" | "status" | "refundedAmount" | "clientAction" | "failureCode" | "expiresAtMs">
>;

export interface IntentMutation {
  readonly patch: IntentPatch;
  readonly events: readonly PaymentDomainEvent[];
  readonly outcome: string;
}

export interface InboxRef {
  readonly consumer: string;
  readonly messageId: string;
}

export type MutateResult =
  | { readonly kind: "applied"; readonly intent: PaymentIntentRecord; readonly outcome: string }
  | { readonly kind: "duplicate" }
  | { readonly kind: "not_found" };

export type RefundInsert =
  | { readonly kind: "inserted"; readonly refund: RefundRecord }
  | { readonly kind: "exists"; readonly refund: RefundRecord }
  | { readonly kind: "exceeds_captured" }
  | { readonly kind: "not_refundable" };

export type SettleRefundResult =
  | { readonly kind: "applied"; readonly refund: RefundRecord; readonly intent: PaymentIntentRecord }
  | { readonly kind: "already_settled"; readonly refund: RefundRecord }
  | { readonly kind: "duplicate" }
  | { readonly kind: "not_found" };

export const toIntentView = (r: PaymentIntentRecord): IntentView => ({
  id: r.id,
  orderGroupId: r.orderGroupId,
  status: r.status,
  amount: r.amount,
  currency: r.currency,
  refundedAmount: r.refundedAmount,
  provider: r.provider,
  method: r.method,
});

/**
 * Persistence port. Every method is one transaction; outbox events are written in the same
 * transaction as the state change (spec A2.7). `mutateIntent` locks the row (FOR UPDATE in
 * Postgres, a synchronous section in memory) and calls `decide` on the locked, current record.
 */
export interface PaymentStore {
  insertIntent(
    intent: PaymentIntentRecord,
    events: readonly PaymentDomainEvent[],
  ): Promise<{ readonly kind: "inserted" | "exists"; readonly intent: PaymentIntentRecord }>;
  getIntent(id: string): Promise<PaymentIntentRecord | null>;
  getIntentByOrderGroup(orderGroupId: string): Promise<PaymentIntentRecord | null>;
  getIntentByProviderRef(provider: ProviderId, providerRef: string): Promise<PaymentIntentRecord | null>;
  mutateIntent(input: {
    readonly intentId: string;
    readonly decide: (current: PaymentIntentRecord) => IntentMutation | null;
    readonly inbox?: InboxRef;
    readonly rawEventId?: string;
  }): Promise<MutateResult>;
  /** Intents past `expiresAtMs` still waiting for the shopper (CREATED, REQUIRES_ACTION). */
  listExpirable(nowMs: number, limit: number): Promise<readonly PaymentIntentRecord[]>;

  /**
   * `signatureOk` rows also append `payment.webhook_received` in the same transaction; `events`
   * (for example a `pan_in_webhook` anomaly) are appended in that same transaction when stored.
   */
  recordRawEvent(rec: RawEventRecord, events?: readonly PaymentDomainEvent[]): Promise<"stored" | "duplicate">;
  getRawEvent(id: string): Promise<RawEventRecord | null>;
  listUnprocessedEventIds(limit: number): Promise<readonly string[]>;
  /** Marks a raw event processed without touching an intent (ignored, orphan, token). */
  settleRawEvent(input: {
    readonly rawEventId: string;
    readonly outcome: string;
    readonly events: readonly PaymentDomainEvent[];
    readonly inbox?: InboxRef;
  }): Promise<"settled" | "duplicate" | "not_found">;

  insertRefund(rec: RefundRecord): Promise<RefundInsert>;
  getRefundByKey(intentId: string, idempotencyKey: string): Promise<RefundRecord | null>;
  getRefundByProviderRef(providerRefundRef: string): Promise<RefundRecord | null>;
  /**
   * Every pending refund of exactly `amount` with no provider reference yet (call timed out), oldest
   * first. A webhook may settle by amount ONLY when exactly one is returned (F-9).
   */
  findPendingRefunds(intentId: string, amount: bigint): Promise<readonly RefundRecord[]>;
  /** Pending refunds that never got a provider reference, oldest first (resolved by idempotent replay). */
  listPendingRefundsWithoutRef(limit: number): Promise<readonly RefundRecord[]>;
  settleRefund(input: {
    readonly refundId: string;
    readonly outcome: "succeeded" | "failed";
    readonly providerRefundRef: string | null;
    readonly failureCode: string | null;
    readonly inbox?: InboxRef;
    readonly rawEventId?: string;
  }): Promise<SettleRefundResult>;

  upsertSavedCard(rec: SavedCardRecord, rawEventId?: string): Promise<{ readonly kind: "inserted" | "exists"; readonly card: SavedCardRecord }>;
  listSavedCards(userId: string): Promise<readonly SavedCardRecord[]>;
  getSavedCard(id: string, userId: string): Promise<SavedCardRecord | null>;
  deleteSavedCard(id: string, userId: string, nowMs: number): Promise<boolean>;
}

export const RAW_EVENT_MAX_BYTES = 256 * 1024;
