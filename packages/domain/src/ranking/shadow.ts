export interface ShadowComparison {
  readonly k: number;
  /** Share of v1's top-k also in v2's top-k, permille. */
  readonly overlapPermille: number;
  readonly top1Same: boolean;
  /** Mean absolute rank displacement over items present in both lists. */
  readonly meanRankShift: number;
}

/** v1 order is what was served; v2 scores are only logged. Never changes what the shopper sees. */
export function compareShadow(v1Order: readonly string[], v2Scores: ReadonlyMap<string, number>, k = 10): ShadowComparison {
  const v2Order = [...v2Scores.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id);
  const top1 = v1Order.slice(0, k);
  const top2 = new Set(v2Order.slice(0, k));
  const common = top1.filter((id) => top2.has(id)).length;
  const pos2 = new Map(v2Order.map((id, i) => [id, i]));
  const shifts = v1Order.flatMap((id, i) => (pos2.has(id) ? [Math.abs(i - (pos2.get(id) ?? 0))] : []));
  return {
    k,
    overlapPermille: top1.length === 0 ? 1000 : Math.round((common * 1000) / top1.length),
    top1Same: v1Order[0] !== undefined && v1Order[0] === v2Order[0],
    meanRankShift: shifts.length === 0 ? 0 : shifts.reduce((a, b) => a + b, 0) / shifts.length,
  };
}
