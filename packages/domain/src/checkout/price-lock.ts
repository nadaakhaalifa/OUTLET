import { PRICE_LOCK_MS, type Money } from "./types";

export interface PriceLockSnapshot {
  readonly userId: string;
  readonly expiresAtMs: number;
  /** skuId -> unit price at the time the quote was shown. */
  readonly unitPrices: ReadonlyMap<string, bigint>;
  readonly total: bigint;
}

export function lockExpiry(nowMs: number): number {
  return nowMs + PRICE_LOCK_MS;
}

export function lockActive(lock: PriceLockSnapshot | null, userId: string, nowMs: number): boolean {
  return lock !== null && lock.userId === userId && nowMs < lock.expiresAtMs;
}

/**
 * Inside an active lock the shopper never pays more per unit than the locked price. A price that
 * fell is passed on: we take the lower of the two. Outside a lock the current price applies.
 */
export function effectiveUnitPrice(
  skuId: string,
  current: Money,
  lock: PriceLockSnapshot | null,
  userId: string,
  nowMs: number,
): Money {
  if (!lockActive(lock, userId, nowMs) || lock === null) return current;
  const locked = lock.unitPrices.get(skuId);
  if (locked === undefined || locked >= current.amount) return current;
  return { amount: locked, currency: current.currency };
}

export type Reconfirmation =
  | { readonly kind: "ok" }
  | { readonly kind: "changed"; readonly expected: bigint; readonly actual: bigint; readonly delta: bigint };

/** The shopper confirmed `expectedTotal`. Any difference must be shown and re-confirmed (spec 7). */
export function reconfirm(expectedTotal: bigint | null, actualTotal: bigint): Reconfirmation {
  if (expectedTotal === null || expectedTotal === actualTotal) return { kind: "ok" };
  return { kind: "changed", expected: expectedTotal, actual: actualTotal, delta: actualTotal - expectedTotal };
}
