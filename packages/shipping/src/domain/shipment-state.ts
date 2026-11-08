import { ShippingError } from "./errors.js";

/** Normalised shipment statuses (master prompt 21). Owning table/column: shipments.status. */
export const SHIPMENT_STATUSES = [
  "LABEL_PENDING", "LABEL_READY", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RTO", "RETURNED_TO_SELLER", "CANCELLED",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const MAX_DELIVERY_ATTEMPTS = 3;

/** Table-driven transitions. DELIVERY_FAILED -> RTO happens automatically on the third failed attempt (see applyTracking). */
export const TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  LABEL_PENDING: ["LABEL_READY", "CANCELLED"],
  LABEL_READY: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["IN_TRANSIT", "OUT_FOR_DELIVERY", "RTO"],
  IN_TRANSIT: ["OUT_FOR_DELIVERY", "RTO"],
  OUT_FOR_DELIVERY: ["DELIVERED", "DELIVERY_FAILED"],
  DELIVERY_FAILED: ["OUT_FOR_DELIVERY", "RTO"],
  DELIVERED: [],
  RTO: ["RETURNED_TO_SELLER"],
  RETURNED_TO_SELLER: [],
  CANCELLED: [],
};

export interface ShipmentState {
  readonly status: ShipmentStatus;
  readonly attempts: number;
}

export type TrackingResult =
  | { readonly kind: "applied"; readonly state: ShipmentState }
  | { readonly kind: "duplicate"; readonly state: ShipmentState };

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(state: ShipmentState, to: ShipmentStatus): ShipmentState {
  if (!canTransition(state.status, to)) throw new ShippingError("INVALID_TRANSITION", `${state.status} -> ${to}`);
  const attempts = to === "DELIVERY_FAILED" ? state.attempts + 1 : state.attempts;
  return { status: to, attempts };
}

/**
 * Applies a normalised courier event. Replays are idempotent: the same status as the current one is a duplicate (no change);
 * the third failed attempt moves on to RTO in the same step. Anything else outside TRANSITIONS throws INVALID_TRANSITION.
 */
export function applyTracking(state: ShipmentState, to: ShipmentStatus): TrackingResult {
  if (state.status === to) return { kind: "duplicate", state };
  let next = transition(state, to);
  if (next.status === "DELIVERY_FAILED" && next.attempts >= MAX_DELIVERY_ATTEMPTS) next = transition(next, "RTO");
  return { kind: "applied", state: next };
}
