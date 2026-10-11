import { defineMachine, guard } from "../machine";

export const AUTO_BUY_STATES = [
  "ARMED",
  "TRIGGERED",
  "SKIPPED",
  "NOTIFIED",
  "CHARGING",
  "REQUIRES_USER_ACTION",
  "PURCHASED",
  "CANCELLED_BY_USER",
  "FAILED",
  "DISARMED",
  "EXPIRED",
] as const;
export type AutoBuyState = (typeof AUTO_BUY_STATES)[number];

export const AUTO_BUY_EVENTS = [
  "PRICE_AT_TARGET",
  "CHECKS_PASSED",
  "CHECKS_FAILED",
  "REARM",
  "CANCEL_WINDOW_ELAPSED",
  "USER_CANCELLED",
  "CHARGE_SUCCEEDED",
  "CHARGE_FAILED",
  "SCA_REQUIRED",
  "SCA_COMPLETED",
  "SCA_ABANDONED",
  "DISARM",
  "OPT_IN_EXPIRED",
] as const;
export type AutoBuyEvent = (typeof AUTO_BUY_EVENTS)[number];

export interface AutoBuyContext {
  /** Verified price (not a plain price claim) is at or below the shopper's target. */
  readonly verifiedPriceAtOrBelowTarget: boolean;
  readonly plusActive: boolean;
  readonly withinBudget: boolean;
  /** Saved PSP token present and the method is not BNPL or COD. */
  readonly eligiblePaymentMethod: boolean;
  /** 15-minute cancel window after the push has elapsed. */
  readonly cancelWindowElapsed: boolean;
}

export const AUTO_BUY_CANCEL_WINDOW_MINUTES = 15;

const atTarget = guard<AutoBuyContext>("verifiedPriceAtOrBelowTarget", (c) => c.verifiedPriceAtOrBelowTarget);
const allChecks = (c: AutoBuyContext): boolean => c.plusActive && c.withinBudget && c.eligiblePaymentMethod;
const checksPass = guard<AutoBuyContext>("plusActiveWithinBudgetEligibleMethod", allChecks);
const checksFail = guard<AutoBuyContext>("someCheckFailed", (c) => !allChecks(c));
const windowElapsed = guard<AutoBuyContext>("cancelWindowElapsed", (c) => c.cancelWindowElapsed);

export const priceDropAutoBuyMachine = defineMachine<AutoBuyState, AutoBuyEvent, AutoBuyContext>({
  name: "PriceDropAutoBuy",
  states: AUTO_BUY_STATES,
  events: AUTO_BUY_EVENTS,
  initial: "ARMED",
  terminal: ["PURCHASED", "CANCELLED_BY_USER", "FAILED", "DISARMED", "EXPIRED"],
  transitions: {
    ARMED: {
      PRICE_AT_TARGET: { to: "TRIGGERED", guard: atTarget },
      DISARM: { to: "DISARMED" },
      OPT_IN_EXPIRED: { to: "EXPIRED" },
    },
    TRIGGERED: {
      CHECKS_PASSED: { to: "NOTIFIED", guard: checksPass },
      CHECKS_FAILED: { to: "SKIPPED", guard: checksFail },
      DISARM: { to: "DISARMED" },
    },
    SKIPPED: { REARM: { to: "ARMED" }, DISARM: { to: "DISARMED" } },
    NOTIFIED: {
      CANCEL_WINDOW_ELAPSED: { to: "CHARGING", guard: windowElapsed },
      USER_CANCELLED: { to: "CANCELLED_BY_USER" },
      DISARM: { to: "DISARMED" },
    },
    CHARGING: {
      CHARGE_SUCCEEDED: { to: "PURCHASED" },
      CHARGE_FAILED: { to: "FAILED" },
      SCA_REQUIRED: { to: "REQUIRES_USER_ACTION" },
    },
    REQUIRES_USER_ACTION: {
      SCA_COMPLETED: { to: "CHARGING" },
      SCA_ABANDONED: { to: "FAILED" },
    },
    PURCHASED: {},
    CANCELLED_BY_USER: {},
    FAILED: {},
    DISARMED: {},
    EXPIRED: {},
  },
});
