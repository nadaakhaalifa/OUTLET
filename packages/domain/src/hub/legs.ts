import { InvalidLegTransitionError, type LegState } from "./types";

/** Transition table. DISPATCHED, CANCELLED and EXCEPTION are terminal. */
export const LEG_TRANSITIONS: Readonly<Record<LegState, readonly LegState[]>> = {
  AT_HUB_EXPECTED: ["RECEIVED", "EXCEPTION", "CANCELLED"],
  RECEIVED: ["CONSOLIDATED", "CANCELLED"],
  CONSOLIDATED: ["DISPATCHED"],
  DISPATCHED: [],
  CANCELLED: [],
  EXCEPTION: [],
};

export const canMoveLeg = (from: LegState, to: LegState): boolean => LEG_TRANSITIONS[from].includes(to);

export function moveLeg(from: LegState, to: LegState): LegState {
  if (!canMoveLeg(from, to)) throw new InvalidLegTransitionError(from, to);
  return to;
}

export const isTerminalLeg = (s: LegState): boolean => LEG_TRANSITIONS[s].length === 0;

/** A leg is handed to the hub late when still expected after the SLA. */
export const handoffOverdue = (state: LegState, paidAtMs: number, nowMs: number, slaMs: number): boolean =>
  state === "AT_HUB_EXPECTED" && nowMs > paidAtMs + slaMs;
