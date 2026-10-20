import type { SellerOrderState } from "../state-machine";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** Spec 19: the seller accepts within 24 h of payment, else auto-cancel. */
export const ACCEPT_SLA_MS = 24 * HOUR_MS;
/** Spec 19 / data-model orders: dispatch within 48 h of acceptance (store-configurable later). */
export const DISPATCH_SLA_MS = 48 * HOUR_MS;
/** Spec B1: sellers lose access to buyer delivery data 30 days after delivery or return closure. */
export const BUYER_ACCESS_GRACE_MS = 30 * DAY_MS;

export const PAYMENT_TYPES = ["prepaid", "cod"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

/** OpenAPI SellerOrderRejectRequest.reason. */
export const REJECT_REASONS = ["out_of_stock", "pricing_error", "cannot_fulfil", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** OpenAPI OrderCancelRequest.reason (shopper). */
export const SHOPPER_CANCEL_REASONS = [
  "changed_mind",
  "ordered_by_mistake",
  "found_cheaper",
  "delivery_too_slow",
  "other",
] as const;
export type ShopperCancelReason = (typeof SHOPPER_CANCEL_REASONS)[number];

export const CANCEL_INITIATORS = ["SHOPPER", "SYSTEM_TIMEOUT", "ADMIN", "RISK"] as const;
export type CancelInitiator = (typeof CANCEL_INITIATORS)[number];

export const ACTOR_TYPES = ["SHOPPER", "SELLER", "SYSTEM", "COURIER", "ADMIN"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** States in which the shopper may still cancel for free (spec 20.1: before SHIPPED). */
export const SHOPPER_CANCELLABLE: readonly SellerOrderState[] = [
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED_COD",
  "ACCEPTED",
  "PACKED",
];

/** The facts the pure lifecycle needs; storage records are a superset. */
export interface OrderFacts {
  readonly status: SellerOrderState;
  readonly paymentType: PaymentType;
  readonly acceptByMs: number | null;
}

/** What a transition decided: the machine event, the next state and the side facts to persist. */
export interface Transition {
  readonly from: SellerOrderState;
  readonly to: SellerOrderState;
  readonly event: string;
  readonly actorType: ActorType;
  readonly reasonCode: string | null;
  /** Seller-order timestamp columns set by this transition (ms). */
  readonly stamps: {
    readonly acceptedAtMs?: number;
    readonly dispatchByMs?: number;
    readonly packedAtMs?: number;
    readonly shippedAtMs?: number;
    readonly deliveredAtMs?: number;
    readonly closedAtMs?: number;
    readonly cancelledAtMs?: number;
  };
  readonly cancelInitiator?: CancelInitiator;
  readonly rejectReason?: RejectReason;
}
