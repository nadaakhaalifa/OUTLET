import { defineMachine, guard } from "../machine";

export const SELLER_ORDER_STATES = [
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED_COD",
  "ACCEPTED",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CLOSED",
  "RETURN_REQUESTED",
  "RETURN_PICKUP_SCHEDULED",
  "RETURN_IN_TRANSIT",
  "RETURN_RECEIVED",
  "RETURN_INSPECTED",
  "REFUNDED",
  "RETURN_REJECTED",
  "CANCELLED",
  "REJECTED_BY_SELLER",
  "DELIVERY_FAILED",
  "RTO",
  "RETURNED_TO_SELLER",
  "DISPUTED",
] as const;
export type SellerOrderState = (typeof SELLER_ORDER_STATES)[number];

export const SELLER_ORDER_EVENTS = [
  "PAYMENT_SUCCEEDED",
  "COD_CONFIRMED",
  "PAYMENT_FAILED",
  "SELLER_ACCEPT",
  "SELLER_REJECT",
  "PACK",
  "SHIP",
  "OUT_FOR_DELIVERY",
  "DELIVER",
  "DELIVERY_FAIL",
  "RETRY_DELIVERY",
  "RETURN_TO_SELLER",
  "RTO_RECEIVED",
  "CANCEL",
  "REQUEST_RETURN",
  "CANCEL_RETURN",
  "SCHEDULE_PICKUP",
  "PICKED_UP",
  "RECEIVE_RETURN",
  "INSPECT_COMPLETE",
  "AUTO_APPROVE",
  "REJECT_RETURN",
  "REFUND_COMPLETED",
  "OPEN_DISPUTE",
  "RESOLVE_FOR_SHOPPER",
  "RESOLVE_FOR_SELLER",
  "CLOSE",
] as const;
export type SellerOrderEvent = (typeof SELLER_ORDER_EVENTS)[number];

export interface SellerOrderContext {
  /** Return window plus 3 days has elapsed (spec 20.1 / T4). Computed by the caller from an injected clock. */
  readonly returnWindowElapsed: boolean;
  /** Courier delivery attempts made so far; 3 attempts then RTO (spec 21). */
  readonly deliveryAttempts: number;
}

export const MAX_DELIVERY_ATTEMPTS = 3;

const windowElapsed = guard<SellerOrderContext>("returnWindowElapsed", (c) => c.returnWindowElapsed);
const attemptsLeft = guard<SellerOrderContext>(
  "deliveryAttemptsLeft",
  (c) => c.deliveryAttempts < MAX_DELIVERY_ATTEMPTS,
);
const attemptsExhausted = guard<SellerOrderContext>(
  "deliveryAttemptsExhausted",
  (c) => c.deliveryAttempts >= MAX_DELIVERY_ATTEMPTS,
);

export const sellerOrderMachine = defineMachine<SellerOrderState, SellerOrderEvent, SellerOrderContext>({
  name: "SellerOrder",
  states: SELLER_ORDER_STATES,
  events: SELLER_ORDER_EVENTS,
  initial: "PENDING_PAYMENT",
  terminal: ["CLOSED", "REFUNDED", "CANCELLED", "REJECTED_BY_SELLER"],
  transitions: {
    PENDING_PAYMENT: {
      PAYMENT_SUCCEEDED: { to: "PAID" },
      COD_CONFIRMED: { to: "CONFIRMED_COD" },
      PAYMENT_FAILED: { to: "CANCELLED" },
      CANCEL: { to: "CANCELLED" },
    },
    PAID: {
      SELLER_ACCEPT: { to: "ACCEPTED" },
      SELLER_REJECT: { to: "REJECTED_BY_SELLER" },
      CANCEL: { to: "CANCELLED" },
    },
    CONFIRMED_COD: {
      SELLER_ACCEPT: { to: "ACCEPTED" },
      SELLER_REJECT: { to: "REJECTED_BY_SELLER" },
      CANCEL: { to: "CANCELLED" },
    },
    ACCEPTED: {
      PACK: { to: "PACKED" },
      SELLER_REJECT: { to: "REJECTED_BY_SELLER" },
      CANCEL: { to: "CANCELLED" },
    },
    PACKED: {
      SHIP: { to: "SHIPPED" },
      CANCEL: { to: "CANCELLED" },
    },
    SHIPPED: {
      OUT_FOR_DELIVERY: { to: "OUT_FOR_DELIVERY" },
      DELIVERY_FAIL: { to: "DELIVERY_FAILED" },
    },
    OUT_FOR_DELIVERY: {
      DELIVER: { to: "DELIVERED" },
      DELIVERY_FAIL: { to: "DELIVERY_FAILED" },
    },
    DELIVERY_FAILED: {
      RETRY_DELIVERY: { to: "OUT_FOR_DELIVERY", guard: attemptsLeft },
      RETURN_TO_SELLER: { to: "RTO", guard: attemptsExhausted },
    },
    RTO: {
      RTO_RECEIVED: { to: "RETURNED_TO_SELLER" },
    },
    RETURNED_TO_SELLER: {
      REFUND_COMPLETED: { to: "REFUNDED" },
      CLOSE: { to: "CLOSED" },
    },
    DELIVERED: {
      REQUEST_RETURN: { to: "RETURN_REQUESTED" },
      OPEN_DISPUTE: { to: "DISPUTED" },
      CLOSE: { to: "CLOSED", guard: windowElapsed },
    },
    RETURN_REQUESTED: {
      SCHEDULE_PICKUP: { to: "RETURN_PICKUP_SCHEDULED" },
      CANCEL_RETURN: { to: "DELIVERED" },
    },
    RETURN_PICKUP_SCHEDULED: {
      PICKED_UP: { to: "RETURN_IN_TRANSIT" },
      CANCEL_RETURN: { to: "DELIVERED" },
    },
    RETURN_IN_TRANSIT: {
      RECEIVE_RETURN: { to: "RETURN_RECEIVED" },
    },
    RETURN_RECEIVED: {
      INSPECT_COMPLETE: { to: "RETURN_INSPECTED" },
      AUTO_APPROVE: { to: "RETURN_INSPECTED" },
    },
    RETURN_INSPECTED: {
      REFUND_COMPLETED: { to: "REFUNDED" },
      REJECT_RETURN: { to: "RETURN_REJECTED" },
    },
    RETURN_REJECTED: {
      OPEN_DISPUTE: { to: "DISPUTED" },
      CLOSE: { to: "CLOSED" },
    },
    DISPUTED: {
      RESOLVE_FOR_SHOPPER: { to: "REFUNDED" },
      RESOLVE_FOR_SELLER: { to: "CLOSED" },
    },
    CLOSED: {},
    REFUNDED: {},
    CANCELLED: {},
    REJECTED_BY_SELLER: {},
  },
});
