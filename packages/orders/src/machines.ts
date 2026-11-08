/**
 * Order state machines (master prompt A2.6, section 20.1; docs/data-model.md 7.14 / 7.15; packages/checkout/README.md section 3).
 * XState-style tables: state -> event -> next state. A missing entry is an invalid transition and throws OrderStateError.
 * The SQL CHECK lists in migration 0016 must equal the *_STATES arrays (a test asserts it against the schema).
 */

export class OrderStateError extends Error {
  readonly code = "invalid_transition";
  constructor(readonly machine: string, readonly from: string, readonly event: string) {
    super(`${machine}: cannot ${event} from ${from}`);
    this.name = "OrderStateError";
  }
}

type Table<S extends string, E extends string> = Readonly<Record<S, Readonly<Partial<Record<E, S>>>>>;

export interface Machine<S extends string, E extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly terminal: readonly S[];
  readonly table: Table<S, E>;
}

export const transition = <S extends string, E extends string>(m: Machine<S, E>, from: S, event: E): S => {
  const next = m.table[from][event];
  if (next === undefined) throw new OrderStateError(m.name, from, event);
  return next;
};
export const can = <S extends string, E extends string>(m: Machine<S, E>, from: S, event: E): boolean => m.table[from][event] !== undefined;

// ---------------------------------------------------------------- OrderGroup (one payment)
export const ORDER_GROUP_STATES = [
  "PENDING_PAYMENT", "AWAITING_COD_CONFIRMATION", "PAID", "CONFIRMED_COD", "PAYMENT_FAILED", "EXPIRED",
  "REFUND_PENDING", "REFUNDED", "PARTIALLY_FULFILLED", "COMPLETED", "CANCELLED",
] as const;
export type OrderGroupState = (typeof ORDER_GROUP_STATES)[number];
export const ORDER_GROUP_EVENTS = [
  "payment_succeeded", "payment_failed", "expire", "cod_requires_confirmation", "cod_confirmed",
  "late_payment_claimed", "late_payment_unavailable", "refund_completed", "fulfil_part", "fulfil_all", "cancel",
] as const;
export type OrderGroupEvent = (typeof ORDER_GROUP_EVENTS)[number];

export const ORDER_GROUP: Machine<OrderGroupState, OrderGroupEvent> = {
  name: "order_group",
  initial: "PENDING_PAYMENT",
  states: ORDER_GROUP_STATES,
  events: ORDER_GROUP_EVENTS,
  terminal: ["REFUNDED", "COMPLETED", "CANCELLED"],
  table: {
    PENDING_PAYMENT: {
      payment_succeeded: "PAID", payment_failed: "PAYMENT_FAILED", expire: "EXPIRED",
      cod_requires_confirmation: "AWAITING_COD_CONFIRMATION", cod_confirmed: "CONFIRMED_COD", cancel: "CANCELLED",
    },
    AWAITING_COD_CONFIRMATION: { cod_confirmed: "CONFIRMED_COD", expire: "EXPIRED", cancel: "CANCELLED" },
    // Compensated states: money that still arrives is claimed if stock (and any credit) is still there, else refunded.
    PAYMENT_FAILED: { late_payment_claimed: "PAID", late_payment_unavailable: "REFUND_PENDING" },
    EXPIRED: { late_payment_claimed: "PAID", late_payment_unavailable: "REFUND_PENDING" },
    REFUND_PENDING: { refund_completed: "REFUNDED" },
    PAID: { fulfil_part: "PARTIALLY_FULFILLED", fulfil_all: "COMPLETED", cancel: "CANCELLED" },
    CONFIRMED_COD: { fulfil_part: "PARTIALLY_FULFILLED", fulfil_all: "COMPLETED", cancel: "CANCELLED" },
    PARTIALLY_FULFILLED: { fulfil_all: "COMPLETED" },
    REFUNDED: {},
    COMPLETED: {},
    CANCELLED: {},
  },
};

// ---------------------------------------------------------------- SellerOrder (one store)
export const SELLER_ORDER_STATES = [
  "PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "VOIDED", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED",
  "CLOSED", "CANCELLED", "REJECTED_BY_SELLER", "DELIVERY_FAILED", "RTO", "RETURNED_TO_SELLER", "DISPUTED",
] as const;
export type SellerOrderState = (typeof SELLER_ORDER_STATES)[number];
export const SELLER_ORDER_EVENTS = [
  "pay", "cod_confirm", "void", "late_pay", "accept", "reject", "accept_timeout", "cancel", "pack", "ship",
  "out_for_delivery", "deliver", "delivery_fail", "retry_delivery", "rto", "returned_to_seller", "close", "dispute", "resolve",
] as const;
export type SellerOrderEvent = (typeof SELLER_ORDER_EVENTS)[number];

export const SELLER_ORDER: Machine<SellerOrderState, SellerOrderEvent> = {
  name: "seller_order",
  initial: "PENDING_PAYMENT",
  states: SELLER_ORDER_STATES,
  events: SELLER_ORDER_EVENTS,
  terminal: ["CLOSED", "CANCELLED", "REJECTED_BY_SELLER", "RETURNED_TO_SELLER"],
  table: {
    PENDING_PAYMENT: { pay: "PAID", cod_confirm: "CONFIRMED_COD", void: "VOIDED" },
    VOIDED: { late_pay: "PAID" },
    PAID: { accept: "ACCEPTED", reject: "REJECTED_BY_SELLER", accept_timeout: "CANCELLED", cancel: "CANCELLED" },
    CONFIRMED_COD: { accept: "ACCEPTED", reject: "REJECTED_BY_SELLER", accept_timeout: "CANCELLED", cancel: "CANCELLED" },
    ACCEPTED: { pack: "PACKED", cancel: "CANCELLED" },
    PACKED: { ship: "SHIPPED", cancel: "CANCELLED" },
    // After SHIPPED a shopper cancellation becomes a refusal or a return (section 20.1): no cancel edge.
    SHIPPED: { out_for_delivery: "OUT_FOR_DELIVERY", deliver: "DELIVERED", delivery_fail: "DELIVERY_FAILED" },
    OUT_FOR_DELIVERY: { deliver: "DELIVERED", delivery_fail: "DELIVERY_FAILED" },
    DELIVERY_FAILED: { retry_delivery: "OUT_FOR_DELIVERY", rto: "RTO" },
    RTO: { returned_to_seller: "RETURNED_TO_SELLER" },
    // Returns live on return_requests; the seller order stays DELIVERED until the window closes.
    DELIVERED: { close: "CLOSED", dispute: "DISPUTED" },
    DISPUTED: { resolve: "DELIVERED" },
    CLOSED: {},
    CANCELLED: {},
    REJECTED_BY_SELLER: {},
    RETURNED_TO_SELLER: {},
  },
};

// ---------------------------------------------------------------- PaymentIntent (external tender)
export const PAYMENT_INTENT_STATES = [
  "CREATED", "REQUIRES_ACTION", "AUTHORIZED", "CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED", "FAILED", "CANCELLED", "EXPIRED", "NOT_REQUIRED",
] as const;
export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number];
export const PAYMENT_INTENT_EVENTS = [
  "provider_created", "authorize", "capture", "fail", "cancel", "expire", "late_capture", "refund_part", "refund_full", "not_required",
] as const;
export type PaymentIntentEvent = (typeof PAYMENT_INTENT_EVENTS)[number];

export const PAYMENT_INTENT: Machine<PaymentIntentState, PaymentIntentEvent> = {
  name: "payment_intent",
  initial: "CREATED",
  states: PAYMENT_INTENT_STATES,
  events: PAYMENT_INTENT_EVENTS,
  terminal: ["REFUNDED", "NOT_REQUIRED"],
  table: {
    CREATED: { provider_created: "REQUIRES_ACTION", authorize: "AUTHORIZED", capture: "CAPTURED", fail: "FAILED", cancel: "CANCELLED", expire: "EXPIRED", not_required: "NOT_REQUIRED" },
    REQUIRES_ACTION: { authorize: "AUTHORIZED", capture: "CAPTURED", fail: "FAILED", cancel: "CANCELLED", expire: "EXPIRED" },
    AUTHORIZED: { capture: "CAPTURED", fail: "FAILED", cancel: "CANCELLED", expire: "EXPIRED" },
    CAPTURED: { refund_part: "PARTIALLY_REFUNDED", refund_full: "REFUNDED" },
    PARTIALLY_REFUNDED: { refund_part: "PARTIALLY_REFUNDED", refund_full: "REFUNDED" },
    // The PSP is the truth for money: a capture reported after we failed, voided or expired the intent is recorded.
    FAILED: { late_capture: "CAPTURED" },
    CANCELLED: { late_capture: "CAPTURED" },
    EXPIRED: { late_capture: "CAPTURED" },
    REFUNDED: {},
    NOT_REQUIRED: {},
  },
};

/** States reachable from the initial state (breadth-first). Used by the "no unreachable state" property. */
export const reachable = <S extends string, E extends string>(m: Machine<S, E>): ReadonlySet<S> => {
  const seen = new Set<S>([m.initial]);
  const queue: S[] = [m.initial];
  for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
    for (const next of Object.values<S | undefined>(m.table[s])) {
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
};
