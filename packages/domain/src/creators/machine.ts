import { defineMachine } from "../state-machine/machine";

export const COMMISSION_STATES = ["ACCRUING", "ACCRUED", "PAID", "CLAWED_BACK", "VOIDED"] as const;
export type CommissionState = (typeof COMMISSION_STATES)[number];

export const COMMISSION_EVENTS = ["ACCRUE", "PAY", "CLAWBACK_ALL", "VOID"] as const;
export type CommissionEvent = (typeof COMMISSION_EVENTS)[number];

/**
 * ACCRUING: computed but held (monthly cap, suspended creator); no ledger entry yet.
 * ACCRUED: posted to creator_payable. PAID: included in a settled payout.
 * CLAWED_BACK: fully reversed (a partial clawback keeps the state and only moves `clawed_back`).
 * VOIDED: never earned (self purchase, fraud cluster); no money moved, logged silently.
 */
export const commissionMachine = defineMachine<CommissionState, CommissionEvent>({
  name: "Commission",
  states: COMMISSION_STATES,
  events: COMMISSION_EVENTS,
  initial: "ACCRUING",
  terminal: ["CLAWED_BACK", "VOIDED"],
  transitions: {
    ACCRUING: { ACCRUE: { to: "ACCRUED" }, VOID: { to: "VOIDED" } },
    ACCRUED: { PAY: { to: "PAID" }, CLAWBACK_ALL: { to: "CLAWED_BACK" } },
    PAID: { CLAWBACK_ALL: { to: "CLAWED_BACK" } },
    CLAWED_BACK: {},
    VOIDED: {},
  },
});

export function transitionCommission(from: CommissionState, event: CommissionEvent): CommissionState {
  return commissionMachine.transition(from, event);
}
