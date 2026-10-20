import {
  priceDropAutoBuyMachine,
  type AutoBuyContext,
  type AutoBuyEvent,
  type AutoBuyState,
} from "../state-machine";

export type { AutoBuyContext, AutoBuyEvent, AutoBuyState };

/** States an attempt can be persisted in (the machine's ARMED and EXPIRED belong to the rule). */
export const ATTEMPT_STATES = [
  "TRIGGERED",
  "SKIPPED",
  "NOTIFIED",
  "CHARGING",
  "REQUIRES_USER_ACTION",
  "MANUAL_REVIEW",
  "PURCHASED",
  "CANCELLED_BY_USER",
  "FAILED",
  "DISARMED",
] as const satisfies readonly AutoBuyState[];
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/** States in which the attempt still holds a stock reservation or a pending charge. */
export const OPEN_ATTEMPT_STATES: readonly AttemptState[] = ["TRIGGERED", "NOTIFIED", "CHARGING", "REQUIRES_USER_ACTION", "MANUAL_REVIEW"];

export const isAttemptState = (v: string): v is AttemptState => (ATTEMPT_STATES as readonly string[]).includes(v);

const NEUTRAL: AutoBuyContext = {
  verifiedPriceAtOrBelowTarget: true,
  plusActive: true,
  withinBudget: true,
  eligiblePaymentMethod: true,
  cancelWindowElapsed: false,
};

/** Pure transition for an attempt. Throws the machine's typed error on an invalid move. */
export function nextAttemptState(state: AttemptState, event: AutoBuyEvent, ctx: Partial<AutoBuyContext> = {}): AttemptState {
  const to = priceDropAutoBuyMachine.transition(state, event, { ...NEUTRAL, ...ctx });
  if (!isAttemptState(to)) throw new Error(`attempt reached non-attempt state ${to}`);
  return to;
}

/** True when the shopper may still cancel: only before the charge claim (cancel wins before it). */
export const canCancelAttempt = (state: AttemptState): boolean => priceDropAutoBuyMachine.can(state, "USER_CANCELLED", NEUTRAL);
