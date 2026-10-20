import { z } from "zod";
import type {
  JournalEntry,
  Money,
  OriginalTender,
  PaymentMethod,
  RefundChannel,
  RefundChoice,
  RefundState,
  RefundStatus,
  StoreCreditSub,
} from "./bridge";

export type RefundSource = "return" | "cancellation" | "admin";

export interface StoredPosting {
  readonly account: string;
  readonly amount: bigint;
}

/** The journal entry computed at intake and posted, unchanged, before any provider call. */
export interface StoredEntry {
  /** The journal entry id chosen at intake (a uuid): the posting service rejects any other id. */
  readonly id: string;
  /** Ledger keys of which at least one must exist before this entry may be posted (order recognition). */
  readonly requires: readonly string[];
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly occurredAtMs: number;
  readonly ref: { readonly type: string; readonly id: string };
  readonly postings: readonly StoredPosting[];
}

export interface AllocationLine {
  readonly orderLineId: string;
  readonly qty: number;
  readonly itemAmount: bigint;
  /** Line value (after item discounts, before vouchers) at intake, for downstream proportional clawbacks. Absent on rows written before it. */
  readonly lineGross?: bigint;
  readonly voucherShare: bigint;
  readonly deliveryFeeShare: bigint;
  readonly netAmount: bigint;
}

export interface TenderRef {
  readonly psp?: string;
  readonly provider?: string;
  readonly courier?: string;
}

export interface RefundLegRecord {
  readonly id: string;
  readonly refundId: string;
  readonly position: number;
  readonly tenderId: string;
  readonly method: PaymentMethod;
  readonly channel: RefundChannel;
  readonly amount: bigint;
  readonly creditSub: StoreCreditSub | null;
  readonly tender: TenderRef;
  readonly state: RefundState;
  readonly attempts: number;
  readonly nextAttemptAtMs: number | null;
  readonly providerRef: string | null;
  readonly failureCode: string | null;
  readonly needsPayoutDetails: boolean;
  readonly verify: string | null;
  readonly note: string | null;
}

export interface RefundRecord {
  readonly id: string;
  readonly userId: string;
  readonly storeId: string;
  readonly sellerOrderId: string;
  readonly returnId: string | null;
  readonly source: RefundSource;
  readonly idempotencyKey: string;
  readonly status: RefundStatus;
  readonly amount: bigint;
  readonly itemTotal: bigint;
  readonly voucherTotal: bigint;
  readonly deliveryFeeTotal: bigint;
  readonly lines: readonly AllocationLine[];
  readonly entry: StoredEntry;
  readonly ledgerPostedAtMs: number | null;
  readonly returnReceivedAtMs: number | null;
  readonly requestedAtMs: number;
  readonly initiatedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly legs: readonly RefundLegRecord[];
  readonly version: number;
}

/** Outbox events (ids only, no contact data). */
export type RefundEvent =
  | { readonly type: "refund.requested"; readonly refundId: string; readonly userId: string; readonly amount: bigint; readonly returnId: string | null }
  | { readonly type: "refund.approved"; readonly refundId: string; readonly userId: string }
  | { readonly type: "refund.completed"; readonly refundId: string; readonly userId: string; readonly amount: bigint; readonly returnId: string | null }
  /**
   * One per refunded line when a refund COMPLETES (ledger-first already done). `refundedGross` is
   * cumulative goods value over every COMPLETED refund of the seller order for that line, so a
   * redelivery or a later partial refund can only move it up.
   */
  | {
      readonly type: "order_line.refunded";
      readonly refundId: string;
      readonly sellerOrderId: string;
      readonly orderLineId: string;
      readonly userId: string;
      readonly lineGross: bigint | null;
      readonly refundedGross: bigint;
      readonly delta: bigint;
    }
  | { readonly type: "refund.failed"; readonly refundId: string; readonly legId: string; readonly code: string; readonly attempts: number }
  | { readonly type: "refund.manual_review"; readonly refundId: string; readonly legId: string; readonly code: string }
  | { readonly type: "refund.intent_rejected"; readonly returnId: string; readonly reason: string };

export type IntakeOutcome = "created" | "duplicate" | "exists" | "stale";

/** What the refunds module already holds against one seller order (refunds not CANCELLED). */
export interface CommittedRefunds {
  /** Number of refunds counted: the compare-and-set token of `intake`. */
  readonly count: number;
  /** Goods value by order line id. */
  readonly byLine: ReadonlyMap<string, bigint>;
  /** Refund amount by tender id. */
  readonly byTender: ReadonlyMap<string, bigint>;
  readonly idempotencyKeys: ReadonlySet<string>;
  /** Delivery fee already refunded by this module's non-cancelled refunds of the seller order. */
  readonly fee: bigint;
}

export interface LegTransition {
  readonly legId: string;
  readonly from: RefundState;
  readonly to: RefundState;
  readonly attempts: number;
  readonly nextAttemptAtMs: number | null;
  /** undefined keeps the stored value. */
  readonly providerRef?: string | null;
  readonly failureCode: string | null;
  readonly attempt?: { readonly no: number; readonly outcome: "confirmed" | "pending" | "rejected" | "unavailable"; readonly code: string | null };
  readonly nowMs: number;
}

export interface RefundStore {
  /** Inbox row + refund + legs + `refund.requested`, one transaction. */
  intake(input: {
    readonly consumer: string;
    readonly messageId: string;
    readonly refund: RefundRecord;
    /** `CommittedRefunds.count` the capacity check was computed from. Another intent in between returns "stale". */
    readonly expectedCommitted: number;
  }): Promise<IntakeOutcome>;
  /** Refunds held against a seller order; capacity is enforced against this, serialised per seller order. */
  committedForSellerOrder(sellerOrderId: string): Promise<CommittedRefunds>;
  /** Inbox row for a message whose refund already exists (same return re-published). */
  acknowledgeExisting(input: { readonly consumer: string; readonly messageId: string }): Promise<"exists" | "duplicate">;
  /** Inbox row + `refund.intent_rejected`, one transaction (a message that must not be retried). */
  reject(input: { readonly consumer: string; readonly messageId: string; readonly returnId: string; readonly reason: string }): Promise<"recorded" | "duplicate">;
  get(id: string): Promise<RefundRecord | null>;
  /** Scoped by provider (psp, BNPL provider or courier code): references of two providers can collide. */
  findByProviderRef(provider: string, providerRef: string): Promise<{ readonly refundId: string; readonly leg: RefundLegRecord } | null>;
  listForUser(userId: string, page: { readonly after: { readonly createdAtMs: number; readonly id: string } | null; readonly limit: number }): Promise<readonly RefundRecord[]>;
  /** REQUESTED legs -> LEDGER_POSTED, status APPROVED, initiated_at. Idempotent. */
  markLedgerPosted(refundId: string, nowMs: number): Promise<void>;
  transitionLeg(t: LegTransition): Promise<"applied" | "stale">;
  /** Refund ids with work to do at `nowMs`, oldest first. */
  listActionable(nowMs: number, limit: number): Promise<readonly string[]>;
}

export interface RefundFactLine {
  readonly orderLineId: string;
  /** Line value after item discounts, before vouchers. */
  readonly gross: bigint;
  /** Goods value refunded by refunds this module does not hold (it adds its own in-flight refunds). */
  readonly refundedBefore: bigint;
}

export interface RefundFacts {
  readonly userId: string;
  readonly storeId: string;
  /** The order group whose recognition entry (order_paid / order_cod_confirmed) must exist. */
  readonly orderGroupId: string;
  /** Delivery fee the shopper paid for this seller order (R-3: the cap for every fee refund). */
  readonly deliveryFee: bigint;
  /** Fee refunded by refunds this module does not hold (it adds its own in-flight refunds). */
  readonly deliveryFeeRefundedBefore: bigint;
  readonly commissionBps: bigint;
  readonly vatBps: bigint;
  /**
   * Group tenders. `refundedBefore` covers refunds of OTHER seller orders of the group and refunds
   * not held by this module; this module adds its own refunds for this seller order.
   */
  readonly tenders: readonly OriginalTender[];
  /** Every line of the seller order: its merchandise is the sum of `gross`. */
  readonly lines: readonly RefundFactLine[];
  /** Voucher value on the whole seller order, by funder. */
  readonly platformVoucher: bigint;
  readonly sellerVoucher: bigint;
  readonly returnReceivedAtMs: number | null;
  readonly choice: Pick<RefundChoice, "cod">;
}

/** Read-only view of the payment and order facts (payments and orders modules). */
export interface RefundFactsPort {
  forSellerOrder(sellerOrderId: string): Promise<RefundFacts | null>;
}

export interface PayoutDetailsPort {
  /** True when a verified IBAN (bank transfer) or wallet (wallet transfer) is on file. */
  verified(userId: string, channel: "bank_transfer_iban" | "wallet_transfer"): Promise<boolean>;
}

export type LedgerPostResult = { readonly kind: "posted" | "replayed" };

/** Ledger-first: an idempotent post keyed by the entry's idempotency key. */
export interface RefundLedgerPort {
  post(entry: JournalEntry): Promise<LedgerPostResult>;
  /** True when an entry with this idempotency key exists. */
  hasEntry(key: string): Promise<boolean>;
}

export interface CreditRestorePort {
  /** Idempotent on `legId`: replays do nothing. */
  restore(input: {
    readonly userId: string;
    readonly sub: StoreCreditSub;
    readonly amount: Money;
    readonly refundId: string;
    readonly legId: string;
  }): Promise<void>;
}

export type ExecutionOutcome =
  | { readonly kind: "confirmed"; readonly providerRef: string }
  | { readonly kind: "pending"; readonly providerRef: string }
  | { readonly kind: "rejected"; readonly code: string };

export interface ExecutionRequest {
  /** Provider idempotency key: the leg id, identical on every retry. */
  readonly idempotencyKey: string;
  readonly channel: Exclude<RefundChannel, "store_credit" | "store_credit_original_sub">;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly tender: TenderRef;
  readonly attempt: number;
}

/** PaymentProviderPort refund side, BNPL cancellation and transfers. Fakes and fixtures only. */
export interface RefundExecutionPort {
  execute(request: ExecutionRequest): Promise<ExecutionOutcome>;
}

export interface IdPort {
  uuidV7(): string;
}
export interface ClockPort {
  nowMs(): number;
}
export interface JitterPort {
  /** Unit float in [0, 1). */
  next(): number;
}

const Amount = z.string().regex(/^\d+$/);
const AllocLine = z
  .object({
    orderLineId: z.string(),
    qty: z.number().int().positive(),
    itemAmount: Amount,
    voucherShare: Amount,
    deliveryFeeShare: Amount,
    netAmount: Amount,
  })
  .strict();

/** Mirrors `return.refund_intent` (returns module, RefundIntentEventSchema); checked by a contract test. */
export const RefundIntentMessageSchema = z
  .object({
    messageId: z.uuid(),
    event: z
      .object({
        name: z.literal("return.refund_intent"),
        returnId: z.uuid(),
        userId: z.uuid(),
        storeId: z.uuid(),
        sellerOrderId: z.uuid(),
        orderLineId: z.string(),
        reason: z.string(),
        refundPreference: z.enum(["original_method", "store_credit"]),
        shippingPayer: z.enum(["shopper", "seller", "platform_free"]),
        currency: z.literal("EGP"),
        allocation: z
          .object({
            lines: z.array(AllocLine).min(1),
            itemTotal: Amount,
            voucherTotal: Amount,
            deliveryFeeTotal: Amount,
            netTotal: Amount,
          })
          .strict(),
        idempotencyKey: z.string(),
        occurredAtMs: z.number().int(),
      })
      .strict(),
  })
  .strict();
export type RefundIntentMessage = z.infer<typeof RefundIntentMessageSchema>;
