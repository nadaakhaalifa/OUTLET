import { InvalidReturnInputError } from "./errors";

/**
 * Transparent serial-returner policy (spec 22): published, never secret. A return rate strictly
 * above 60% over at least 10 delivered orders in the trailing 6 months removes free returns.
 * Only returns the shopper is answerable for count (the adapter excludes seller-fault and late).
 */
export const SERIAL_RETURNER_POLICY = {
  windowMonths: 6,
  minDeliveredOrders: 10,
  /** Strictly above this, in basis points (6000 = 60%). */
  rateAboveBps: 6000,
} as const;

export interface ReturnerHistory {
  readonly deliveredOrders: number;
  readonly returnedOrders: number;
}

export interface ReturnerStanding {
  readonly deliveredOrders: number;
  readonly returnedOrders: number;
  /** Floor of the rate in basis points, for display. */
  readonly rateBps: number;
  readonly freeReturnsRemoved: boolean;
}

export function evaluateReturnerStanding(h: ReturnerHistory): ReturnerStanding {
  if (!Number.isInteger(h.deliveredOrders) || !Number.isInteger(h.returnedOrders)) {
    throw new InvalidReturnInputError("order counts must be integers");
  }
  if (h.deliveredOrders < 0 || h.returnedOrders < 0 || h.returnedOrders > h.deliveredOrders) {
    throw new InvalidReturnInputError("returned orders must be between 0 and delivered orders");
  }
  const rateBps = h.deliveredOrders === 0 ? 0 : Math.floor((h.returnedOrders * 10_000) / h.deliveredOrders);
  const removed =
    h.deliveredOrders >= SERIAL_RETURNER_POLICY.minDeliveredOrders &&
    h.returnedOrders * 10_000 > SERIAL_RETURNER_POLICY.rateAboveBps * h.deliveredOrders;
  return { deliveredOrders: h.deliveredOrders, returnedOrders: h.returnedOrders, rateBps, freeReturnsRemoved: removed };
}
