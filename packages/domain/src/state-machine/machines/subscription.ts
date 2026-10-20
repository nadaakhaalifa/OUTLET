import { defineMachine } from "../machine";

export const SUBSCRIPTION_STATES = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "PAUSED",
  "CANCELLED_AT_PERIOD_END",
  "EXPIRED",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export const SUBSCRIPTION_EVENTS = [
  "TRIAL_CONVERTED",
  "TRIAL_ENDED_UNPAID",
  "CHARGE_FAILED",
  "CHARGE_SUCCEEDED",
  "GRACE_ELAPSED",
  "PAUSE",
  "RESUME",
  "CANCEL",
  "REACTIVATE",
  "PERIOD_ENDED",
  "CANCEL_WITH_REFUND",
] as const;
export type SubscriptionEvent = (typeof SUBSCRIPTION_EVENTS)[number];

export const subscriptionMachine = defineMachine<SubscriptionState, SubscriptionEvent>({
  name: "Subscription",
  states: SUBSCRIPTION_STATES,
  events: SUBSCRIPTION_EVENTS,
  initial: "TRIALING",
  terminal: ["EXPIRED"],
  transitions: {
    TRIALING: {
      TRIAL_CONVERTED: { to: "ACTIVE" },
      TRIAL_ENDED_UNPAID: { to: "EXPIRED" },
      CANCEL: { to: "CANCELLED_AT_PERIOD_END" },
    },
    ACTIVE: {
      CHARGE_FAILED: { to: "PAST_DUE" },
      PAUSE: { to: "PAUSED" },
      CANCEL: { to: "CANCELLED_AT_PERIOD_END" },
      CANCEL_WITH_REFUND: { to: "EXPIRED" },
    },
    PAST_DUE: {
      CHARGE_SUCCEEDED: { to: "ACTIVE" },
      GRACE_ELAPSED: { to: "EXPIRED" },
      CANCEL: { to: "CANCELLED_AT_PERIOD_END" },
    },
    PAUSED: { RESUME: { to: "ACTIVE" } },
    CANCELLED_AT_PERIOD_END: {
      PERIOD_ENDED: { to: "EXPIRED" },
      REACTIVATE: { to: "ACTIVE" },
    },
    EXPIRED: {},
  },
});
