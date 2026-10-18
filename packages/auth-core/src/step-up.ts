/** Step-up rule for sensitive seller actions (payout bank change, role grants): the strong factor must be recent. */
export function isRecentStrongFactor(strongFactorAtMs: number | null, nowMs: number, maxAgeSec: number): boolean {
  if (strongFactorAtMs === null || !Number.isFinite(maxAgeSec) || maxAgeSec < 0) return false;
  const age = nowMs - strongFactorAtMs;
  return age >= 0 && age <= maxAgeSec * 1000;
}
