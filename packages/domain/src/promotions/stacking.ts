import type { Promotion, PromotionKind, PromotionScope, StackingPolicy } from "./types";
import { PROMOTION_SCOPES } from "./types";

/** Plain code-unit string order, so sorting never depends on the runtime locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when the set breaks the stacking matrix (spec 17). */
export function violatesStacking(set: readonly Promotion[], policy: StackingPolicy): boolean {
  let platformCodes = 0;
  const perStore = new Map<string, number>();
  const perScope = new Map<PromotionScope, number>();
  for (const p of set) {
    if (p.code === null) perScope.set(p.scope, (perScope.get(p.scope) ?? 0) + 1);
    else if (p.owner.kind === "platform") platformCodes += 1;
    else perStore.set(p.owner.storeId, (perStore.get(p.owner.storeId) ?? 0) + 1);
  }
  if (platformCodes > policy.maxPlatformCodes) return true;
  for (const n of perStore.values()) if (n > policy.maxStoreVouchersPerStore) return true;
  for (const n of perScope.values()) if (n > policy.maxAutoPerScope) return true;
  return false;
}

const KIND_RANK: Readonly<Record<PromotionKind, number>> = {
  bogo: 0,
  tiered: 1,
  fixed: 2,
  percent: 3,
  free_shipping: 4,
};

/** Fixed evaluation order: item, store, order, shipping; then kind rank; then id (spec 17). */
export function applicationOrder(set: readonly Promotion[]): Promotion[] {
  return [...set].sort((a, b) => {
    const s = PROMOTION_SCOPES.indexOf(a.scope) - PROMOTION_SCOPES.indexOf(b.scope);
    if (s !== 0) return s;
    const k = KIND_RANK[a.value.kind] - KIND_RANK[b.value.kind];
    if (k !== 0) return k;
    return compareText(a.id, b.id);
  });
}

export interface Scored<T> {
  readonly subset: readonly T[];
  readonly payable: bigint;
}

/**
 * Exact auto-best: tries every subset of the (at most `maxCandidates`) candidates and keeps the
 * one the shopper pays least for. Ties go to fewer promotions, then to the lexicographically
 * smaller id list, so the choice is fully deterministic.
 */
export function chooseBest(
  candidates: readonly Promotion[],
  policy: StackingPolicy,
  price: (subset: readonly Promotion[]) => bigint,
): Scored<Promotion> {
  const n = candidates.length;
  let best: Scored<Promotion> | null = null;
  let bestKey = "";
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const subset = candidates.filter((_, i) => (mask & (1 << i)) !== 0);
    if (violatesStacking(subset, policy)) continue;
    const payable = price(subset);
    const key = subset.map((p) => p.id).sort().join(",");
    const better =
      best === null ||
      payable < best.payable ||
      (payable === best.payable &&
        (subset.length < best.subset.length || (subset.length === best.subset.length && key < bestKey)));
    if (better) {
      best = { subset, payable };
      bestKey = key;
    }
  }
  return best ?? { subset: [], payable: price([]) };
}
