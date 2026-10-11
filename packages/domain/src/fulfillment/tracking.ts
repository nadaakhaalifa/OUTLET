import {
  MAX_SHIPMENT_ATTEMPTS,
  shipmentMachine,
  type ShipmentContext,
  type ShipmentEvent,
  type ShipmentState,
} from "../state-machine";
import type {
  FulfillmentTrackingEvent,
  FulfillmentTrackingKind,
  ShipmentSnapshot,
  ShipmentStep,
  TrackingOutcome,
} from "./types";

/** Position on the forward path. Terminal and post-delivery states sit beyond every forward kind. */
const STATE_RANK: Readonly<Record<ShipmentState, number>> = {
  LABEL_PENDING: 0,
  LABEL_CREATED: 1,
  PICKED_UP: 2,
  IN_TRANSIT: 3,
  OUT_FOR_DELIVERY: 4,
  DELIVERY_ATTEMPT_FAILED: 4,
  DELIVERED: 5,
  COD_REMITTED: 6,
  RECONCILED: 7,
  RTO_INITIATED: 8,
  RETURNED_TO_SELLER: 9,
  CANCELLED: 9,
  LOST: 9,
};

const FORWARD_RANK: Readonly<Partial<Record<FulfillmentTrackingKind, number>>> = {
  label_created: 1,
  picked_up: 2,
  in_transit: 3,
  out_for_delivery: 4,
  delivered: 5,
};

/** The event that advances one rung of the ladder from a state, or null when none applies. */
const FORWARD_STEP: Readonly<Partial<Record<ShipmentState, ShipmentEvent>>> = {
  LABEL_PENDING: "CREATE_LABEL",
  LABEL_CREATED: "PICK_UP",
  PICKED_UP: "IN_TRANSIT",
  IN_TRANSIT: "OUT_FOR_DELIVERY",
  OUT_FOR_DELIVERY: "DELIVER",
  DELIVERY_ATTEMPT_FAILED: "RETRY",
};

const ctxOf = (s: ShipmentSnapshot): ShipmentContext => ({ cod: s.cod, attemptsMade: s.attemptsMade });

interface Work {
  snap: ShipmentSnapshot;
  steps: ShipmentStep[];
}

function step(w: Work, event: ShipmentEvent, ctx: ShipmentContext = ctxOf(w.snap)): void {
  const to = shipmentMachine.transition(w.snap.state, event, ctx);
  w.steps.push({ event, from: w.snap.state, to });
  w.snap = { ...w.snap, state: to };
}

function stamp(w: Work, atMs: number): void {
  if (w.snap.state === "PICKED_UP" && w.snap.pickedUpAtMs === null) w.snap = { ...w.snap, pickedUpAtMs: atMs };
  if (w.snap.state === "DELIVERED" && w.snap.deliveredAtMs === null) w.snap = { ...w.snap, deliveredAtMs: atMs };
}

/** Walk forward until the machine reaches the rung of `targetRank`. Caller checked it is reachable. */
function walkTo(w: Work, targetRank: number, atMs: number): void {
  while (STATE_RANK[w.snap.state] < targetRank || w.snap.state === "DELIVERY_ATTEMPT_FAILED") {
    const ev = FORWARD_STEP[w.snap.state];
    if (ev === undefined) return;
    step(w, ev);
    stamp(w, atMs);
    if (w.snap.state === "OUT_FOR_DELIVERY" && targetRank === 4) return;
  }
}

const ignored = (snap: ShipmentSnapshot, reason: "stale" | "invalid_transition"): TrackingOutcome => ({
  kind: "ignored",
  reason,
  next: snap,
});

const FORWARD_ELIGIBLE = (s: ShipmentState): boolean => STATE_RANK[s] <= 4;

/**
 * Pure tracking reducer. Applies one verified, de-duplicated courier fact to a shipment snapshot
 * through the existing Shipment state machine. Never throws for a courier fact: an inapplicable
 * fact comes back as `ignored`. Dedup by courier event id happens in the repository, before this.
 *
 * Policy (docs/specs/fulfillment.md): forward only, no regressions; the third failed delivery
 * attempt immediately initiates RTO; `delivered_at` is stamped once from the courier event time.
 */
export function applyTracking(snapshot: ShipmentSnapshot, event: FulfillmentTrackingEvent): TrackingOutcome {
  const w: Work = { snap: snapshot, steps: [] };
  const at = event.occurredAtMs;
  const state = snapshot.state;
  const done = (): TrackingOutcome => ({ kind: "applied", next: w.snap, steps: w.steps });

  switch (event.kind) {
    case "label_created":
    case "picked_up":
    case "in_transit":
    case "out_for_delivery":
    case "delivered": {
      const target = FORWARD_RANK[event.kind] ?? 0;
      if (!FORWARD_ELIGIBLE(state)) return ignored(snapshot, "stale");
      // A failed attempt only moves forward through a new out_for_delivery (or a delivery).
      if (state === "DELIVERY_ATTEMPT_FAILED") {
        if (target < 4) return ignored(snapshot, "stale");
        if (snapshot.attemptsMade >= MAX_SHIPMENT_ATTEMPTS) return ignored(snapshot, "invalid_transition");
      } else if (STATE_RANK[state] >= target) {
        return ignored(snapshot, "stale");
      }
      walkTo(w, target, at);
      return done();
    }
    case "delivery_failed": {
      if (state === "DELIVERY_ATTEMPT_FAILED") return ignored(snapshot, "stale");
      if (!FORWARD_ELIGIBLE(state)) {
        return ignored(snapshot, STATE_RANK[state] >= 5 && state !== "DELIVERED" ? "stale" : "invalid_transition");
      }
      walkTo(w, 4, at);
      if (w.snap.state !== "OUT_FOR_DELIVERY") return ignored(snapshot, "invalid_transition");
      w.snap = { ...w.snap, attemptsMade: w.snap.attemptsMade + 1 };
      step(w, "ATTEMPT_FAILED");
      if (w.snap.attemptsMade >= MAX_SHIPMENT_ATTEMPTS) step(w, "INITIATE_RTO");
      return done();
    }
    case "customer_refused": {
      if (!FORWARD_ELIGIBLE(state)) return ignored(snapshot, state === "DELIVERED" ? "invalid_transition" : "stale");
      if (state === "DELIVERY_ATTEMPT_FAILED" && snapshot.attemptsMade >= MAX_SHIPMENT_ATTEMPTS) {
        return ignored(snapshot, "invalid_transition");
      }
      walkTo(w, 4, at);
      if (w.snap.state !== "OUT_FOR_DELIVERY") return ignored(snapshot, "invalid_transition");
      step(w, "CUSTOMER_REFUSED");
      return done();
    }
    case "rto_initiated": {
      if (state === "RTO_INITIATED" || STATE_RANK[state] >= 9) return ignored(snapshot, "stale");
      if (state !== "DELIVERY_ATTEMPT_FAILED") return ignored(snapshot, "invalid_transition");
      // The courier's own policy decided the attempts are exhausted.
      step(w, "INITIATE_RTO", { cod: snapshot.cod, attemptsMade: MAX_SHIPMENT_ATTEMPTS });
      return done();
    }
    case "rto_delivered": {
      if (state === "RETURNED_TO_SELLER") return ignored(snapshot, "stale");
      if (state !== "RTO_INITIATED") return ignored(snapshot, "invalid_transition");
      step(w, "RTO_DELIVERED");
      return done();
    }
    case "cancelled": {
      if (state === "CANCELLED") return ignored(snapshot, "stale");
      if (!shipmentMachine.can(state, "CANCEL", ctxOf(snapshot))) return ignored(snapshot, "invalid_transition");
      step(w, "CANCEL");
      return done();
    }
    case "lost": {
      if (state === "LOST") return ignored(snapshot, "stale");
      if (!shipmentMachine.can(state, "MARK_LOST", ctxOf(snapshot))) return ignored(snapshot, "invalid_transition");
      step(w, "MARK_LOST");
      return done();
    }
  }
}

/** Initial snapshot of a freshly created shipment. */
export function newShipmentSnapshot(cod: boolean): ShipmentSnapshot {
  return { state: shipmentMachine.initial, attemptsMade: 0, cod, pickedUpAtMs: null, deliveredAtMs: null };
}

/** Marks the AWB as created. Not a courier fact: it is the result of our own CourierPort call. */
export function applyAwbCreated(snapshot: ShipmentSnapshot): ShipmentSnapshot {
  if (snapshot.state !== "LABEL_PENDING") return snapshot;
  return { ...snapshot, state: shipmentMachine.transition(snapshot.state, "CREATE_LABEL", ctxOf(snapshot)) };
}

/** Wire status vocabulary (openapi `Shipment.status`, plus `cancelled` and `lost`, see spec). */
export const FULFILLMENT_WIRE_STATUSES = [
  "label_pending",
  "label_ready",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "rto",
  "returned_to_seller",
  "cancelled",
  "lost",
] as const;
export type FulfillmentWireStatus = (typeof FULFILLMENT_WIRE_STATUSES)[number];

const WIRE: Readonly<Record<ShipmentState, FulfillmentWireStatus>> = {
  LABEL_PENDING: "label_pending",
  LABEL_CREATED: "label_ready",
  PICKED_UP: "picked_up",
  IN_TRANSIT: "in_transit",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERY_ATTEMPT_FAILED: "delivery_failed",
  DELIVERED: "delivered",
  COD_REMITTED: "delivered",
  RECONCILED: "delivered",
  RTO_INITIATED: "rto",
  RETURNED_TO_SELLER: "returned_to_seller",
  CANCELLED: "cancelled",
  LOST: "lost",
};

export function toWireStatus(state: ShipmentState): FulfillmentWireStatus {
  return WIRE[state];
}
