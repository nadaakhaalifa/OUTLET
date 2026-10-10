import { defineMachine } from "../machine";

export const PRICE_CLAIM_STATES = [
  "SUBMITTED",
  "SCORING",
  "VERIFIED",
  "CORRECTED",
  "PLAIN_PRICE",
  "APPEALED",
  "REVOKED",
  "SUPERSEDED",
] as const;
export type PriceClaimState = (typeof PRICE_CLAIM_STATES)[number];

export const PRICE_CLAIM_EVENTS = [
  "START_SCORING",
  "SCORED_VERIFIED",
  "SCORED_EXCEEDS_VRP",
  "SCORED_INSUFFICIENT_EVIDENCE",
  "EVIDENCE_STALE",
  "EVIDENCE_REFRESHED",
  "APPEAL",
  "RESCORE",
  "ENFORCEMENT_APPLIED",
  "PENALTY_ELAPSED",
  "PRICE_CHANGED",
] as const;
export type PriceClaimEvent = (typeof PRICE_CLAIM_EVENTS)[number];

export const priceClaimMachine = defineMachine<PriceClaimState, PriceClaimEvent>({
  name: "PriceClaim",
  states: PRICE_CLAIM_STATES,
  events: PRICE_CLAIM_EVENTS,
  initial: "SUBMITTED",
  terminal: ["SUPERSEDED"],
  transitions: {
    SUBMITTED: { START_SCORING: { to: "SCORING" }, PRICE_CHANGED: { to: "SUPERSEDED" } },
    SCORING: {
      SCORED_VERIFIED: { to: "VERIFIED" },
      SCORED_EXCEEDS_VRP: { to: "CORRECTED" },
      SCORED_INSUFFICIENT_EVIDENCE: { to: "PLAIN_PRICE" },
      PRICE_CHANGED: { to: "SUPERSEDED" },
    },
    VERIFIED: {
      EVIDENCE_STALE: { to: "PLAIN_PRICE" },
      ENFORCEMENT_APPLIED: { to: "REVOKED" },
      RESCORE: { to: "SCORING" },
      PRICE_CHANGED: { to: "SUPERSEDED" },
    },
    CORRECTED: {
      APPEAL: { to: "APPEALED" },
      RESCORE: { to: "SCORING" },
      PRICE_CHANGED: { to: "SUPERSEDED" },
    },
    PLAIN_PRICE: {
      EVIDENCE_REFRESHED: { to: "SCORING" },
      APPEAL: { to: "APPEALED" },
      PRICE_CHANGED: { to: "SUPERSEDED" },
    },
    APPEALED: { RESCORE: { to: "SCORING" }, PRICE_CHANGED: { to: "SUPERSEDED" } },
    REVOKED: {
      PENALTY_ELAPSED: { to: "SCORING" },
      APPEAL: { to: "APPEALED" },
      PRICE_CHANGED: { to: "SUPERSEDED" },
    },
    SUPERSEDED: {},
  },
});
