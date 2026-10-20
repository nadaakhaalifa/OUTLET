import { defineMachine, guard } from "../machine";

export const KYC_STATES = [
  "DRAFT",
  "SUBMITTED",
  "AUTO_CHECKS",
  "NEEDS_INFO",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "TERMINATED",
] as const;
export type KycState = (typeof KYC_STATES)[number];

export const KYC_EVENTS = [
  "SUBMIT",
  "START_CHECKS",
  "APPROVE",
  "REQUEST_INFO",
  "REJECT",
  "RESUBMIT",
  "SUSPEND",
  "REINSTATE",
  "TERMINATE",
] as const;
export type KycEvent = (typeof KYC_EVENTS)[number];

export interface KycContext {
  readonly documentsValid: boolean;
  readonly sanctionsClear: boolean;
  /** Signatory is 21+ (spec 19). */
  readonly signatoryAdult21: boolean;
}

const approvable = guard<KycContext>(
  "documentsValidSanctionsClearSignatory21",
  (c) => c.documentsValid && c.sanctionsClear && c.signatoryAdult21,
);

export const kycMachine = defineMachine<KycState, KycEvent, KycContext>({
  name: "KYC",
  states: KYC_STATES,
  events: KYC_EVENTS,
  initial: "DRAFT",
  terminal: ["REJECTED", "TERMINATED"],
  transitions: {
    DRAFT: { SUBMIT: { to: "SUBMITTED" } },
    SUBMITTED: { START_CHECKS: { to: "AUTO_CHECKS" } },
    AUTO_CHECKS: {
      APPROVE: { to: "APPROVED", guard: approvable },
      REQUEST_INFO: { to: "NEEDS_INFO" },
      REJECT: { to: "REJECTED" },
    },
    NEEDS_INFO: { RESUBMIT: { to: "SUBMITTED" }, REJECT: { to: "REJECTED" } },
    APPROVED: { SUSPEND: { to: "SUSPENDED" } },
    SUSPENDED: { REINSTATE: { to: "APPROVED" }, TERMINATE: { to: "TERMINATED" } },
    REJECTED: {},
    TERMINATED: {},
  },
});
