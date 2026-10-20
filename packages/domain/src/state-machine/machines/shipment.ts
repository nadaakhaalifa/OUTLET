import { defineMachine, guard } from "../machine";

export const SHIPMENT_STATES = [
  "LABEL_PENDING",
  "LABEL_CREATED",
  "PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVERY_ATTEMPT_FAILED",
  "DELIVERED",
  "COD_REMITTED",
  "RECONCILED",
  "RTO_INITIATED",
  "RETURNED_TO_SELLER",
  "CANCELLED",
  "LOST",
] as const;
export type ShipmentState = (typeof SHIPMENT_STATES)[number];

export const SHIPMENT_EVENTS = [
  "CREATE_LABEL",
  "PICK_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "DELIVER",
  "ATTEMPT_FAILED",
  "RETRY",
  "CUSTOMER_REFUSED",
  "INITIATE_RTO",
  "RTO_DELIVERED",
  "REMIT_COD",
  "RECONCILE",
  "CANCEL",
  "MARK_LOST",
] as const;
export type ShipmentEvent = (typeof SHIPMENT_EVENTS)[number];

export interface ShipmentContext {
  readonly cod: boolean;
  readonly attemptsMade: number;
}

export const MAX_SHIPMENT_ATTEMPTS = 3;

const isCod = guard<ShipmentContext>("isCod", (c) => c.cod);
const notCod = guard<ShipmentContext>("isNotCod", (c) => !c.cod);
const attemptsLeft = guard<ShipmentContext>("attemptsLeft", (c) => c.attemptsMade < MAX_SHIPMENT_ATTEMPTS);
const attemptsExhausted = guard<ShipmentContext>(
  "attemptsExhausted",
  (c) => c.attemptsMade >= MAX_SHIPMENT_ATTEMPTS,
);

export const shipmentMachine = defineMachine<ShipmentState, ShipmentEvent, ShipmentContext>({
  name: "Shipment",
  states: SHIPMENT_STATES,
  events: SHIPMENT_EVENTS,
  initial: "LABEL_PENDING",
  terminal: ["RECONCILED", "RETURNED_TO_SELLER", "CANCELLED", "LOST"],
  transitions: {
    LABEL_PENDING: { CREATE_LABEL: { to: "LABEL_CREATED" }, CANCEL: { to: "CANCELLED" } },
    LABEL_CREATED: { PICK_UP: { to: "PICKED_UP" }, CANCEL: { to: "CANCELLED" } },
    PICKED_UP: {
      IN_TRANSIT: { to: "IN_TRANSIT" },
      MARK_LOST: { to: "LOST" },
    },
    IN_TRANSIT: {
      OUT_FOR_DELIVERY: { to: "OUT_FOR_DELIVERY" },
      MARK_LOST: { to: "LOST" },
    },
    OUT_FOR_DELIVERY: {
      DELIVER: { to: "DELIVERED" },
      ATTEMPT_FAILED: { to: "DELIVERY_ATTEMPT_FAILED" },
      CUSTOMER_REFUSED: { to: "RTO_INITIATED" },
      MARK_LOST: { to: "LOST" },
    },
    DELIVERY_ATTEMPT_FAILED: {
      RETRY: { to: "OUT_FOR_DELIVERY", guard: attemptsLeft },
      INITIATE_RTO: { to: "RTO_INITIATED", guard: attemptsExhausted },
    },
    DELIVERED: {
      REMIT_COD: { to: "COD_REMITTED", guard: isCod },
      RECONCILE: { to: "RECONCILED", guard: notCod },
    },
    COD_REMITTED: { RECONCILE: { to: "RECONCILED" } },
    RTO_INITIATED: {
      RTO_DELIVERED: { to: "RETURNED_TO_SELLER" },
      MARK_LOST: { to: "LOST" },
    },
    RECONCILED: {},
    RETURNED_TO_SELLER: {},
    CANCELLED: {},
    LOST: {},
  },
});
