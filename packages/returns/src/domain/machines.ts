import type { Machine } from "@outlet/orders";

/** Return (data-model 7.19): REQUESTED -> APPROVED -> PICKUP_SCHEDULED -> IN_TRANSIT -> RECEIVED -> ACCEPTED | REJECTED -> DISPUTED -> ... -> CLOSED. */
export const RETURN_STATES = ["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "ACCEPTED", "REJECTED", "DISPUTED", "CANCELLED", "CLOSED"] as const;
export type ReturnState = (typeof RETURN_STATES)[number];
export const RETURN_EVENTS = [
  "approve", "reject", "cancel", "schedule_pickup", "in_transit", "receive", "inspect_accept", "auto_accept", "inspect_reject", "dispute",
  "resolve_shopper", "resolve_seller", "refund_completed", "close",
] as const;
export type ReturnEvent = (typeof RETURN_EVENTS)[number];

export const RETURN: Machine<ReturnState, ReturnEvent> = {
  name: "return",
  initial: "REQUESTED",
  states: RETURN_STATES,
  events: RETURN_EVENTS,
  terminal: ["CLOSED", "CANCELLED"],
  table: {
    REQUESTED: { approve: "APPROVED", reject: "REJECTED", cancel: "CANCELLED" },
    APPROVED: { schedule_pickup: "PICKUP_SCHEDULED", in_transit: "IN_TRANSIT", cancel: "CANCELLED" },
    PICKUP_SCHEDULED: { in_transit: "IN_TRANSIT", cancel: "CANCELLED" },
    IN_TRANSIT: { receive: "RECEIVED" },
    // Inspection within 48 h of receipt; silence = auto_accept (section 22).
    RECEIVED: { inspect_accept: "ACCEPTED", auto_accept: "ACCEPTED", inspect_reject: "REJECTED" },
    ACCEPTED: { refund_completed: "CLOSED", close: "CLOSED" },
    REJECTED: { dispute: "DISPUTED", close: "CLOSED" },
    DISPUTED: { resolve_shopper: "ACCEPTED", resolve_seller: "CLOSED" },
    CANCELLED: {},
    CLOSED: {},
  },
};

export const DISPUTE_STATES = ["OPEN", "UNDER_REVIEW", "RESOLVED_SHOPPER", "RESOLVED_SELLER", "WITHDRAWN"] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];
export const DISPUTE_EVENTS = ["assign", "resolve_shopper", "resolve_seller", "withdraw"] as const;
export type DisputeEvent = (typeof DISPUTE_EVENTS)[number];
export const DISPUTE: Machine<DisputeState, DisputeEvent> = {
  name: "dispute",
  initial: "OPEN",
  states: DISPUTE_STATES,
  events: DISPUTE_EVENTS,
  terminal: ["RESOLVED_SHOPPER", "RESOLVED_SELLER", "WITHDRAWN"],
  table: {
    OPEN: { assign: "UNDER_REVIEW", resolve_shopper: "RESOLVED_SHOPPER", resolve_seller: "RESOLVED_SELLER", withdraw: "WITHDRAWN" },
    UNDER_REVIEW: { resolve_shopper: "RESOLVED_SHOPPER", resolve_seller: "RESOLVED_SELLER", withdraw: "WITHDRAWN" },
    RESOLVED_SHOPPER: {},
    RESOLVED_SELLER: {},
    WITHDRAWN: {},
  },
};

/** Refund (master prompt 15.6): REQUESTED -> APPROVED -> PROCESSING -> COMPLETED | FAILED (retry) | MANUAL_REVIEW. */
export const REFUND_STATES = ["REQUESTED", "APPROVED", "PROCESSING", "COMPLETED", "FAILED", "MANUAL_REVIEW"] as const;
export type RefundState = (typeof REFUND_STATES)[number];
export const REFUND_EVENTS = ["approve", "start", "complete", "fail", "retry", "escalate", "resolve_manually"] as const;
export type RefundEvent = (typeof REFUND_EVENTS)[number];
export const REFUND: Machine<RefundState, RefundEvent> = {
  name: "refund",
  initial: "REQUESTED",
  states: REFUND_STATES,
  events: REFUND_EVENTS,
  terminal: ["COMPLETED"],
  table: {
    REQUESTED: { approve: "APPROVED" },
    APPROVED: { start: "PROCESSING" },
    PROCESSING: { complete: "COMPLETED", fail: "FAILED", escalate: "MANUAL_REVIEW" },
    FAILED: { retry: "PROCESSING", escalate: "MANUAL_REVIEW" },
    MANUAL_REVIEW: { retry: "PROCESSING", resolve_manually: "COMPLETED" },
    COMPLETED: {},
  },
};
