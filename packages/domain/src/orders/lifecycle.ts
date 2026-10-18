import { sellerOrderMachine, type SellerOrderEvent, type SellerOrderState } from "../state-machine";
import { AcceptWindowElapsedError, NotCancellableError, ReturnsOpenError } from "./errors";
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

/** Courier-driven: SHIPPED -> OUT_FOR_DELIVERY. A repeated delivery event is a no-op for the caller. */
export function decideOutForDelivery(o: OrderFacts): Transition {
  const to = step(o.status, "OUT_FOR_DELIVERY");
  return { from: o.status, to, event: "OUT_FOR_DELIVERY", actorType: "COURIER", reasonCode: null, stamps: {} };
}

/** Courier-driven: OUT_FOR_DELIVERY -> DELIVERED. `deliveredAtMs` is the courier-confirmed time (spec B5). */
export function decideDeliver(o: OrderFacts, deliveredAtMs: number): Transition {
  const to = step(o.status, "DELIVER");
  return { from: o.status, to, event: "DELIVER", actorType: "COURIER", reasonCode: null, stamps: { deliveredAtMs } };
}

/**
 * System sweep: DELIVERED -> CLOSED once the return window plus the grace has elapsed (spec 20.1,
 * T4). Returns null while the window is open or when the order is not DELIVERED, so the sweep never
 * throws on a row that moved under it.
 */
export function decideClose(
  o: OrderFacts & { readonly deliveredAtMs: number | null; readonly openReturns?: number },
  nowMs: number,
  closeAfterMs: number,
): Transition | null {
  if (o.status !== "DELIVERED" || o.deliveredAtMs === null) return null;
  const elapsed = nowMs - o.deliveredAtMs >= closeAfterMs;
  if (!elapsed) return null;
  // A line with a non-terminal return is never closed (CPL 181/2018; creators accrual gate A-9).
  if ((o.openReturns ?? 0) > 0) throw new ReturnsOpenError("a return on this order is still open");
  const to = sellerOrderMachine.transition(o.status, "CLOSE", { returnWindowElapsed: true, deliveryAttempts: 0 });
  return { from: o.status, to, event: "CLOSE", actorType: "SYSTEM", reasonCode: "return_window_elapsed", stamps: { closedAtMs: nowMs } };
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

const DAY_MS = 86_400_000;
/** Statutory floor: 30 days for defects (CPL 181/2018), counted from courier-confirmed delivery. */
export const MIN_RETURN_WINDOW_DAYS = 30;
/** Payout margin after the window (spec 20.1 / T4). */
export const CLOSE_MARGIN_DAYS = 3;

/**
 * Delay from delivery to closure for a seller's own window. Integer days; a seller can lengthen the
 * window but never go below the statutory 30 days. Unknown or invalid policy falls back to the floor.
 */
export function closeAfterMsForWindowDays(windowDays: number | null): number {
  const d = windowDays !== null && Number.isInteger(windowDays) && windowDays > 0 ? Math.max(windowDays, MIN_RETURN_WINDOW_DAYS) : MIN_RETURN_WINDOW_DAYS;
  return (d + CLOSE_MARGIN_DAYS) * DAY_MS;
}
