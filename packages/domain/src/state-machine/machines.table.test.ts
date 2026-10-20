import { beforeAll, describe, expect, it, vi } from "vitest";
import { MachineDefinitionError } from "./errors";
import { defineMachine, guard, type MachineDefinition } from "./machine";
import type { StateMachineKey } from "./registry";

// NOTE: machine modules are imported dynamically inside tests (never at top level). A mutant that
// breaks a machine definition throws at import time; with a static import that surfaces as a
// collection error with zero tests, which StrykerJS reports as "Survived". Importing inside a test
// turns the same crash into a failing test, i.e. a Killed mutant.
const loadRegistry = async (): Promise<Record<StateMachineKey, unknown>> => {
  vi.resetModules();
  const mod = await import("./registry");
  return mod.stateMachines as unknown as Record<StateMachineKey, unknown>;
};

/**
 * Mutation-killing characterization of every machine of spec A2.6. The tables below are an
 * independent, explicit copy of the transition tables: any added, removed or retargeted transition
 * (or guard) fails here. Guard behaviour is checked against an oracle keyed by guard name.
 */

interface Spec {
  readonly name: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly events: readonly string[];
  readonly terminal: readonly string[];
  readonly edges: readonly (readonly [from: string, event: string, to: string, guard: string | null])[];
}
const SPECS: Record<StateMachineKey, Spec> = {
  orderGroup: {
    name: "OrderGroup",
    initial: "CREATED",
    states: ["CREATED", "RESERVED", "PAYMENT_PENDING", "PAID", "CONFIRMED_COD", "FULFILLING", "COMPLETED", "EXPIRED", "FAILED", "CANCELLED"],
    events: ["RESERVE", "STOCK_UNAVAILABLE", "PAYMENT_INTENT_CREATED", "COD_CONFIRMED", "PAYMENT_SUCCEEDED", "PAYMENT_FAILED", "RESERVATION_EXPIRED", "PAYMENT_WINDOW_ELAPSED", "LATE_PAYMENT_CLAIMED", "LATE_PAYMENT_REFUND", "FULFILMENT_STARTED", "ALL_SELLER_ORDERS_DONE", "ALL_SELLER_ORDERS_CANCELLED", "CANCEL"],
    terminal: ["COMPLETED", "FAILED", "CANCELLED"],
    edges: [
      ["CREATED", "RESERVE", "RESERVED", null],
      ["CREATED", "STOCK_UNAVAILABLE", "FAILED", null],
      ["CREATED", "CANCEL", "CANCELLED", null],
      ["RESERVED", "PAYMENT_INTENT_CREATED", "PAYMENT_PENDING", null],
      ["RESERVED", "COD_CONFIRMED", "CONFIRMED_COD", null],
      ["RESERVED", "RESERVATION_EXPIRED", "EXPIRED", null],
      ["RESERVED", "CANCEL", "CANCELLED", null],
      ["PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "PAID", null],
      ["PAYMENT_PENDING", "PAYMENT_FAILED", "FAILED", null],
      ["PAYMENT_PENDING", "PAYMENT_WINDOW_ELAPSED", "EXPIRED", null],
      ["PAYMENT_PENDING", "CANCEL", "CANCELLED", null],
      ["PAID", "FULFILMENT_STARTED", "FULFILLING", null],
      ["PAID", "ALL_SELLER_ORDERS_CANCELLED", "CANCELLED", null],
      ["CONFIRMED_COD", "FULFILMENT_STARTED", "FULFILLING", null],
      ["CONFIRMED_COD", "ALL_SELLER_ORDERS_CANCELLED", "CANCELLED", null],
      ["FULFILLING", "ALL_SELLER_ORDERS_DONE", "COMPLETED", null],
      ["FULFILLING", "ALL_SELLER_ORDERS_CANCELLED", "CANCELLED", null],
      ["EXPIRED", "LATE_PAYMENT_CLAIMED", "PAID", "stockAvailable"],
      ["EXPIRED", "LATE_PAYMENT_REFUND", "CANCELLED", null],
    ],
  },
  sellerOrder: {
    name: "SellerOrder",
    initial: "PENDING_PAYMENT",
    states: ["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CLOSED", "RETURN_REQUESTED", "RETURN_PICKUP_SCHEDULED", "RETURN_IN_TRANSIT", "RETURN_RECEIVED", "RETURN_INSPECTED", "REFUNDED", "RETURN_REJECTED", "CANCELLED", "REJECTED_BY_SELLER", "DELIVERY_FAILED", "RTO", "RETURNED_TO_SELLER", "DISPUTED"],
    events: ["PAYMENT_SUCCEEDED", "COD_CONFIRMED", "PAYMENT_FAILED", "SELLER_ACCEPT", "SELLER_REJECT", "PACK", "SHIP", "OUT_FOR_DELIVERY", "DELIVER", "DELIVERY_FAIL", "RETRY_DELIVERY", "RETURN_TO_SELLER", "RTO_RECEIVED", "CANCEL", "REQUEST_RETURN", "CANCEL_RETURN", "SCHEDULE_PICKUP", "PICKED_UP", "RECEIVE_RETURN", "INSPECT_COMPLETE", "AUTO_APPROVE", "REJECT_RETURN", "REFUND_COMPLETED", "OPEN_DISPUTE", "RESOLVE_FOR_SHOPPER", "RESOLVE_FOR_SELLER", "CLOSE"],
    terminal: ["CLOSED", "REFUNDED", "CANCELLED", "REJECTED_BY_SELLER"],
    edges: [
      ["PENDING_PAYMENT", "PAYMENT_SUCCEEDED", "PAID", null],
      ["PENDING_PAYMENT", "COD_CONFIRMED", "CONFIRMED_COD", null],
      ["PENDING_PAYMENT", "PAYMENT_FAILED", "CANCELLED", null],
      ["PENDING_PAYMENT", "CANCEL", "CANCELLED", null],
      ["PAID", "SELLER_ACCEPT", "ACCEPTED", null],
      ["PAID", "SELLER_REJECT", "REJECTED_BY_SELLER", null],
      ["PAID", "CANCEL", "CANCELLED", null],
      ["CONFIRMED_COD", "SELLER_ACCEPT", "ACCEPTED", null],
      ["CONFIRMED_COD", "SELLER_REJECT", "REJECTED_BY_SELLER", null],
      ["CONFIRMED_COD", "CANCEL", "CANCELLED", null],
      ["ACCEPTED", "SELLER_REJECT", "REJECTED_BY_SELLER", null],
      ["ACCEPTED", "PACK", "PACKED", null],
      ["ACCEPTED", "CANCEL", "CANCELLED", null],
      ["PACKED", "SHIP", "SHIPPED", null],
      ["PACKED", "CANCEL", "CANCELLED", null],
      ["SHIPPED", "OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY", null],
      ["SHIPPED", "DELIVERY_FAIL", "DELIVERY_FAILED", null],
      ["OUT_FOR_DELIVERY", "DELIVER", "DELIVERED", null],
      ["OUT_FOR_DELIVERY", "DELIVERY_FAIL", "DELIVERY_FAILED", null],
      ["DELIVERED", "REQUEST_RETURN", "RETURN_REQUESTED", null],
      ["DELIVERED", "OPEN_DISPUTE", "DISPUTED", null],
      ["DELIVERED", "CLOSE", "CLOSED", "returnWindowElapsed"],
      ["RETURN_REQUESTED", "CANCEL_RETURN", "DELIVERED", null],
      ["RETURN_REQUESTED", "SCHEDULE_PICKUP", "RETURN_PICKUP_SCHEDULED", null],
      ["RETURN_PICKUP_SCHEDULED", "CANCEL_RETURN", "DELIVERED", null],
      ["RETURN_PICKUP_SCHEDULED", "PICKED_UP", "RETURN_IN_TRANSIT", null],
      ["RETURN_IN_TRANSIT", "RECEIVE_RETURN", "RETURN_RECEIVED", null],
      ["RETURN_RECEIVED", "INSPECT_COMPLETE", "RETURN_INSPECTED", null],
      ["RETURN_RECEIVED", "AUTO_APPROVE", "RETURN_INSPECTED", null],
      ["RETURN_INSPECTED", "REJECT_RETURN", "RETURN_REJECTED", null],
      ["RETURN_INSPECTED", "REFUND_COMPLETED", "REFUNDED", null],
      ["RETURN_REJECTED", "OPEN_DISPUTE", "DISPUTED", null],
      ["RETURN_REJECTED", "CLOSE", "CLOSED", null],
      ["DELIVERY_FAILED", "RETRY_DELIVERY", "OUT_FOR_DELIVERY", "deliveryAttemptsLeft"],
      ["DELIVERY_FAILED", "RETURN_TO_SELLER", "RTO", "deliveryAttemptsExhausted"],
      ["RTO", "RTO_RECEIVED", "RETURNED_TO_SELLER", null],
      ["RETURNED_TO_SELLER", "REFUND_COMPLETED", "REFUNDED", null],
      ["RETURNED_TO_SELLER", "CLOSE", "CLOSED", null],
      ["DISPUTED", "RESOLVE_FOR_SHOPPER", "REFUNDED", null],
      ["DISPUTED", "RESOLVE_FOR_SELLER", "CLOSED", null],
    ],
  },
  shipment: {
    name: "Shipment",
    initial: "LABEL_PENDING",
    states: ["LABEL_PENDING", "LABEL_CREATED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERY_ATTEMPT_FAILED", "DELIVERED", "COD_REMITTED", "RECONCILED", "RTO_INITIATED", "RETURNED_TO_SELLER", "CANCELLED", "LOST"],
    events: ["CREATE_LABEL", "PICK_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVER", "ATTEMPT_FAILED", "RETRY", "CUSTOMER_REFUSED", "INITIATE_RTO", "RTO_DELIVERED", "REMIT_COD", "RECONCILE", "CANCEL", "MARK_LOST"],
    terminal: ["RECONCILED", "RETURNED_TO_SELLER", "CANCELLED", "LOST"],
    edges: [
      ["LABEL_PENDING", "CREATE_LABEL", "LABEL_CREATED", null],
      ["LABEL_PENDING", "CANCEL", "CANCELLED", null],
      ["LABEL_CREATED", "PICK_UP", "PICKED_UP", null],
      ["LABEL_CREATED", "CANCEL", "CANCELLED", null],
      ["PICKED_UP", "IN_TRANSIT", "IN_TRANSIT", null],
      ["PICKED_UP", "MARK_LOST", "LOST", null],
      ["IN_TRANSIT", "OUT_FOR_DELIVERY", "OUT_FOR_DELIVERY", null],
      ["IN_TRANSIT", "MARK_LOST", "LOST", null],
      ["OUT_FOR_DELIVERY", "DELIVER", "DELIVERED", null],
      ["OUT_FOR_DELIVERY", "ATTEMPT_FAILED", "DELIVERY_ATTEMPT_FAILED", null],
      ["OUT_FOR_DELIVERY", "CUSTOMER_REFUSED", "RTO_INITIATED", null],
      ["OUT_FOR_DELIVERY", "MARK_LOST", "LOST", null],
      ["DELIVERY_ATTEMPT_FAILED", "RETRY", "OUT_FOR_DELIVERY", "attemptsLeft"],
      ["DELIVERY_ATTEMPT_FAILED", "INITIATE_RTO", "RTO_INITIATED", "attemptsExhausted"],
      ["DELIVERED", "REMIT_COD", "COD_REMITTED", "isCod"],
      ["DELIVERED", "RECONCILE", "RECONCILED", "isNotCod"],
      ["COD_REMITTED", "RECONCILE", "RECONCILED", null],
      ["RTO_INITIATED", "RTO_DELIVERED", "RETURNED_TO_SELLER", null],
      ["RTO_INITIATED", "MARK_LOST", "LOST", null],
    ],
  },
  return: {
    name: "Return",
    initial: "REQUESTED",
    states: ["REQUESTED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "APPROVED", "REJECTED", "DISPUTED", "REFUNDED", "EXCHANGED", "CLOSED", "CANCELLED"],
    events: ["SCHEDULE_PICKUP", "PICKUP_FAILED", "PICK_UP", "RECEIVE", "APPROVE", "AUTO_APPROVE", "REJECT", "OPEN_DISPUTE", "UPHOLD_FOR_SHOPPER", "UPHOLD_FOR_SELLER", "DISPUTE_WINDOW_ELAPSED", "COMPLETE_REFUND", "SHIP_EXCHANGE", "CANCEL"],
    terminal: ["REFUNDED", "EXCHANGED", "CLOSED", "CANCELLED"],
    edges: [
      ["REQUESTED", "SCHEDULE_PICKUP", "PICKUP_SCHEDULED", null],
      ["REQUESTED", "CANCEL", "CANCELLED", null],
      ["PICKUP_SCHEDULED", "PICKUP_FAILED", "REQUESTED", null],
      ["PICKUP_SCHEDULED", "PICK_UP", "IN_TRANSIT", null],
      ["PICKUP_SCHEDULED", "CANCEL", "CANCELLED", null],
      ["IN_TRANSIT", "RECEIVE", "RECEIVED", null],
      ["RECEIVED", "APPROVE", "APPROVED", null],
      ["RECEIVED", "AUTO_APPROVE", "APPROVED", "inspectionSlaElapsed"],
      ["RECEIVED", "REJECT", "REJECTED", "rejectionPhotosAttached"],
      ["APPROVED", "COMPLETE_REFUND", "REFUNDED", null],
      ["APPROVED", "SHIP_EXCHANGE", "EXCHANGED", null],
      ["REJECTED", "OPEN_DISPUTE", "DISPUTED", null],
      ["REJECTED", "DISPUTE_WINDOW_ELAPSED", "CLOSED", null],
      ["DISPUTED", "UPHOLD_FOR_SHOPPER", "APPROVED", null],
      ["DISPUTED", "UPHOLD_FOR_SELLER", "CLOSED", null],
    ],
  },
  refund: {
    name: "Refund",
    initial: "REQUESTED",
    states: ["REQUESTED", "LEDGER_POSTED", "SUBMITTED", "COMPLETED", "FAILED", "MANUAL_REVIEW", "CANCELLED"],
    events: ["POST_LEDGER", "CREDIT_ISSUED", "SUBMIT_TO_PSP", "PSP_CONFIRMED", "PSP_REJECTED", "RETRY", "ESCALATE", "MANUAL_TRANSFER_CONFIRMED", "CANCEL"],
    terminal: ["COMPLETED", "CANCELLED"],
    edges: [
      ["REQUESTED", "POST_LEDGER", "LEDGER_POSTED", null],
      ["REQUESTED", "CANCEL", "CANCELLED", null],
      ["LEDGER_POSTED", "CREDIT_ISSUED", "COMPLETED", null],
      ["LEDGER_POSTED", "SUBMIT_TO_PSP", "SUBMITTED", null],
      ["SUBMITTED", "PSP_CONFIRMED", "COMPLETED", null],
      ["SUBMITTED", "PSP_REJECTED", "FAILED", null],
      ["FAILED", "RETRY", "SUBMITTED", "attemptsBelowMax"],
      ["FAILED", "ESCALATE", "MANUAL_REVIEW", "attemptsAtMax"],
      ["MANUAL_REVIEW", "RETRY", "SUBMITTED", null],
      ["MANUAL_REVIEW", "MANUAL_TRANSFER_CONFIRMED", "COMPLETED", null],
    ],
  },
  payout: {
    name: "Payout",
    initial: "SCHEDULED",
    states: ["SCHEDULED", "ON_HOLD", "APPROVED", "SENT", "SETTLED", "FAILED", "CANCELLED"],
    events: ["RISK_HOLD", "APPROVE", "SEND", "BANK_CONFIRMED", "BANK_REJECTED", "RESCHEDULE", "CANCEL"],
    terminal: ["SETTLED", "CANCELLED"],
    edges: [
      ["SCHEDULED", "RISK_HOLD", "ON_HOLD", null],
      ["SCHEDULED", "APPROVE", "APPROVED", "approvalRequirementMetAndNoOpenDispute"],
      ["SCHEDULED", "CANCEL", "CANCELLED", null],
      ["ON_HOLD", "APPROVE", "APPROVED", "approvalRequirementMetAndNoOpenDispute"],
      ["ON_HOLD", "CANCEL", "CANCELLED", null],
      ["APPROVED", "RISK_HOLD", "ON_HOLD", null],
      ["APPROVED", "SEND", "SENT", "ibanNameMatched"],
      ["APPROVED", "CANCEL", "CANCELLED", null],
      ["SENT", "BANK_CONFIRMED", "SETTLED", null],
      ["SENT", "BANK_REJECTED", "FAILED", null],
      ["FAILED", "RESCHEDULE", "SCHEDULED", null],
      ["FAILED", "CANCEL", "CANCELLED", null],
    ],
  },
  subscription: {
    name: "Subscription",
    initial: "TRIALING",
    states: ["TRIALING", "ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED_AT_PERIOD_END", "EXPIRED"],
    events: ["TRIAL_CONVERTED", "TRIAL_ENDED_UNPAID", "CHARGE_FAILED", "CHARGE_SUCCEEDED", "GRACE_ELAPSED", "PAUSE", "RESUME", "CANCEL", "REACTIVATE", "PERIOD_ENDED", "CANCEL_WITH_REFUND"],
    terminal: ["EXPIRED"],
    edges: [
      ["TRIALING", "TRIAL_CONVERTED", "ACTIVE", null],
      ["TRIALING", "TRIAL_ENDED_UNPAID", "EXPIRED", null],
      ["TRIALING", "CANCEL", "CANCELLED_AT_PERIOD_END", null],
      ["ACTIVE", "CHARGE_FAILED", "PAST_DUE", null],
      ["ACTIVE", "PAUSE", "PAUSED", null],
      ["ACTIVE", "CANCEL", "CANCELLED_AT_PERIOD_END", null],
      ["ACTIVE", "CANCEL_WITH_REFUND", "EXPIRED", null],
      ["PAST_DUE", "CHARGE_SUCCEEDED", "ACTIVE", null],
      ["PAST_DUE", "GRACE_ELAPSED", "EXPIRED", null],
      ["PAST_DUE", "CANCEL", "CANCELLED_AT_PERIOD_END", null],
      ["PAUSED", "RESUME", "ACTIVE", null],
      ["CANCELLED_AT_PERIOD_END", "REACTIVATE", "ACTIVE", null],
      ["CANCELLED_AT_PERIOD_END", "PERIOD_ENDED", "EXPIRED", null],
    ],
  },
  drop: {
    name: "Drop",
    initial: "DRAFT",
    states: ["DRAFT", "SCHEDULED", "EARLY_ACCESS", "LIVE", "SOLD_OUT", "ENDED", "ARCHIVED"],
    events: ["SCHEDULE", "OPEN_EARLY_ACCESS", "GO_LIVE", "STOCK_EXHAUSTED", "WINDOW_CLOSED", "ARCHIVE", "CANCEL"],
    terminal: ["ARCHIVED"],
    edges: [
      ["DRAFT", "SCHEDULE", "SCHEDULED", null],
      ["DRAFT", "CANCEL", "ARCHIVED", null],
      ["SCHEDULED", "OPEN_EARLY_ACCESS", "EARLY_ACCESS", null],
      ["SCHEDULED", "GO_LIVE", "LIVE", null],
      ["SCHEDULED", "CANCEL", "ARCHIVED", null],
      ["EARLY_ACCESS", "GO_LIVE", "LIVE", null],
      ["EARLY_ACCESS", "STOCK_EXHAUSTED", "SOLD_OUT", null],
      ["EARLY_ACCESS", "WINDOW_CLOSED", "ENDED", null],
      ["LIVE", "STOCK_EXHAUSTED", "SOLD_OUT", null],
      ["LIVE", "WINDOW_CLOSED", "ENDED", null],
      ["SOLD_OUT", "ARCHIVE", "ARCHIVED", null],
      ["ENDED", "ARCHIVE", "ARCHIVED", null],
    ],
  },
  priceClaim: {
    name: "PriceClaim",
    initial: "SUBMITTED",
    states: ["SUBMITTED", "SCORING", "VERIFIED", "CORRECTED", "PLAIN_PRICE", "APPEALED", "REVOKED", "SUPERSEDED"],
    events: ["START_SCORING", "SCORED_VERIFIED", "SCORED_EXCEEDS_VRP", "SCORED_INSUFFICIENT_EVIDENCE", "EVIDENCE_STALE", "EVIDENCE_REFRESHED", "APPEAL", "RESCORE", "ENFORCEMENT_APPLIED", "PENALTY_ELAPSED", "PRICE_CHANGED"],
    terminal: ["SUPERSEDED"],
    edges: [
      ["SUBMITTED", "START_SCORING", "SCORING", null],
      ["SUBMITTED", "PRICE_CHANGED", "SUPERSEDED", null],
      ["SCORING", "SCORED_VERIFIED", "VERIFIED", null],
      ["SCORING", "SCORED_EXCEEDS_VRP", "CORRECTED", null],
      ["SCORING", "SCORED_INSUFFICIENT_EVIDENCE", "PLAIN_PRICE", null],
      ["SCORING", "PRICE_CHANGED", "SUPERSEDED", null],
      ["VERIFIED", "EVIDENCE_STALE", "PLAIN_PRICE", null],
      ["VERIFIED", "RESCORE", "SCORING", null],
      ["VERIFIED", "ENFORCEMENT_APPLIED", "REVOKED", null],
      ["VERIFIED", "PRICE_CHANGED", "SUPERSEDED", null],
      ["CORRECTED", "APPEAL", "APPEALED", null],
      ["CORRECTED", "RESCORE", "SCORING", null],
      ["CORRECTED", "PRICE_CHANGED", "SUPERSEDED", null],
      ["PLAIN_PRICE", "EVIDENCE_REFRESHED", "SCORING", null],
      ["PLAIN_PRICE", "APPEAL", "APPEALED", null],
      ["PLAIN_PRICE", "PRICE_CHANGED", "SUPERSEDED", null],
      ["APPEALED", "RESCORE", "SCORING", null],
      ["APPEALED", "PRICE_CHANGED", "SUPERSEDED", null],
      ["REVOKED", "APPEAL", "APPEALED", null],
      ["REVOKED", "PENALTY_ELAPSED", "SCORING", null],
      ["REVOKED", "PRICE_CHANGED", "SUPERSEDED", null],
    ],
  },
  giftCard: {
    name: "GiftCard",
    initial: "CREATED",
    states: ["CREATED", "PENDING_PAYMENT", "POT_OPEN", "ISSUED", "DELIVERED", "REDEEMED", "EXPIRED", "VOIDED", "CANCELLED"],
    events: ["START_CHECKOUT", "OPEN_POT", "PAYMENT_SUCCEEDED", "PAYMENT_FAILED", "CLOSE_POT", "CANCEL_POT", "DELIVER", "REDEEM", "EXPIRE", "VOID"],
    terminal: ["REDEEMED", "EXPIRED", "VOIDED", "CANCELLED"],
    edges: [
      ["CREATED", "START_CHECKOUT", "PENDING_PAYMENT", null],
      ["CREATED", "OPEN_POT", "POT_OPEN", null],
      ["PENDING_PAYMENT", "PAYMENT_SUCCEEDED", "ISSUED", null],
      ["PENDING_PAYMENT", "PAYMENT_FAILED", "CANCELLED", null],
      ["POT_OPEN", "CLOSE_POT", "ISSUED", "potFunded"],
      ["POT_OPEN", "CANCEL_POT", "CANCELLED", null],
      ["ISSUED", "DELIVER", "DELIVERED", null],
      ["ISSUED", "REDEEM", "REDEEMED", "expiryNotReached"],
      ["ISSUED", "EXPIRE", "EXPIRED", "expiryReached"],
      ["ISSUED", "VOID", "VOIDED", null],
      ["DELIVERED", "REDEEM", "REDEEMED", "expiryNotReached"],
      ["DELIVERED", "EXPIRE", "EXPIRED", "expiryReached"],
      ["DELIVERED", "VOID", "VOIDED", null],
    ],
  },
  kyc: {
    name: "KYC",
    initial: "DRAFT",
    states: ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "NEEDS_INFO", "APPROVED", "REJECTED", "SUSPENDED", "TERMINATED"],
    events: ["SUBMIT", "START_CHECKS", "APPROVE", "REQUEST_INFO", "REJECT", "RESUBMIT", "SUSPEND", "REINSTATE", "TERMINATE"],
    terminal: ["REJECTED", "TERMINATED"],
    edges: [
      ["DRAFT", "SUBMIT", "SUBMITTED", null],
      ["SUBMITTED", "START_CHECKS", "AUTO_CHECKS", null],
      ["AUTO_CHECKS", "APPROVE", "APPROVED", "documentsValidSanctionsClearSignatory21"],
      ["AUTO_CHECKS", "REQUEST_INFO", "NEEDS_INFO", null],
      ["AUTO_CHECKS", "REJECT", "REJECTED", null],
      ["NEEDS_INFO", "REJECT", "REJECTED", null],
      ["NEEDS_INFO", "RESUBMIT", "SUBMITTED", null],
      ["APPROVED", "SUSPEND", "SUSPENDED", null],
      ["SUSPENDED", "REINSTATE", "APPROVED", null],
      ["SUSPENDED", "TERMINATE", "TERMINATED", null],
    ],
  },
  dispute: {
    name: "Dispute",
    initial: "OPEN",
    states: ["OPEN", "UNDER_REVIEW", "AWAITING_EVIDENCE", "ESCALATED", "RESOLVED_FOR_SHOPPER", "RESOLVED_FOR_SELLER", "WITHDRAWN", "CLOSED"],
    events: ["ASSIGN_REVIEWER", "REQUEST_EVIDENCE", "EVIDENCE_RECEIVED", "SLA_BREACHED", "RESOLVE_FOR_SHOPPER", "RESOLVE_FOR_SELLER", "WITHDRAW", "FINALISE"],
    terminal: ["WITHDRAWN", "CLOSED"],
    edges: [
      ["OPEN", "ASSIGN_REVIEWER", "UNDER_REVIEW", null],
      ["OPEN", "WITHDRAW", "WITHDRAWN", null],
      ["UNDER_REVIEW", "REQUEST_EVIDENCE", "AWAITING_EVIDENCE", null],
      ["UNDER_REVIEW", "SLA_BREACHED", "ESCALATED", null],
      ["UNDER_REVIEW", "RESOLVE_FOR_SHOPPER", "RESOLVED_FOR_SHOPPER", "decidedByHuman"],
      ["UNDER_REVIEW", "RESOLVE_FOR_SELLER", "RESOLVED_FOR_SELLER", "decidedByHuman"],
      ["UNDER_REVIEW", "WITHDRAW", "WITHDRAWN", null],
      ["AWAITING_EVIDENCE", "EVIDENCE_RECEIVED", "UNDER_REVIEW", null],
      ["AWAITING_EVIDENCE", "WITHDRAW", "WITHDRAWN", null],
      ["ESCALATED", "RESOLVE_FOR_SHOPPER", "RESOLVED_FOR_SHOPPER", "decidedByHuman"],
      ["ESCALATED", "RESOLVE_FOR_SELLER", "RESOLVED_FOR_SELLER", "decidedByHuman"],
      ["RESOLVED_FOR_SHOPPER", "FINALISE", "CLOSED", null],
      ["RESOLVED_FOR_SELLER", "FINALISE", "CLOSED", null],
    ],
  },
  priceDropAutoBuy: {
    name: "PriceDropAutoBuy",
    initial: "ARMED",
    states: ["ARMED", "TRIGGERED", "SKIPPED", "NOTIFIED", "CHARGING", "REQUIRES_USER_ACTION", "MANUAL_REVIEW", "PURCHASED", "CANCELLED_BY_USER", "FAILED", "DISARMED", "EXPIRED"],
    events: ["PRICE_AT_TARGET", "CHECKS_PASSED", "CHECKS_FAILED", "REARM", "CANCEL_WINDOW_ELAPSED", "USER_CANCELLED", "CHARGE_SUCCEEDED", "CHARGE_FAILED", "SCA_REQUIRED", "SCA_COMPLETED", "SCA_ABANDONED", "CHARGE_UNRESOLVED", "DISARM", "OPT_IN_EXPIRED"],
    terminal: ["PURCHASED", "CANCELLED_BY_USER", "FAILED", "DISARMED", "EXPIRED"],
    edges: [
      ["ARMED", "PRICE_AT_TARGET", "TRIGGERED", "verifiedPriceAtOrBelowTarget"],
      ["ARMED", "DISARM", "DISARMED", null],
      ["ARMED", "OPT_IN_EXPIRED", "EXPIRED", null],
      ["TRIGGERED", "CHECKS_PASSED", "NOTIFIED", "plusActiveWithinBudgetEligibleMethod"],
      ["TRIGGERED", "CHECKS_FAILED", "SKIPPED", "someCheckFailed"],
      ["TRIGGERED", "DISARM", "DISARMED", null],
      ["SKIPPED", "REARM", "ARMED", null],
      ["SKIPPED", "DISARM", "DISARMED", null],
      ["NOTIFIED", "CHECKS_FAILED", "SKIPPED", "someCheckFailed"],
      ["NOTIFIED", "CANCEL_WINDOW_ELAPSED", "CHARGING", "cancelWindowElapsed"],
      ["NOTIFIED", "USER_CANCELLED", "CANCELLED_BY_USER", null],
      ["NOTIFIED", "DISARM", "DISARMED", null],
      ["CHARGING", "CHARGE_SUCCEEDED", "PURCHASED", null],
      ["CHARGING", "CHARGE_FAILED", "FAILED", null],
      ["CHARGING", "SCA_REQUIRED", "REQUIRES_USER_ACTION", null],
      ["CHARGING", "CHARGE_UNRESOLVED", "MANUAL_REVIEW", null],
      ["REQUIRES_USER_ACTION", "SCA_COMPLETED", "CHARGING", null],
      ["REQUIRES_USER_ACTION", "SCA_ABANDONED", "FAILED", null],
      ["REQUIRES_USER_ACTION", "CHARGE_UNRESOLVED", "MANUAL_REVIEW", null],
      ["MANUAL_REVIEW", "CHARGE_SUCCEEDED", "PURCHASED", null],
      ["MANUAL_REVIEW", "CHARGE_FAILED", "FAILED", null],
    ],
  },
};

type Ctx = Record<string, boolean | number>;

interface LooseMachine {
  readonly name: string;
  readonly states: readonly string[];
  readonly events: readonly string[];
  readonly initial: string;
  readonly terminalStates: readonly string[];
  isState(v: string): boolean;
  isEvent(v: string): boolean;
  parseState(v: string): string;
  isTerminal(s: string): boolean;
  availableEvents(s: string): readonly string[];
  can(s: string, e: string, ctx?: Ctx): boolean;
  transition(s: string, e: string, ctx?: Ctx): string;
  target(s: string, e: string): string | undefined;
  edges(): readonly { from: string; event: string; to: string; guard: string | undefined }[];
  analyze(): {
    reachable: readonly string[];
    unreachable: readonly string[];
    deadEnds: readonly string[];
    terminalsWithOutgoing: readonly string[];
    ok: boolean;
  };
}

const loose = (m: unknown): LooseMachine => m as LooseMachine;
const keys = Object.keys(SPECS) as StateMachineKey[];

function bools(names: readonly string[]): Ctx[] {
  let out: Ctx[] = [{}];
  for (const k of names) out = out.flatMap((c) => [{ ...c, [k]: true }, { ...c, [k]: false }]);
  return out;
}
const withAttempts = (key: string, ctxs: Ctx[]): Ctx[] =>
  [0, 1, 2, 3, 4, 100].flatMap((n) => ctxs.map((c) => ({ ...c, [key]: n })));

const CONTEXTS: Record<StateMachineKey, Ctx[]> = {
  orderGroup: bools(["stockAvailable"]),
  sellerOrder: withAttempts("deliveryAttempts", bools(["returnWindowElapsed"])),
  shipment: withAttempts("attemptsMade", bools(["cod"])),
  return: bools(["rejectionPhotosAttached", "inspectionSlaElapsed"]),
  refund: withAttempts("attempts", [{}]),
  payout: bools(["approvalRequirementMet", "noOpenDispute", "ibanNameMatched"]),
  subscription: [{}],
  drop: [{}],
  priceClaim: [{}],
  giftCard: bools(["potFunded", "expiryReached"]),
  kyc: bools(["documentsValid", "sanctionsClear", "signatoryAdult21"]),
  dispute: bools(["decidedByHuman"]),
  priceDropAutoBuy: bools([
    "verifiedPriceAtOrBelowTarget",
    "plusActive",
    "withinBudget",
    "eligiblePaymentMethod",
    "cancelWindowElapsed",
  ]),
};

const num = (c: Ctx, k: string): number => {
  const v = c[k];
  return typeof v === "number" ? v : Number.NaN;
};
const flag = (c: Ctx, k: string): boolean => c[k] === true;

/** Expected guard semantics, written from the guard names and the spec, not from the code. */
const ORACLE: Record<string, (c: Ctx) => boolean> = {
  stockAvailable: (c) => flag(c, "stockAvailable"),
  returnWindowElapsed: (c) => flag(c, "returnWindowElapsed"),
  deliveryAttemptsLeft: (c) => num(c, "deliveryAttempts") < 3,
  deliveryAttemptsExhausted: (c) => num(c, "deliveryAttempts") >= 3,
  isCod: (c) => flag(c, "cod"),
  isNotCod: (c) => !flag(c, "cod"),
  attemptsLeft: (c) => num(c, "attemptsMade") < 3,
  attemptsExhausted: (c) => num(c, "attemptsMade") >= 3,
  rejectionPhotosAttached: (c) => flag(c, "rejectionPhotosAttached"),
  inspectionSlaElapsed: (c) => flag(c, "inspectionSlaElapsed"),
  attemptsBelowMax: (c) => num(c, "attempts") < 3,
  attemptsAtMax: (c) => num(c, "attempts") >= 3,
  approvalRequirementMetAndNoOpenDispute: (c) => flag(c, "approvalRequirementMet") && flag(c, "noOpenDispute"),
  ibanNameMatched: (c) => flag(c, "ibanNameMatched"),
  potFunded: (c) => flag(c, "potFunded"),
  expiryReached: (c) => flag(c, "expiryReached"),
  expiryNotReached: (c) => !flag(c, "expiryReached"),
  documentsValidSanctionsClearSignatory21: (c) =>
    flag(c, "documentsValid") && flag(c, "sanctionsClear") && flag(c, "signatoryAdult21"),
  decidedByHuman: (c) => flag(c, "decidedByHuman"),
  verifiedPriceAtOrBelowTarget: (c) => flag(c, "verifiedPriceAtOrBelowTarget"),
  plusActiveWithinBudgetEligibleMethod: (c) =>
    flag(c, "plusActive") && flag(c, "withinBudget") && flag(c, "eligiblePaymentMethod"),
  someCheckFailed: (c) => !(flag(c, "plusActive") && flag(c, "withinBudget") && flag(c, "eligiblePaymentMethod")),
  cancelWindowElapsed: (c) => flag(c, "cancelWindowElapsed"),
};

describe("exported machine constants", () => {
  it("pins the retry and attempt limits and the auto-buy cancel window", async () => {
    const refund = await import("./machines/refund");
    const shipment = await import("./machines/shipment");
    const sellerOrder = await import("./machines/seller-order");
    const autoBuy = await import("./machines/price-drop-auto-buy");
    expect(refund.MAX_REFUND_ATTEMPTS).toBe(3);
    expect(shipment.MAX_SHIPMENT_ATTEMPTS).toBe(3);
    expect(sellerOrder.MAX_DELIVERY_ATTEMPTS).toBe(3);
    expect(autoBuy.AUTO_BUY_CANCEL_WINDOW_MINUTES).toBe(15);
  });
});

describe("registry", () => {
  it("lists exactly the 13 machines", async () => {
    const stateMachines = await loadRegistry();
    expect(Object.keys(stateMachines).sort()).toEqual([...keys].sort());
    expect(keys).toHaveLength(13);
  });
});

describe.each(keys)("%s machine table", (key) => {
  const spec = SPECS[key];
  // Re-evaluate the machine modules inside the test so module-level (static) mutants are exercised
  // by StrykerJS: a cached import would be evaluated once, before the mutant is activated.
  let m = loose(undefined);
  beforeAll(async () => {
    m = loose((await loadRegistry())[key]);
  });

  it("has the pinned identity, states, events, initial and terminal states", () => {
    expect(m.name).toBe(spec.name);
    expect(m.initial).toBe(spec.initial);
    expect(m.states).toEqual(spec.states);
    expect(m.events).toEqual(spec.events);
    expect(m.terminalStates).toEqual(spec.terminal);
  });

  it("has exactly the pinned edges and guard names, in declaration order", () => {
    expect(m.edges().map((e) => [e.from, e.event, e.to, e.guard ?? null])).toEqual(spec.edges);
  });

  it("every guard name has an oracle", () => {
    for (const [, , , g] of spec.edges) if (g !== null) expect(ORACLE[g]).toBeDefined();
  });

  it("classifies states, events and terminals", () => {
    for (const s of spec.states) {
      expect(m.isState(s)).toBe(true);
      expect(m.parseState(s)).toBe(s);
      expect(m.isTerminal(s)).toBe(spec.terminal.includes(s));
      expect(m.isEvent(s)).toBe(spec.events.includes(s));
    }
    for (const e of spec.events) expect(m.isEvent(e)).toBe(true);
    expect(m.isState("NOT_A_STATE")).toBe(false);
    expect(m.isEvent("NOT_AN_EVENT")).toBe(false);
    expect(() => m.parseState("NOT_A_STATE")).toThrow(/unknown state/);
  });

  it("terminal states have no outgoing events and the machine passes analysis", () => {
    for (const t of spec.terminal) expect(m.availableEvents(t)).toEqual([]);
    const a = m.analyze();
    expect(a.ok).toBe(true);
    expect(a.unreachable).toEqual([]);
    expect(a.deadEnds).toEqual([]);
    expect(a.terminalsWithOutgoing).toEqual([]);
    expect(a.reachable).toEqual(spec.states);
  });

  it("availableEvents, target and can agree with the table for every state and event", () => {
    for (const s of spec.states) {
      const declared = spec.edges.filter(([from]) => from === s);
      expect(m.availableEvents(s)).toEqual(spec.events.filter((e) => declared.some(([, ev]) => ev === e)));
      for (const e of spec.events) {
        const edge = declared.find(([, ev]) => ev === e);
        expect(m.target(s, e)).toBe(edge === undefined ? undefined : edge[2]);
        if (edge === undefined) expect(m.can(s, e, CONTEXTS[key][0])).toBe(false);
      }
    }
  });

  it("rejects every undeclared transition with an InvalidTransitionError carrying exact details", () => {
    for (const s of spec.states) {
      const allowed = spec.edges.filter(([from]) => from === s).map(([, e]) => e);
      const orderedAllowed = spec.events.filter((e) => allowed.includes(e));
      for (const e of spec.events) {
        if (allowed.includes(e)) continue;
        let caught: unknown;
        try {
          m.transition(s, e, CONTEXTS[key][0]);
        } catch (err) {
          caught = err;
        }
        expect((caught as Error).name).toBe("InvalidTransitionError");
        const err = caught as Error & { machine: string; from: string; event: string; allowedEvents: string[] };
        expect(err.machine).toBe(spec.name);
        expect(err.from).toBe(s);
        expect(err.event).toBe(e);
        expect(err.allowedEvents).toEqual(orderedAllowed);
        expect(err.message).toBe(
          `${spec.name}: event "${e}" is not allowed in state "${s}" (allowed: ${
            orderedAllowed.length === 0 ? "none, terminal" : orderedAllowed.join(", ")
          })`,
        );
        expect(err.name).toBe("InvalidTransitionError");
        expect(err).toBeInstanceOf(Error);
      }
    }
  });

  it("follows every declared edge, honouring guards against the oracle", () => {
    for (const [from, event, to, g] of spec.edges) {
      for (const ctx of CONTEXTS[key]) {
        const oracle = g === null ? true : (ORACLE[g]?.(ctx) ?? false);
        expect(m.can(from, event, ctx)).toBe(oracle);
        if (oracle) {
          expect(m.transition(from, event, ctx)).toBe(to);
        } else {
          let caught: unknown;
          try {
            m.transition(from, event, ctx);
          } catch (err) {
            caught = err;
          }
          expect((caught as Error).name).toBe("GuardRejectedError");
          const err = caught as Error & { machine: string; from: string; event: string; guard: string };
          expect(err.machine).toBe(spec.name);
          expect(err.from).toBe(from);
          expect(err.event).toBe(event);
          expect(err.guard).toBe(g);
          expect(err.message).toBe(`${spec.name}: guard "${g}" rejected event "${event}" in state "${from}"`);
        }
      }
    }
  });

  it("rejects unknown states and events with typed errors and exact messages", () => {
    expect(() => m.transition(spec.initial, "NOPE")).toThrow(/unknown event/);
    expect(() => m.transition(spec.initial, "NOPE")).toThrow(`${spec.name}: unknown event "NOPE"`);
    expect(() => m.transition("NOPE", spec.events[0] as string)).toThrow(/unknown state/);
    expect(() => m.transition("NOPE", spec.events[0] as string)).toThrow(
      `${spec.name}: unknown state "NOPE"`,
    );
    expect(() => m.availableEvents("NOPE")).toThrow(/unknown state/);
    expect(() => m.parseState("NOPE")).toThrow(`${spec.name}: unknown state "NOPE"`);
  });
});

describe("guard boundary values", () => {
  let sellerOrder = loose(undefined);
  let shipment = loose(undefined);
  let refund = loose(undefined);
  beforeAll(async () => {
    const all = await loadRegistry();
    sellerOrder = loose(all.sellerOrder);
    shipment = loose(all.shipment);
    refund = loose(all.refund);
  });

  it("refund retries below 3 attempts and escalates at 3", () => {
    expect(refund.can("FAILED", "RETRY", { attempts: 2 })).toBe(true);
    expect(refund.can("FAILED", "RETRY", { attempts: 3 })).toBe(false);
    expect(refund.can("FAILED", "ESCALATE", { attempts: 2 })).toBe(false);
    expect(refund.can("FAILED", "ESCALATE", { attempts: 3 })).toBe(true);
  });

  it("shipment and seller order stop retrying at exactly 3 attempts", () => {
    const shipEdges = SPECS.shipment.edges.filter(([, , , g]) => g === "attemptsLeft" || g === "attemptsExhausted");
    expect(shipEdges.length).toBeGreaterThan(0);
    for (const [from, event, , g] of shipEdges) {
      expect(shipment.can(from, event, { cod: false, attemptsMade: 2 })).toBe(g === "attemptsLeft");
      expect(shipment.can(from, event, { cod: false, attemptsMade: 3 })).toBe(g === "attemptsExhausted");
    }
    const soEdges = SPECS.sellerOrder.edges.filter(
      ([, , , g]) => g === "deliveryAttemptsLeft" || g === "deliveryAttemptsExhausted",
    );
    expect(soEdges.length).toBeGreaterThan(0);
    for (const [from, event, , g] of soEdges) {
      const base = { returnWindowElapsed: false };
      expect(sellerOrder.can(from, event, { ...base, deliveryAttempts: 2 })).toBe(g === "deliveryAttemptsLeft");
      expect(sellerOrder.can(from, event, { ...base, deliveryAttempts: 3 })).toBe(
        g === "deliveryAttemptsExhausted",
      );
    }
  });
});

describe("definition validation (MachineDefinitionError)", () => {
  type S = "A" | "B" | "C";
  type E = "go" | "stop";
  const base: MachineDefinition<S, E, undefined> = {
    name: "M",
    states: ["A", "B", "C"],
    events: ["go", "stop"],
    initial: "A",
    terminal: ["C"],
    transitions: { A: { go: { to: "B" } }, B: { stop: { to: "C" } }, C: {} },
  };
  const make = (patch: Partial<Record<keyof MachineDefinition<S, E, undefined>, unknown>>): (() => unknown) => {
    const def = { ...base, ...patch } as unknown as MachineDefinition<S, E, undefined>;
    return () => defineMachine(def);
  };
  const expectDef = (fn: () => unknown, message: string): void => {
    expect(fn).toThrow(MachineDefinitionError);
    expect(fn).toThrow(message);
  };

  it("accepts a valid definition", () => {
    const m = defineMachine(base);
    expect(m.transition("A", "go")).toBe("B");
  });

  it("rejects duplicate states and events", () => {
    expectDef(make({ states: ["A", "B", "C", "A"] }), "M: duplicate states");
    expectDef(make({ events: ["go", "stop", "go"] }), "M: duplicate events");
  });

  it("rejects an initial or terminal state that is not a state", () => {
    expectDef(make({ initial: "Z" }), `M: initial state "Z" is not a state`);
    expectDef(make({ terminal: ["Z"] }), `M: terminal state "Z" is not a state`);
  });

  it("rejects a missing row, unknown event, unknown target and unknown row key", () => {
    expectDef(make({ transitions: { A: {}, B: {} } }), `M: missing transition row for state "C"`);
    expectDef(
      make({ transitions: { A: { fly: { to: "B" } }, B: {}, C: {} } }),
      `M: state "A" uses unknown event "fly"`,
    );
    expectDef(
      make({ transitions: { A: { go: { to: "Z" } }, B: {}, C: {} } }),
      `M: "A" --go--> unknown state "Z"`,
    );
    expectDef(
      make({ transitions: { A: {}, B: {}, C: {}, Z: {} } }),
      `M: transition row for unknown state "Z"`,
    );
  });

  it("tolerates an explicitly undefined spec entry", () => {
    const def = {
      ...base,
      transitions: { A: { go: { to: "B" }, stop: undefined }, B: { stop: { to: "C" } }, C: {} },
    } as unknown as MachineDefinition<S, E, undefined>;
    const m = defineMachine(def);
    expect(m.target("A", "stop")).toBeUndefined();
    expect(m.can("A", "stop")).toBe(false);
    expect(m.availableEvents("A")).toEqual(["go"]);
  });
});

describe("analyze on deliberately broken machines", () => {
  type S = "S0" | "S1" | "S2" | "S3" | "S4" | "T";
  type E = "a" | "b" | "c";
  const STATES: readonly S[] = ["S0", "S1", "S2", "S3", "S4", "T"];
  const EVENTS: readonly E[] = ["a", "b", "c"];
  const build = (name: string, transitions: MachineDefinition<S, E, undefined>["transitions"]) =>
    defineMachine<S, E>({ name, states: STATES, events: EVENTS, initial: "S0", terminal: ["T"], transitions });
  const none = {} as const;

  it("reports unreachable states and terminals with outgoing edges", () => {
    const m = build("Broken", {
      S0: { a: { to: "S1" } },
      S1: { a: { to: "T" } },
      S2: { a: { to: "S0" } },
      S3: none,
      S4: { a: { to: "S4" } },
      T: { c: { to: "S0" } },
    });
    const a = m.analyze();
    expect(a.reachable).toEqual(["S0", "S1", "T"]);
    expect(a.unreachable).toEqual(["S2", "S3", "S4"]);
    expect(a.terminalsWithOutgoing).toEqual(["T"]);
    expect(a.ok).toBe(false);
  });

  it("reports dead ends", () => {
    const m = build("Broken2", {
      S0: { a: { to: "S1" } },
      S1: { a: { to: "T" }, b: { to: "S3" } },
      S2: { a: { to: "S0" } },
      S3: none,
      S4: { a: { to: "S4" } },
      T: { c: { to: "S0" } },
    });
    const a = m.analyze();
    expect(a.reachable).toEqual(["S0", "S1", "S3", "T"]);
    expect(a.unreachable).toEqual(["S2", "S4"]);
    expect(a.deadEnds).toEqual(["S3", "S4"]);
    expect(a.ok).toBe(false);
  });

  it("is not ok when only a dead end exists", () => {
    const m = build("OnlyDead", {
      S0: { a: { to: "T" }, b: { to: "S1" }, c: { to: "S2" } },
      S1: { a: { to: "S3" } },
      S2: { a: { to: "S4" } },
      S3: { a: { to: "S0" } },
      S4: none,
      T: none,
    });
    const a = m.analyze();
    expect(a.unreachable).toEqual([]);
    expect(a.deadEnds).toEqual(["S2", "S4"]);
    expect(a.terminalsWithOutgoing).toEqual([]);
    expect(a.ok).toBe(false);
  });

  it("is not ok when only an unreachable state exists", () => {
    const m = build("OnlyUnreachable", {
      S0: { a: { to: "S1" }, b: { to: "S3" }, c: { to: "S4" } },
      S1: { a: { to: "T" } },
      S2: { a: { to: "T" } },
      S3: { a: { to: "T" } },
      S4: { a: { to: "T" } },
      T: none,
    });
    const a = m.analyze();
    expect(a.unreachable).toEqual(["S2"]);
    expect(a.deadEnds).toEqual([]);
    expect(a.terminalsWithOutgoing).toEqual([]);
    expect(a.ok).toBe(false);
  });

  it("is not ok when only a terminal state has an outgoing edge", () => {
    const m = build("OnlyTerminalOut", {
      S0: { a: { to: "S1" }, b: { to: "S2" }, c: { to: "S3" } },
      S1: { a: { to: "S4" } },
      S2: { a: { to: "T" } },
      S3: { a: { to: "T" } },
      S4: { a: { to: "T" } },
      T: { a: { to: "S0" } },
    });
    const a = m.analyze();
    expect(a.unreachable).toEqual([]);
    expect(a.deadEnds).toEqual([]);
    expect(a.terminalsWithOutgoing).toEqual(["T"]);
    expect(a.ok).toBe(false);
  });

  it("is ok for a clean machine", () => {
    const m = build("Clean", {
      S0: { a: { to: "S1" }, b: { to: "S2" }, c: { to: "S3" } },
      S1: { a: { to: "S4" } },
      S2: { a: { to: "T" } },
      S3: { a: { to: "T" } },
      S4: { a: { to: "T" } },
      T: none,
    });
    const a = m.analyze();
    expect(a.reachable).toEqual(["S0", "S1", "S2", "S3", "S4", "T"]);
    expect(a.ok).toBe(true);
  });

  it("evaluates a guard with the supplied context and names it in errors", () => {
    const g = guard<{ n: number }>("positive", (c) => c.n > 0);
    const gm = defineMachine<"A" | "B", "go", { n: number }>({
      name: "G",
      states: ["A", "B"],
      events: ["go"],
      initial: "A",
      terminal: ["B"],
      transitions: { A: { go: { to: "B", guard: g } }, B: {} },
    });
    expect(g.name).toBe("positive");
    expect(gm.can("A", "go", { n: 1 })).toBe(true);
    expect(gm.can("A", "go", { n: 0 })).toBe(false);
    expect(gm.transition("A", "go", { n: 1 })).toBe("B");
    expect(() => gm.transition("A", "go", { n: 0 })).toThrow(`G: guard "positive" rejected event "go" in state "A"`);
  });
});
