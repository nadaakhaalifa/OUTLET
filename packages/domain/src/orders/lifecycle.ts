import { sellerOrderMachine, type SellerOrderEvent, type SellerOrderState } from "../state-machine";
import { AcceptWindowElapsedError, NotCancellableError } from "./errors";
import {
  ACCEPT_SLA_MS,
  DISPATCH_SLA_MS,
  SHOPPER_CANCELLABLE,
  type CancelInitiator,
  type OrderFacts,
  type RejectReason,
  type Transition,
} from "./types";

/** `accept_by`, frozen at intake. */
export const acceptDeadline = (paidAtMs: number): number => paidAtMs + ACCEPT_SLA_MS;
/** `dispatch_by`, frozen at acceptance. */
export const dispatchDeadline = (acceptedAtMs: number): number => DISPATCH_SLA_MS + acceptedAtMs;

/** Machine context for a seller order: the return window is irrelevant before shipping. */
const CTX = { returnWindowElapsed: false, deliveryAttempts: 0 } as const;

function step(from: SellerOrderState, event: SellerOrderEvent): SellerOrderState {
  return sellerOrderMachine.transition(from, event, CTX);
}

/** True while the seller may still act on acceptance (SLA not elapsed). A missing deadline never elapses. */
export const acceptWindowOpen = (o: OrderFacts, nowMs: number): boolean =>
  o.acceptByMs === null || nowMs < o.acceptByMs;

export function decideAccept(o: OrderFacts, nowMs: number): Transition {
  if (!acceptWindowOpen(o, nowMs) && (o.status === "PAID" || o.status === "CONFIRMED_COD")) {
    throw new AcceptWindowElapsedError("the accept window has elapsed");
  }
  const to = step(o.status, "SELLER_ACCEPT");
  return {
    from: o.status,
    to,
    event: "SELLER_ACCEPT",
    actorType: "SELLER",
    reasonCode: null,
    stamps: { acceptedAtMs: nowMs, dispatchByMs: dispatchDeadline(nowMs) },
  };
}

export function decidePack(o: OrderFacts, nowMs: number): Transition {
  const to = step(o.status, "PACK");
  return { from: o.status, to, event: "PACK", actorType: "SELLER", reasonCode: null, stamps: { packedAtMs: nowMs } };
}

/** Fulfilment-driven; no seller HTTP route (the shipment is created through the shipments API). */
export function decideShip(o: OrderFacts, nowMs: number): Transition {
  const to = step(o.status, "SHIP");
  return { from: o.status, to, event: "SHIP", actorType: "COURIER", reasonCode: null, stamps: { shippedAtMs: nowMs } };
}

/** Rejection never refunds: it only decides the transition and names the reason for the saga. */
export function decideReject(o: OrderFacts, reason: RejectReason, nowMs: number): Transition {
  const to = step(o.status, "SELLER_REJECT");
  return {
    from: o.status,
    to,
    event: "SELLER_REJECT",
    actorType: "SELLER",
    reasonCode: reason,
    stamps: { cancelledAtMs: nowMs },
    rejectReason: reason,
  };
}

export function decideCancel(
  o: OrderFacts,
  initiator: CancelInitiator,
  reason: string,
  nowMs: number,
): Transition {
  if (!SHOPPER_CANCELLABLE.includes(o.status)) {
    throw new NotCancellableError(`a ${o.status} order can no longer be cancelled`);
  }
  const to = step(o.status, "CANCEL");
  return {
    from: o.status,
    to,
    event: "CANCEL",
    actorType: initiator === "SHOPPER" ? "SHOPPER" : initiator === "ADMIN" ? "ADMIN" : "SYSTEM",
    reasonCode: reason,
    stamps: { cancelledAtMs: nowMs },
    cancelInitiator: initiator,
  };
}

/** The sweep: only unaccepted orders whose deadline has passed are cancelled by the system. */
export function isAcceptSlaExpired(o: OrderFacts, nowMs: number): boolean {
  return (
    (o.status === "PAID" || o.status === "CONFIRMED_COD") && o.acceptByMs !== null && nowMs >= o.acceptByMs
  );
}

export function decideAcceptSlaExpiry(o: OrderFacts, nowMs: number): Transition | null {
  if (!isAcceptSlaExpired(o, nowMs)) return null;
  return decideCancel(o, "SYSTEM_TIMEOUT", "accept_sla_expired", nowMs);
}

export const isCancellable = (status: SellerOrderState): boolean => SHOPPER_CANCELLABLE.includes(status);

/**
 * Whether money was taken that a refund must return. COD collects nothing before delivery, so
 * cancelling a COD order only voids it. The saga (F-1) decides routing; this is a hint on the event.
 */
export const refundRequired = (o: OrderFacts): boolean => o.paymentType === "prepaid" && o.status !== "PENDING_PAYMENT";
