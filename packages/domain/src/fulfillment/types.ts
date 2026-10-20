import type { ShipmentState } from "../state-machine";

/** Courier-agnostic tracking vocabulary. Adapters map raw courier statuses onto these. */
export const FULFILLMENT_TRACKING_KINDS = [
  "label_created",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "customer_refused",
  "rto_initiated",
  "rto_delivered",
  "cancelled",
  "lost",
] as const;
export type FulfillmentTrackingKind = (typeof FULFILLMENT_TRACKING_KINDS)[number];

/** One normalized, already-verified tracking fact from a courier. */
export interface FulfillmentTrackingEvent {
  readonly courierEventId: string;
  readonly kind: FulfillmentTrackingKind;
  /** Courier-reported time of the fact, epoch ms. */
  readonly occurredAtMs: number;
  readonly reasonCode: string | null;
}

/** The part of a shipment the tracking reducer reads and writes. */
export interface ShipmentSnapshot {
  readonly state: ShipmentState;
  readonly attemptsMade: number;
  readonly cod: boolean;
  readonly pickedUpAtMs: number | null;
  readonly deliveredAtMs: number | null;
}

export type TrackingIgnoreReason = "stale" | "invalid_transition";

export type TrackingOutcome =
  | { readonly kind: "applied"; readonly next: ShipmentSnapshot; readonly steps: readonly ShipmentStep[] }
  | { readonly kind: "ignored"; readonly reason: TrackingIgnoreReason; readonly next: ShipmentSnapshot };

export interface ShipmentStep {
  readonly event: string;
  readonly from: ShipmentState;
  readonly to: ShipmentState;
}
