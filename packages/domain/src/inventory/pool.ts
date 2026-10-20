import { POOL_CAP } from "./types";

/** Free units: physical stock that is neither claimed nor held by an active reservation. May be negative when oversold. */
export const freeUnits = (onHand: number, committed: number, reserved: number): number =>
  onHand - committed - reserved;

/** Rows that should exist in the AVAILABLE pool: min(free, cap), never negative (spec 20.2). */
export const targetPoolRows = (onHand: number, committed: number, reserved: number, cap: number = POOL_CAP): number =>
  Math.min(cap, Math.max(0, freeUnits(onHand, committed, reserved)));

export interface RebalanceDelta {
  readonly insert: number;
  readonly remove: number;
}

export const rebalanceDelta = (target: number, availableRows: number): RebalanceDelta => ({
  insert: Math.max(0, target - availableRows),
  remove: Math.max(0, availableRows - target),
});

/**
 * Real stock shown to shoppers ("2 left in M") only at 5 or fewer, computed from on_hand and
 * commitments, never from the pool (data model, Rules). Returns null when nothing may be shown.
 */
export const displayableStock = (onHand: number, committed: number, reserved: number): number | null => {
  const free = Math.max(0, freeUnits(onHand, committed, reserved));
  return free >= 1 && free <= 5 ? free : null;
};
