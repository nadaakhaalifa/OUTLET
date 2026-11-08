/**
 * floor(part * 100 / whole) in bigint integer math, clamped to 0..100. Floor (not half-even) is the
 * VRP rule: a percentage may never be rounded up into a larger claim. Parameters are deliberately
 * neutral names: they are minor-unit bigints, never floats.
 */
export function floorPercent(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const pct = (part * 100n) / whole;
  return Number(pct > 100n ? 100n : pct);
}
