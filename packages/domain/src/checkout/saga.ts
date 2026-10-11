import { InvalidSagaTransitionError } from "./errors";
import type { CheckoutMethod } from "./types";

/** Forward steps of the checkout saga (spec 7, ADR-0021 decision 6). */
export const SAGA_STEPS = [
  "VALIDATE_CART",
  "RESERVE_INVENTORY",
  "HOLD_CREDIT",
  "CREATE_INTENT",
  "AWAIT_PAYMENT",
  "CLAIM_AND_POST",
  "PLACED",
] as const;
export type SagaStep = (typeof SAGA_STEPS)[number];

export const SAGA_TERMINALS = ["FAILED", "EXPIRED", "CANCELLED", "REFUNDED"] as const;
export type SagaTerminal = (typeof SAGA_TERMINALS)[number];

export type SagaStatus = SagaStep | "COMPENSATING" | SagaTerminal;

export type CompensationReason =
  | "stock_unavailable"
  | "payment_failed"
  | "payment_window_elapsed"
  | "cancelled_by_shopper"
  | "price_changed"
  | "late_payment_no_stock"
  | "late_credit_unavailable"
  | "payment_after_cancel"
  | "risk_blocked"
  | "intent_rejected"
  | "credit_unavailable";

/** Which terminal each reason ends in once compensation completes. */
export const TERMINAL_FOR: Readonly<Record<CompensationReason, SagaTerminal>> = {
  stock_unavailable: "FAILED",
  payment_failed: "FAILED",
  payment_window_elapsed: "EXPIRED",
  cancelled_by_shopper: "CANCELLED",
  price_changed: "FAILED",
  late_payment_no_stock: "REFUNDED",
  late_credit_unavailable: "REFUNDED",
  payment_after_cancel: "REFUNDED",
  risk_blocked: "FAILED",
  intent_rejected: "FAILED",
  credit_unavailable: "FAILED",
};

export type PaymentState = "none" | "succeeded" | "failed";
export type CodConfirmation = "not_required" | "pending" | "confirmed";

/** Everything the saga decides on. Plain data so it persists as one row. */
export interface SagaFacts {
  readonly status: SagaStatus;
  readonly method: CheckoutMethod;
  /** Amounts in piastres. */
  readonly creditAmount: bigint;
  readonly externalDue: bigint;
  readonly codConfirmation: CodConfirmation;

  readonly reservationId: string | null;
  readonly reservationExpiresAtMs: number | null;
  readonly reservationReleased: boolean;

  readonly holdId: string | null;
  /** Bumped when a late payment revives the saga and the credit must be held again under a fresh id. */
  readonly holdSeq: number;
  readonly holdReleased: boolean;
  readonly holdCaptured: boolean;

  readonly intentId: string | null;
  readonly intentVoided: boolean;
  readonly payment: PaymentState;

  readonly claimed: boolean;
  readonly ledgerPosted: boolean;
  readonly ledgerReversed: boolean;
  readonly ordersPlaced: boolean;
  readonly refunded: boolean;
  /** Money was parked in the ledger for a payment that arrived with no order to attach it to. */
  readonly lateReceiptPosted: boolean;

  readonly compensating: { readonly reason: CompensationReason; readonly terminal: SagaTerminal } | null;
}

export function initialFacts(input: {
  readonly method: CheckoutMethod;
  readonly creditAmount: bigint;
  readonly externalDue: bigint;
  readonly codNeedsConfirmation: boolean;
}): SagaFacts {
  return {
    status: "VALIDATE_CART",
    method: input.method,
    creditAmount: input.creditAmount,
    externalDue: input.externalDue,
    codConfirmation: input.method === "cod" && input.codNeedsConfirmation ? "pending" : "not_required",
    reservationId: null,
    reservationExpiresAtMs: null,
    reservationReleased: false,
    holdId: null,
    holdSeq: 0,
    holdReleased: false,
    holdCaptured: false,
    intentId: null,
    intentVoided: false,
    payment: "none",
    claimed: false,
    ledgerPosted: false,
    ledgerReversed: false,
    ordersPlaced: false,
    refunded: false,
    lateReceiptPosted: false,
    compensating: null,
  };
}

export const needsHold = (f: SagaFacts): boolean => f.creditAmount > 0n;
export const needsIntent = (f: SagaFacts): boolean => f.externalDue > 0n && f.method !== "cod";
export const isCod = (f: SagaFacts): boolean => f.method === "cod" && f.externalDue > 0n;
/** Cash on delivery is recognised in the ledger at delivery, never at checkout. */
export const defersLedger = (f: SagaFacts): boolean => f.method === "cod";

export type CompensationStep =
  | "refund_payment"
  | "void_intent"
  | "reverse_ledger"
  | "release_hold"
  | "release_reservation";

/**
 * Compensations still owed, in execution order: undo accounting, stop money, then free stock. Orders already placed are never compensated here (cancellation belongs to orders).
 */
export function pendingCompensations(f: SagaFacts): CompensationStep[] {
  if (f.ordersPlaced) return [];
  const out: CompensationStep[] = [];
  // Ledger-first (ADR-0021 d5): undo accounting before the money leaves, then stop money, then free stock.
  if (f.ledgerPosted && !f.ledgerReversed) out.push("reverse_ledger");
  if (f.intentId !== null && f.payment === "succeeded" && !f.refunded) out.push("refund_payment");
  if (f.intentId !== null && f.payment !== "succeeded" && !f.intentVoided) out.push("void_intent");
  if (f.holdId !== null && !f.holdReleased) out.push("release_hold");
  if (f.reservationId !== null && !f.reservationReleased) out.push("release_reservation");
  return out;
}

export type SagaAction =
  | { readonly kind: "validate" }
  | { readonly kind: "reserve" }
  | { readonly kind: "hold_credit" }
  | { readonly kind: "create_intent" }
  | { readonly kind: "wait"; readonly wakeAtMs: number | null }
  | { readonly kind: "claim" }
  | { readonly kind: "post_ledger" }
  | { readonly kind: "place_orders" }
  | { readonly kind: "capture_credit" }
  | { readonly kind: "compensate"; readonly step: CompensationStep }
  | { readonly kind: "finish_compensation" }
  | { readonly kind: "begin_compensation"; readonly reason: CompensationReason }
  | { readonly kind: "mark_placed" }
  | { readonly kind: "advance"; readonly to: SagaStep }
  | { readonly kind: "none" };

/** First forward step after `from`, skipping steps this saga does not need. */
export function stepAfter(f: SagaFacts, from: SagaStep): SagaStep {
  const order = SAGA_STEPS;
  let i = order.indexOf(from) + 1;
  for (; i < order.length; i += 1) {
    const s = order[i];
    if (s === undefined) break;
    if (s === "HOLD_CREDIT" && (!needsHold(f) || f.holdId !== null)) continue;
    if (s === "CREATE_INTENT" && (!needsIntent(f) || f.intentId !== null || f.payment === "succeeded")) continue;
    if (s === "AWAIT_PAYMENT" && !needsIntent(f) && !(isCod(f) && f.codConfirmation === "pending")) continue;
    return s;
  }
  return "PLACED";
}

/** Pure next-action decision. The runner performs it, persists the outcome, and asks again. */
export function nextAction(f: SagaFacts, nowMs: number): SagaAction {
  switch (f.status) {
    case "PLACED":
    case "FAILED":
    case "EXPIRED":
    case "CANCELLED":
    case "REFUNDED":
      return { kind: "none" };
    case "COMPENSATING": {
      const step = pendingCompensations(f)[0];
      return step === undefined ? { kind: "finish_compensation" } : { kind: "compensate", step };
    }
    default:
      break;
  }

  const expired = f.reservationExpiresAtMs !== null && nowMs >= f.reservationExpiresAtMs;
  const claimingStage = f.status === "CLAIM_AND_POST" || f.claimed;

  if (f.payment === "failed" && !claimingStage) {
    return { kind: "begin_compensation", reason: "payment_failed" };
  }
  if (expired && f.payment !== "succeeded" && !claimingStage && f.status !== "VALIDATE_CART") {
    return { kind: "begin_compensation", reason: "payment_window_elapsed" };
  }

  switch (f.status) {
    case "VALIDATE_CART":
      return { kind: "validate" };
    case "RESERVE_INVENTORY":
      return f.reservationId === null ? { kind: "reserve" } : { kind: "advance", to: stepAfter(f, "RESERVE_INVENTORY") };
    case "HOLD_CREDIT":
      return f.holdId === null ? { kind: "hold_credit" } : { kind: "advance", to: stepAfter(f, "HOLD_CREDIT") };
    case "CREATE_INTENT":
      return f.intentId === null && f.payment !== "succeeded"
        ? { kind: "create_intent" }
        : { kind: "advance", to: stepAfter(f, "CREATE_INTENT") };
    case "AWAIT_PAYMENT": {
      if (needsIntent(f)) {
        if (f.payment === "succeeded") return { kind: "advance", to: "CLAIM_AND_POST" };
        return { kind: "wait", wakeAtMs: f.reservationExpiresAtMs };
      }
      if (f.codConfirmation === "pending") return { kind: "wait", wakeAtMs: f.reservationExpiresAtMs };
      return { kind: "advance", to: "CLAIM_AND_POST" };
    }
    case "CLAIM_AND_POST":
      if (!f.claimed) return { kind: "claim" };
      // post_ledger captures the credit hold in the same step (one CAS) and posts the entry. A hold
      // that cannot be captured must be found BEFORE orders exist, so capture precedes place_orders.
      if (!f.ledgerPosted && !defersLedger(f)) return { kind: "post_ledger" };
      if (needsHold(f) && !f.holdCaptured) return { kind: "capture_credit" };
      if (!f.ordersPlaced) return { kind: "place_orders" };
      return { kind: "mark_placed" };
    default:
      throw new InvalidSagaTransitionError(`no action for ${f.status}`);
  }
}

/** Enters compensation. Refused once orders exist or when already compensating or finished. */
export function beginCompensation(f: SagaFacts, reason: CompensationReason): SagaFacts {
  if (f.ordersPlaced || f.status === "PLACED") {
    throw new InvalidSagaTransitionError("orders already placed: cancel through orders, not checkout");
  }
  if (f.status === "COMPENSATING") return f;
  if ((SAGA_TERMINALS as readonly string[]).includes(f.status)) {
    throw new InvalidSagaTransitionError(`saga already ${f.status}`);
  }
  return { ...f, status: "COMPENSATING", compensating: { reason, terminal: TERMINAL_FOR[reason] } };
}

export function finishCompensation(f: SagaFacts): SagaFacts {
  if (f.status !== "COMPENSATING" || f.compensating === null) {
    throw new InvalidSagaTransitionError("not compensating");
  }
  if (pendingCompensations(f).length > 0) throw new InvalidSagaTransitionError("compensations pending");
  return { ...f, status: f.compensating.terminal };
}

export const isTerminal = (s: SagaStatus): boolean => s === "PLACED" || (SAGA_TERMINALS as readonly string[]).includes(s);

/** A late payment can revive a saga that expired or is expiring, never one the shopper cancelled. */
export function canReviveForLatePayment(f: SagaFacts): boolean {
  if (f.payment !== "succeeded" || f.refunded || f.ordersPlaced || f.intentId === null) return false;
  if (f.status === "EXPIRED") return true;
  return f.status === "COMPENSATING" && f.compensating?.reason === "payment_window_elapsed";
}

/**
 * Revives an expired saga after a late success: stock is claimed directly if still free
 * (`claim` returns claimed_late), otherwise the runner refunds with an apology voucher intent.
 * The credit hold, if any, must be taken again because expiry released it.
 */
export function reviveForLatePayment(f: SagaFacts): SagaFacts {
  if (!canReviveForLatePayment(f)) throw new InvalidSagaTransitionError("late payment cannot revive this saga");
  const needHold = f.creditAmount > 0n && (f.holdId === null || f.holdReleased);
  return {
    ...f,
    status: needHold ? "HOLD_CREDIT" : "CLAIM_AND_POST",
    holdId: needHold ? null : f.holdId,
    holdSeq: needHold ? f.holdSeq + 1 : f.holdSeq,
    holdReleased: needHold ? false : f.holdReleased,
    claimed: false,
    compensating: null,
    intentVoided: f.intentVoided,
  };
}

/**
 * A payment succeeded for a saga that already ended without orders (failed, expired and not
 * revivable, or cancelled). The only safe outcome is to refund it: reopen into compensation.
 */
export function reopenForRefund(f: SagaFacts): SagaFacts {
  const closed = f.status === "FAILED" || f.status === "EXPIRED" || f.status === "CANCELLED";
  if (!closed || f.payment !== "succeeded" || f.refunded || f.ordersPlaced) {
    throw new InvalidSagaTransitionError("nothing to refund");
  }
  return {
    ...f,
    status: "COMPENSATING",
    compensating: { reason: "payment_after_cancel", terminal: "REFUNDED" },
  };
}
