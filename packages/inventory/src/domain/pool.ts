export const DEFAULT_POOL_CAP = 1000;

/** Target number of AVAILABLE pool rows for a SKU/location: min(on_hand - committed, cap), never negative. The cap applies to available rows only; reserved rows never count against it. */
export const poolTarget = (onHand: number, committed: number, cap: number = DEFAULT_POOL_CAP): number => {
  if (![onHand, committed, cap].every(Number.isInteger) || onHand < 0 || committed < 0 || cap < 0) throw new RangeError("poolTarget needs non-negative integers");
  return Math.max(0, Math.min(onHand - committed, cap));
};
