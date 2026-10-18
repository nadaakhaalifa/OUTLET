/** Device-only re-rank of public results (never sent anywhere). Deterministic: ties keep the original order. */
import type { GuestState } from "./schema";

export function affinityScore(a: GuestState["affinity"], storeId: string, categoryId: string | null): number {
  return (a.stores[storeId] ?? 0) * 2 + (categoryId === null ? 0 : (a.categories[categoryId] ?? 0));
}

export function rerankByAffinity<T>(items: readonly T[], a: GuestState["affinity"], key: (t: T) => { storeId: string; categoryId: string | null }): T[] {
  return items
    .map((t, i) => ({ t, i, s: affinityScore(a, key(t).storeId, key(t).categoryId) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map((x) => x.t);
}
