import { defineMachine, guard, kycMachine, type KycContext, type KycState } from "../state-machine";
import type { ApplicationStatus } from "./types";

export const APPLICATION_EVENTS = [
  "SUBMIT",
  "START_CHECKS",
  "FINISH_CHECKS",
  "APPROVE",
  "REQUEST_INFO",
  "REJECT",
  "RESUBMIT",
  "WITHDRAW",
  "APPEAL",
  "SUSPEND",
  "REINSTATE",
] as const;
export type ApplicationEvent = (typeof APPLICATION_EVENTS)[number];

export interface ApplicationContext extends KycContext {
  /** Every requested item is satisfied (needed to RESUBMIT). */
  readonly requestedItemsSatisfied: boolean;
  /** The one appeal is unused and the 30 day window is open (needed to APPEAL). */
  readonly appealOpen: boolean;
}

/** APPROVE reuses the KYC approval guard instead of restating it. */
const approvable = guard<ApplicationContext>("kycApprovable", (c) => kycMachine.can("AUTO_CHECKS", "APPROVE", c));
const satisfied = guard<ApplicationContext>("requestedItemsSatisfied", (c) => c.requestedItemsSatisfied);
const appealOpen = guard<ApplicationContext>("appealOpen", (c) => c.appealOpen);

export const APPLICATION_STATE_LIST: readonly ApplicationStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "AUTO_CHECKS",
  "IN_REVIEW",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "WITHDRAWN",
];

/**
 * Application machine layered over kycMachine. IN_REVIEW is a sub-state of AUTO_CHECKS (checks done,
 * human review pending). WITHDRAWN and APPEAL are application-only edges: the KYC record is not
 * touched by them (see APP_ONLY_EVENTS and toKycState).
 */
export const applicationMachine = defineMachine<ApplicationStatus, ApplicationEvent, ApplicationContext>({
  name: "BrandApplication",
  states: APPLICATION_STATE_LIST,
  events: APPLICATION_EVENTS,
  initial: "DRAFT",
  terminal: ["WITHDRAWN"],
  transitions: {
    DRAFT: { SUBMIT: { to: "SUBMITTED" }, WITHDRAW: { to: "WITHDRAWN" } },
    SUBMITTED: { START_CHECKS: { to: "AUTO_CHECKS" }, WITHDRAW: { to: "WITHDRAWN" } },
    AUTO_CHECKS: {
      FINISH_CHECKS: { to: "IN_REVIEW" },
      REQUEST_INFO: { to: "NEEDS_INFO" },
      REJECT: { to: "REJECTED" },
      WITHDRAW: { to: "WITHDRAWN" },
    },
    IN_REVIEW: {
      APPROVE: { to: "APPROVED", guard: approvable },
      REQUEST_INFO: { to: "NEEDS_INFO" },
      REJECT: { to: "REJECTED" },
      WITHDRAW: { to: "WITHDRAWN" },
    },
    NEEDS_INFO: {
      RESUBMIT: { to: "SUBMITTED", guard: satisfied },
      REJECT: { to: "REJECTED" },
      WITHDRAW: { to: "WITHDRAWN" },
    },
    REJECTED: { APPEAL: { to: "IN_REVIEW", guard: appealOpen } },
    APPROVED: { SUSPEND: { to: "SUSPENDED" } },
    SUSPENDED: { REINSTATE: { to: "APPROVED" } },
    WITHDRAWN: {},
  },
});

/** Events that exist only on the application, never on the KYC record. */
export const APP_ONLY_EVENTS: readonly ApplicationEvent[] = ["WITHDRAW", "APPEAL", "FINISH_CHECKS"];

export function toKycState(s: ApplicationStatus): KycState {
  if (s === "IN_REVIEW") return "AUTO_CHECKS";
  if (s === "WITHDRAWN") return "DRAFT";
  return s;
}

export interface ApplicationTransition {
  readonly from: ApplicationStatus;
  readonly to: ApplicationStatus;
  readonly event: ApplicationEvent;
  readonly kycFrom: KycState;
  readonly kycTo: KycState;
}

/** Throws InvalidTransitionError or GuardRejectedError (typed, from the shared machine errors). */
export function applyApplicationEvent(
  from: ApplicationStatus,
  event: ApplicationEvent,
  ctx: ApplicationContext,
): ApplicationTransition {
  const to = applicationMachine.transition(from, event, ctx);
  return { from, to, event, kycFrom: toKycState(from), kycTo: toKycState(to) };
}

export const DEFAULT_CONTEXT: ApplicationContext = {
  documentsValid: false,
  sanctionsClear: false,
  signatoryAdult21: false,
  requestedItemsSatisfied: false,
  appealOpen: false,
};
