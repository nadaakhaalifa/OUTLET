import {
  MAX_REFUND_ATTEMPTS,
  REFUND_STATES,
  refundMachine,
  type RefundEvent,
  type RefundState,
} from "../state-machine/machines/refund";
import type { RefundChannel } from "./types";

export { MAX_REFUND_ATTEMPTS, REFUND_STATES, refundMachine };
export type { RefundEvent, RefundState };

/** The customer-facing vocabulary of spec 15.6 over the engine states of the shared Refund machine. */
export type RefundStatus =
  | "REQUESTED"
  | "APPROVED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "MANUAL_REVIEW"
  | "CANCELLED";

/**
 * APPROVED = ledger posted (ledger-first: approval and the journal entry are one step),
 * PROCESSING = submitted to the PSP or provider. Same machine, no second copy of the table.
 */
export function publicStatus(state: RefundState): RefundStatus {
  switch (state) {
    case "LEDGER_POSTED":
      return "APPROVED";
    case "SUBMITTED":
      return "PROCESSING";
    case "REQUESTED":
    case "COMPLETED":
    case "FAILED":
    case "MANUAL_REVIEW":
    case "CANCELLED":
      return state;
  }
}

/** Channels settled inside Z-OUTLET (no external call). */
export function isInternalChannel(c: RefundChannel): boolean {
  return c === "store_credit" || c === "store_credit_original_sub";
}

/** Refund-level status from its legs. Order of precedence: attention first, then progress. */
export function aggregateStatus(legs: readonly RefundState[]): RefundStatus {
  if (legs.length === 0) return "REQUESTED";
  if (legs.every((s) => s === "CANCELLED")) return "CANCELLED";
  const live = legs.filter((s) => s !== "CANCELLED");
  if (live.every((s) => s === "COMPLETED")) return "COMPLETED";
  if (live.some((s) => s === "MANUAL_REVIEW")) return "MANUAL_REVIEW";
  if (live.some((s) => s === "FAILED")) return "FAILED";
  if (live.some((s) => s === "SUBMITTED")) return "PROCESSING";
  if (live.every((s) => s === "REQUESTED")) return "REQUESTED";
  return "APPROVED";
}

export interface LegContext {
  readonly attempts: number;
}

/** Event for a leg that failed: retry while attempts remain, else escalate. */
export function nextFailureEvent(attempts: number): "RETRY" | "ESCALATE" {
  return attempts < MAX_REFUND_ATTEMPTS ? "RETRY" : "ESCALATE";
}
