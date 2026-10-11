import { defineMachine, guard } from "../machine";

export const DISPUTE_STATES = [
  "OPEN",
  "UNDER_REVIEW",
  "AWAITING_EVIDENCE",
  "ESCALATED",
  "RESOLVED_FOR_SHOPPER",
  "RESOLVED_FOR_SELLER",
  "WITHDRAWN",
  "CLOSED",
] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

export const DISPUTE_EVENTS = [
  "ASSIGN_REVIEWER",
  "REQUEST_EVIDENCE",
  "EVIDENCE_RECEIVED",
  "SLA_BREACHED",
  "RESOLVE_FOR_SHOPPER",
  "RESOLVE_FOR_SELLER",
  "WITHDRAW",
  "FINALISE",
] as const;
export type DisputeEvent = (typeof DISPUTE_EVENTS)[number];

export interface DisputeContext {
  /** A human reviewer made the decision (spec 22: T&S review is human). */
  readonly decidedByHuman: boolean;
}

const human = guard<DisputeContext>("decidedByHuman", (c) => c.decidedByHuman);

export const disputeMachine = defineMachine<DisputeState, DisputeEvent, DisputeContext>({
  name: "Dispute",
  states: DISPUTE_STATES,
  events: DISPUTE_EVENTS,
  initial: "OPEN",
  terminal: ["WITHDRAWN", "CLOSED"],
  transitions: {
    OPEN: { ASSIGN_REVIEWER: { to: "UNDER_REVIEW" }, WITHDRAW: { to: "WITHDRAWN" } },
    UNDER_REVIEW: {
      REQUEST_EVIDENCE: { to: "AWAITING_EVIDENCE" },
      SLA_BREACHED: { to: "ESCALATED" },
      RESOLVE_FOR_SHOPPER: { to: "RESOLVED_FOR_SHOPPER", guard: human },
      RESOLVE_FOR_SELLER: { to: "RESOLVED_FOR_SELLER", guard: human },
      WITHDRAW: { to: "WITHDRAWN" },
    },
    AWAITING_EVIDENCE: { EVIDENCE_RECEIVED: { to: "UNDER_REVIEW" }, WITHDRAW: { to: "WITHDRAWN" } },
    ESCALATED: {
      RESOLVE_FOR_SHOPPER: { to: "RESOLVED_FOR_SHOPPER", guard: human },
      RESOLVE_FOR_SELLER: { to: "RESOLVED_FOR_SELLER", guard: human },
    },
    RESOLVED_FOR_SHOPPER: { FINALISE: { to: "CLOSED" } },
    RESOLVED_FOR_SELLER: { FINALISE: { to: "CLOSED" } },
    WITHDRAWN: {},
    CLOSED: {},
  },
});
