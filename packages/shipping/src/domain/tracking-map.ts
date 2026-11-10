import type { ShipmentStatus } from "./shipment-state.js";

/**
 * Raw courier status -> normalised status (master prompt 21). Neutral vocabulary used by the fake courier; a real adapter ships its own
 * table once the contract and sandbox are verified (V33/V43). Unknown raw statuses map to nothing, never to a guess.
 */
export const GENERIC_STATUS_MAP: Readonly<Record<string, ShipmentStatus>> = {
  created: "LABEL_READY",
  label_created: "LABEL_READY",
  picked_up: "PICKED_UP",
  in_transit: "IN_TRANSIT",
  at_hub: "IN_TRANSIT",
  out_for_delivery: "OUT_FOR_DELIVERY",
  delivered: "DELIVERED",
  delivery_failed: "DELIVERY_FAILED",
  customer_unavailable: "DELIVERY_FAILED",
  customer_refused: "DELIVERY_FAILED",
  return_to_origin: "RTO",
  returned_to_seller: "RETURNED_TO_SELLER",
  cancelled: "CANCELLED",
};
