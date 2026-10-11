import { defineMachine, guard } from "../machine";

export const ORDER_GROUP_STATES = [
  "CREATED",
  "RESERVED",
  "PAYMENT_PENDING",
  "PAID",
  "CONFIRMED_COD",
  "FULFILLING",
  "COMPLETED",
  "EXPIRED",
  "FAILED",
  "CANCELLED",
] as const;
export type OrderGroupState = (typeof ORDER_GROUP_STATES)[number];

export const ORDER_GROUP_EVENTS = [
  "RESERVE",
  "STOCK_UNAVAILABLE",
  "PAYMENT_INTENT_CREATED",
  "COD_CONFIRMED",
  "PAYMENT_SUCCEEDED",
  "PAYMENT_FAILED",
  "RESERVATION_EXPIRED",
  "PAYMENT_WINDOW_ELAPSED",
  "LATE_PAYMENT_CLAIMED",
  "LATE_PAYMENT_REFUND",
  "FULFILMENT_STARTED",
  "ALL_SELLER_ORDERS_DONE",
  "ALL_SELLER_ORDERS_CANCELLED",
  "CANCEL",
] as const;
export type OrderGroupEvent = (typeof ORDER_GROUP_EVENTS)[number];

export interface OrderGroupContext {
  /** True when a late payment can still claim stock (spec 17 edge case). */
  readonly stockAvailable: boolean;
}

const stockAvailable = guard<OrderGroupContext>("stockAvailable", (c) => c.stockAvailable);

export const orderGroupMachine = defineMachine<OrderGroupState, OrderGroupEvent, OrderGroupContext>({
  name: "OrderGroup",
  states: ORDER_GROUP_STATES,
  events: ORDER_GROUP_EVENTS,
  initial: "CREATED",
  terminal: ["COMPLETED", "FAILED", "CANCELLED"],
  transitions: {
    CREATED: {
      RESERVE: { to: "RESERVED" },
      STOCK_UNAVAILABLE: { to: "FAILED" },
      CANCEL: { to: "CANCELLED" },
    },
    RESERVED: {
      PAYMENT_INTENT_CREATED: { to: "PAYMENT_PENDING" },
      COD_CONFIRMED: { to: "CONFIRMED_COD" },
      RESERVATION_EXPIRED: { to: "EXPIRED" },
      CANCEL: { to: "CANCELLED" },
    },
    PAYMENT_PENDING: {
      PAYMENT_SUCCEEDED: { to: "PAID" },
      PAYMENT_FAILED: { to: "FAILED" },
      PAYMENT_WINDOW_ELAPSED: { to: "EXPIRED" },
      CANCEL: { to: "CANCELLED" },
    },
    EXPIRED: {
      LATE_PAYMENT_CLAIMED: { to: "PAID", guard: stockAvailable },
      LATE_PAYMENT_REFUND: { to: "CANCELLED" },
    },
    PAID: {
      FULFILMENT_STARTED: { to: "FULFILLING" },
      ALL_SELLER_ORDERS_CANCELLED: { to: "CANCELLED" },
    },
    CONFIRMED_COD: {
      FULFILMENT_STARTED: { to: "FULFILLING" },
      ALL_SELLER_ORDERS_CANCELLED: { to: "CANCELLED" },
    },
    FULFILLING: {
      ALL_SELLER_ORDERS_DONE: { to: "COMPLETED" },
      ALL_SELLER_ORDERS_CANCELLED: { to: "CANCELLED" },
    },
    COMPLETED: {},
    FAILED: {},
    CANCELLED: {},
  },
});
