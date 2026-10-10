import { z } from "zod";
import type {
  Money,
  RefundAllocation,
  RefundPreference,
  RejectionReason,
  ReturnClass,
  ReturnMethod,
  ReturnReason,
  ReturnResolution,
  ReturnState,
  ShippingPayer,
} from "./bridge";

/** What the orders module knows about a delivered order line (read only). */
export interface ReturnableLine {
  readonly orderLineId: string;
  readonly sellerOrderId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly qtyOrdered: number;
  /** VAT-inclusive unit price actually charged (after item-level discounts). */
  readonly unitPrice: Money;
  /** Whole-line voucher and discount share allocated at checkout. */
  readonly discountAlloc: Money;
  /** Whole-line share of the seller order's delivery fee. */
  readonly deliveryFeeAlloc: Money;
  /** Courier-confirmed delivery instant, or null while undelivered. */
  readonly deliveredAtMs: number | null;
  readonly returnClass: ReturnClass;
  /** Units still open in the OTHER lines of the same seller order. 0 means this line is the whole order. */
  readonly otherLinesOpenQty: number;
}

export interface ReturnableLinePort {
  find(orderLineId: string): Promise<ReturnableLine | null>;
}

export interface MembershipPort {
  isPlusMember(userId: string): Promise<boolean>;
}

export interface ReturnerHistory {
  readonly deliveredOrders: number;
  readonly returnedOrders: number;
}

/** Trailing history for the serial-returner policy. Returned orders exclude seller-fault and late returns. */
export interface ReturnerHistoryPort {
  history(userId: string, sinceMs: number, untilMs: number): Promise<ReturnerHistory>;
}

/** Upload ownership (media module). Fail closed: unknown ids are "not owned". */
export interface EvidencePort {
  ownedBy(actorId: string, uploadIds: readonly string[]): Promise<boolean>;
}

export interface ExchangeStockPort {
  inStock(skuId: string, qty: number): Promise<boolean>;
}

export class ReturnsDependencyUnavailableError extends Error {
  constructor(readonly dependency: string) {
    super(`${dependency} unavailable`);
    this.name = "ReturnsDependencyUnavailableError";
  }
}

export interface LineSnapshot {
  readonly qtyOrdered: number;
  readonly unitPrice: Money;
  readonly discountAlloc: Money;
  readonly deliveryFeeAlloc: Money;
}

export type EvidenceKind = "shopper_photo" | "inspection_photo" | "dispute_photo";
export type UploaderType = "shopper" | "seller" | "hub" | "trust_safety";

export interface EvidenceRecord {
  readonly uploadId: string;
  readonly kind: EvidenceKind;
  readonly uploadedByType: UploaderType;
  readonly uploadedById: string;
  readonly uploadedAtMs: number;
}

export type DisputeStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED_FOR_SHOPPER" | "RESOLVED_FOR_SELLER";

export interface DisputeRecord {
  readonly id: string;
  readonly returnId: string;
  readonly status: DisputeStatus;
  readonly statement: string;
  readonly reviewDueAtMs: number;
  readonly decidedAtMs: number | null;
  readonly createdAtMs: number;
}

export type InspectionResult = "approved" | "auto_approved" | "rejected";

export interface ReturnRecord {
  readonly id: string;
  readonly userId: string;
  readonly orderLineId: string;
  readonly sellerOrderId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly priorQty: number;
  readonly reason: ReturnReason;
  readonly resolution: ReturnResolution;
  readonly exchangeSkuId: string | null;
  readonly refundPreference: RefundPreference;
  readonly method: ReturnMethod;
  readonly state: ReturnState;
  readonly shippingPayer: ShippingPayer;
  readonly deliveredAtMs: number;
  readonly windowEndsAtMs: number;
  readonly note: string | null;
  readonly receivedAtMs: number | null;
  readonly inspectionDueAtMs: number | null;
  readonly inspectedAtMs: number | null;
  readonly inspectionNote: string | null;
  readonly inspectionResult: InspectionResult | null;
  readonly rejectionReason: RejectionReason | null;
  readonly disputeWindowEndsAtMs: number | null;
  readonly deliveryFeeRefundable: boolean;
  readonly lineSnapshot: LineSnapshot;
  readonly refundIntent: RefundAllocation | null;
  readonly intentPublishedAtMs: number | null;
  readonly idempotencyKey: string;
  readonly version: number;
  readonly createdAtMs: number;
  readonly evidence: readonly EvidenceRecord[];
  readonly dispute: DisputeRecord | null;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface StandingRecord {
  readonly userId: string;
  readonly deliveredOrders: number;
  readonly returnedOrders: number;
  readonly rateBps: number;
  readonly freeReturnsRemoved: boolean;
  readonly noticeSentAtMs: number | null;
  readonly evaluatedAtMs: number;
}

export type CreateOutcome =
  | { readonly kind: "created"; readonly record: ReturnRecord }
  | { readonly kind: "over_capacity" }
  /** `priorQty` on the record no longer matches the committed quantity: recompute and retry. */
  | { readonly kind: "conflict" }
  | { readonly kind: "duplicate"; readonly record: ReturnRecord };

export interface ReturnRepository {
  findById(id: string): Promise<ReturnRecord | null>;
  findByIdempotencyKey(userId: string, key: string): Promise<ReturnRecord | null>;
  /**
   * Atomically (serialised per order line): refuses when `priorQty + qty` would exceed
   * `lineQty`, otherwise stores the record with `priorQty` set to the quantity already in
   * non-cancelled returns of the line. A repeated `(userId, idempotencyKey)` returns the first.
   */
  createIfCapacity(record: ReturnRecord, lineQty: number): Promise<CreateOutcome>;
  /** Units of the line in non-cancelled returns. */
  committedQty(orderLineId: string): Promise<number>;
  /** Non-cancelled exchange returns already made on the line (free first exchange). */
  exchangeCount(orderLineId: string): Promise<number>;
  /** Compare-and-set on `version`; writes new evidence and the dispute in the same unit. */
  save(record: ReturnRecord, expectedVersion: number): Promise<boolean>;
  listForUser(userId: string, cursor: string | null, limit: number): Promise<Page<ReturnRecord>>;
  listForStores(storeIds: readonly string[], cursor: string | null, limit: number): Promise<Page<ReturnRecord>>;
  listInspectionOverdue(nowMs: number, limit: number): Promise<readonly ReturnRecord[]>;
  listDisputeWindowElapsed(nowMs: number, limit: number): Promise<readonly ReturnRecord[]>;
  listUnpublishedIntents(limit: number): Promise<readonly ReturnRecord[]>;
  hasOpenReturns(userId: string): Promise<boolean>;
  getStanding(userId: string): Promise<StandingRecord | null>;
  saveStanding(s: StandingRecord): Promise<void>;
}

const Amount = z.string().regex(/^\d+$/);
const AllocLine = z
  .object({
    orderLineId: z.string(),
    qty: z.number().int().min(1),
    itemAmount: Amount,
    voucherShare: Amount,
    deliveryFeeShare: Amount,
    netAmount: Amount,
  })
  .strict();

export const RefundIntentEventSchema = z
  .object({
    name: z.literal("return.refund_intent"),
    returnId: z.string(),
    userId: z.string(),
    storeId: z.string(),
    sellerOrderId: z.string(),
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
  .strict();
export type RefundIntentEvent = z.infer<typeof RefundIntentEventSchema>;

export type ReturnEvent =
  | RefundIntentEvent
  | {
      readonly name: "return.exchange_intent";
      readonly returnId: string;
      readonly userId: string;
      readonly storeId: string;
      readonly sellerOrderId: string;
      readonly orderLineId: string;
      readonly exchangeSkuId: string;
      readonly qty: number;
      readonly shippingPayer: ShippingPayer;
      readonly idempotencyKey: string;
      readonly occurredAtMs: number;
    }
  | {
      readonly name: "return.requested";
      readonly returnId: string;
      readonly userId: string;
      readonly storeId: string;
      readonly orderLineId: string;
      readonly reason: ReturnReason;
      readonly resolution: ReturnResolution;
      readonly occurredAtMs: number;
    }
  | { readonly name: "return.received"; readonly returnId: string; readonly storeId: string; readonly occurredAtMs: number }
  | {
      readonly name: "return.inspected";
      readonly returnId: string;
      readonly storeId: string;
      readonly result: InspectionResult;
      readonly occurredAtMs: number;
    }
  | { readonly name: "return.disputed"; readonly returnId: string; readonly storeId: string; readonly occurredAtMs: number }
  | {
      readonly name: "return.serial_returner_notice";
      readonly userId: string;
      readonly rateBps: number;
      readonly deliveredOrders: number;
      readonly returnedOrders: number;
      readonly occurredAtMs: number;
    };

export interface ReturnEventPublisher {
  publish(event: ReturnEvent): Promise<void>;
}
