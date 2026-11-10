import { WINDOW_MS } from "./window.js";
import type { PriceWindow } from "./window.js";

/** Minimum verified discount that may be claimed (master prompt 9.3). */
export const MIN_CLAIM_PCT = 5;

/**
 * Internal-evidence VRP: the window reference, valid only with >= 30 days of history and a discount run that started within
 * the last 30 days. Re-checked against `now` so a stored window can never outlive its validity.
 */
export const vrpFromInternal = (window: PriceWindow, now: Date): bigint | null => {
  if (window.launchPrice || window.reference === null || window.referenceRunStart === null) return null;
  if (window.referenceRunStart.getTime() < now.getTime() - WINDOW_MS) return null;
  return window.reference;
};

/** floor((vrp - price) * 100 / vrp) on minor units; 0 when price is not below the reference. */
export const discountPct = (vrp: bigint, price: bigint): number => {
  if (vrp <= 0n || price >= vrp) return 0;
  return Number(((vrp - price) * 100n) / vrp);
};

export const claimAllowed = (vrp: bigint | null, price: bigint): boolean => vrp !== null && discountPct(vrp, price) >= MIN_CLAIM_PCT;
