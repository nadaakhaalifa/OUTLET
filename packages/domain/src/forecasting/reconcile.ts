import type { DemandInterval } from "./interval";

export interface ReconcileChild {
  readonly key: string;
  readonly interval: DemandInterval;
}

/**
 * Top-down reconciliation of one horizon: the children's medians are apportioned from the parent
 * median (largest remainder, ties by key) so they sum EXACTLY to the parent. Child bounds scale by
 * the same ratio (lower floored, upper ceiled) and stay ordered around the new median. The parent is
 * never changed. Children keep their input order.
 */
export function reconcileTopDown(parent: DemandInterval, children: readonly ReconcileChild[]): ReconcileChild[] {
  if (children.length === 0) return [];
  const target = parent.p50;
  const weights = children.map((c) => c.interval.p50);
  const total = weights.reduce((a, b) => a + b, 0);
  const equal = total === 0;
  const w = equal ? children.map(() => 1) : weights;
  const wTotal = equal ? children.length : total;
  const shares = w.map((x) => (target * x) / wTotal);
  const floors = shares.map((s) => Math.floor(s));
  let rest = target - floors.reduce((a, b) => a + b, 0);
  const order = children
    .map((c, i) => ({ i, frac: (shares[i] ?? 0) - (floors[i] ?? 0), key: c.key }))
    .sort((a, b) => b.frac - a.frac || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const out = floors.slice();
  for (const o of order) {
    if (rest <= 0) break;
    out[o.i] = (out[o.i] ?? 0) + 1;
    rest -= 1;
  }
  return children.map((c, i) => {
    const p50 = out[i] ?? 0;
    const old = c.interval;
    const ratio = old.p50 === 0 ? null : p50 / old.p50;
    const p10 = ratio === null ? 0 : Math.min(p50, Math.floor(old.p10 * ratio));
    const p90 = ratio === null ? Math.max(p50, old.p90) : Math.max(p50, Math.ceil(old.p90 * ratio));
    return { key: c.key, interval: { p10, p50, p90 } };
  });
}
