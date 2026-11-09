import { SellerAccountsError } from "./errors.js";

export const KYC_STATES = ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED"] as const;
export type KycState = (typeof KYC_STATES)[number];

export const KYC_EVENTS = ["submit", "start_checks", "approve", "request_info", "reject", "suspend", "reinstate"] as const;
export type KycEvent = (typeof KYC_EVENTS)[number];

/**
 * Master prompt 19: DRAFT -> SUBMITTED -> AUTO_CHECKS -> (APPROVED | NEEDS_INFO | REJECTED), APPROVED -> SUSPENDED.
 * NEEDS_INFO -> SUBMITTED is the resubmission loop; an admin may also reject a case that is waiting for information.
 * REJECTED is terminal. SUSPENDED -> APPROVED is the reinstatement (a human decision under store.reinstate, dual approval at the admin layer).
 */
const TABLE: Readonly<Record<KycState, Readonly<Partial<Record<KycEvent, KycState>>>>> = {
  DRAFT: { submit: "SUBMITTED" },
  SUBMITTED: { start_checks: "AUTO_CHECKS" },
  AUTO_CHECKS: { approve: "APPROVED", request_info: "NEEDS_INFO", reject: "REJECTED" },
  NEEDS_INFO: { submit: "SUBMITTED", reject: "REJECTED" },
  APPROVED: { suspend: "SUSPENDED" },
  REJECTED: {},
  SUSPENDED: { reinstate: "APPROVED" },
};

export class KycTransitionError extends SellerAccountsError {
  constructor(
    readonly from: KycState,
    readonly event: KycEvent,
  ) {
    super("invalid_transition", `KYC case in ${from} cannot ${event}`);
    this.name = "KycTransitionError";
  }
}

/** Pure transition; throws KycTransitionError for anything not in the table. */
export const nextKycState = (from: KycState, event: KycEvent): KycState => {
  const to = TABLE[from][event];
  if (to === undefined) throw new KycTransitionError(from, event);
  return to;
};

export const canKyc = (from: KycState, event: KycEvent): boolean => TABLE[from][event] !== undefined;

/** The applicant may change documents, bank details and legal identity only in these states. */
export const isKycEditable = (state: KycState): boolean => state === "DRAFT" || state === "NEEDS_INFO";

/** States an administrator can still act on (ops queue). */
export const isKycOpen = (state: KycState): boolean => state === "SUBMITTED" || state === "AUTO_CHECKS" || state === "NEEDS_INFO";
