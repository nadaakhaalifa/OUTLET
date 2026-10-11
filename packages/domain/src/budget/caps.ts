import {
  HARD_UNLOCK_DELAY_MS,
  SOFT_HOLD_MAX_AGE_MS,
  SOFT_HOLD_SECONDS,
  type CapDecision,
  type CapMode,
  type Cycle,
} from "./types";

export interface CapInput {
  readonly capMode: CapMode;
  /** Signed remaining for the cycle (bag excluded: the order being placed is the bag). */
  readonly remaining: bigint;
  readonly orderTotal: bigint;
  readonly nowMs: number;
  readonly cycle: Cycle;
  /** Soft cap: when the shopper started the 10 s hold, null if not started. */
  readonly softHeldSinceMs: number | null;
  /** Hard cap: `budgets.hold_until`, the maturity of the latest unlock request. */
  readonly holdUntilMs: number | null;
}

/**
 * Wellbeing caps (spec 12). Soft: exceeding needs a 10 s hold the server verifies. Hard: blocked
 * until payday unless an unlock request matured (24 h delay). An unlock only counts inside the
 * cycle it was requested in, so the next payday starts clean.
 */
export function evaluateCap(i: CapInput): CapDecision {
  if (i.capMode === "off") return { kind: "allow", reason: "cap_off" };
  if (i.orderTotal <= i.remaining) return { kind: "allow", reason: "within_budget" };
  const overBy = i.orderTotal - (i.remaining < 0n ? 0n : i.remaining);
  if (i.capMode === "soft") {
    const held = i.softHeldSinceMs;
    if (held !== null && held <= i.nowMs && i.nowMs - held >= SOFT_HOLD_SECONDS * 1000 && i.nowMs - held <= SOFT_HOLD_MAX_AGE_MS) {
      return { kind: "allow", reason: "soft_confirmed" };
    }
    return { kind: "soft_hold", holdSeconds: SOFT_HOLD_SECONDS, overBy };
  }
  const hold = i.holdUntilMs;
  if (hold !== null && hold <= i.nowMs && hold >= i.cycle.startMs) return { kind: "allow", reason: "hard_unlocked" };
  const pending = hold !== null && hold > i.nowMs && hold >= i.cycle.startMs ? hold : null;
  return { kind: "blocked", reason: "hard_cap", overBy, unlockAtMs: pending, cycleEndMs: i.cycle.endMs };
}

/** When an unlock request made at `nowMs` matures. */
export const unlockAt = (nowMs: number): number => nowMs + HARD_UNLOCK_DELAY_MS;
