import { defineMachine, guard } from "../machine";

export const RETURN_STATES = [
  "REQUESTED",
  "PICKUP_SCHEDULED",
  "IN_TRANSIT",
  "RECEIVED",
  "APPROVED",
  "REJECTED",
  "DISPUTED",
  "REFUNDED",
  "EXCHANGED",
  "CLOSED",
  "CANCELLED",
] as const;
export type ReturnState = (typeof RETURN_STATES)[number];

export const RETURN_EVENTS = [
  "SCHEDULE_PICKUP",
  "PICKUP_FAILED",
  "PICK_UP",
  "RECEIVE",
  "APPROVE",
  "AUTO_APPROVE",
  "REJECT",
  "OPEN_DISPUTE",
  "UPHOLD_FOR_SHOPPER",
  "UPHOLD_FOR_SELLER",
  "DISPUTE_WINDOW_ELAPSED",
  "COMPLETE_REFUND",
  "SHIP_EXCHANGE",
  "CANCEL",
] as const;
export type ReturnEvent = (typeof RETURN_EVENTS)[number];

export interface ReturnContext {
  /** A rejection requires photos (spec 22). */
  readonly rejectionPhotosAttached: boolean;
  /** The 48h inspection SLA has passed with no seller action (spec 22: silence auto-approves). */
  readonly inspectionSlaElapsed: boolean;
}

const photos = guard<ReturnContext>("rejectionPhotosAttached", (c) => c.rejectionPhotosAttached);
const slaElapsed = guard<ReturnContext>("inspectionSlaElapsed", (c) => c.inspectionSlaElapsed);

export const returnMachine = defineMachine<ReturnState, ReturnEvent, ReturnContext>({
  name: "Return",
  states: RETURN_STATES,
  events: RETURN_EVENTS,
  initial: "REQUESTED",
  terminal: ["REFUNDED", "EXCHANGED", "CLOSED", "CANCELLED"],
  transitions: {
    REQUESTED: { SCHEDULE_PICKUP: { to: "PICKUP_SCHEDULED" }, CANCEL: { to: "CANCELLED" } },
    PICKUP_SCHEDULED: {
      PICK_UP: { to: "IN_TRANSIT" },
      PICKUP_FAILED: { to: "REQUESTED" },
      CANCEL: { to: "CANCELLED" },
    },
    IN_TRANSIT: { RECEIVE: { to: "RECEIVED" } },
    RECEIVED: {
      APPROVE: { to: "APPROVED" },
      AUTO_APPROVE: { to: "APPROVED", guard: slaElapsed },
      REJECT: { to: "REJECTED", guard: photos },
    },
    APPROVED: {
      COMPLETE_REFUND: { to: "REFUNDED" },
      SHIP_EXCHANGE: { to: "EXCHANGED" },
    },
    REJECTED: {
      OPEN_DISPUTE: { to: "DISPUTED" },
      DISPUTE_WINDOW_ELAPSED: { to: "CLOSED" },
    },
    DISPUTED: {
      UPHOLD_FOR_SHOPPER: { to: "APPROVED" },
      UPHOLD_FOR_SELLER: { to: "CLOSED" },
    },
    REFUNDED: {},
    EXCHANGED: {},
    CLOSED: {},
    CANCELLED: {},
  },
});
