/**
 * Accrual gate (phase-3 money review A-9). Defence in depth behind the orders CLOSED invariant:
 * a commission accrues only when the line's own return window has elapsed AND no return is open.
 * Unknown facts fail closed (never accrue on a guess). The orders window may be longer than the
 * platform default (33 days), so the creators side reads the window the producer states.
 */
export type AccrualGateInput = {
  readonly nowMs: number;
  /** End of the line's return window (seller policy, plus payout margin). Null = unknown. */
  readonly returnWindowEndsAtMs: number | null;
  /** Returns on the line not yet in a terminal state. Null = unknown. */
  readonly openReturns: number | null;
};

export type AccrualGateVerdict = "ok" | "facts_unknown" | "return_open" | "window_open";

export function accrualGate(i: AccrualGateInput): AccrualGateVerdict {
  if (i.returnWindowEndsAtMs === null || i.openReturns === null) return "facts_unknown";
  if (!Number.isInteger(i.returnWindowEndsAtMs) || !Number.isInteger(i.openReturns) || i.openReturns < 0) return "facts_unknown";
  if (i.openReturns > 0) return "return_open";
  if (i.nowMs < i.returnWindowEndsAtMs) return "window_open";
  return "ok";
}
