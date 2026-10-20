export interface CourierCandidate {
  readonly code: string;
  readonly coversGovernorate: boolean;
  /** Circuit closed and not under the kill switch. */
  readonly available: boolean;
  readonly costPiastres: bigint;
  /** p80 historical transit, hours, for the destination governorate. Null when unknown. */
  readonly p80TransitHours: number | null;
  readonly isDefault: boolean;
}

export type CourierChoice =
  | { readonly kind: "chosen"; readonly code: string; readonly reason: "seller_preference" | "default" | "failover" | "cheapest" }
  | { readonly kind: "none"; readonly reason: "not_covered" | "all_unavailable" };

/**
 * Courier choice. Bosta is the default and Aramex the failover (spec 09 part A). Order: seller
 * preference if usable, the default if usable, else the cheapest usable (ties: lower p80, then code).
 * Unknown p80 sorts last so a courier without history never wins a tie on speed alone.
 */
export function chooseCourier(candidates: readonly CourierCandidate[], sellerPreference: string | null): CourierChoice {
  const covering = candidates.filter((c) => c.coversGovernorate);
  if (covering.length === 0) return { kind: "none", reason: "not_covered" };
  const usable = covering.filter((c) => c.available);
  if (usable.length === 0) return { kind: "none", reason: "all_unavailable" };
  const pref = usable.find((c) => c.code === sellerPreference);
  if (pref !== undefined) return { kind: "chosen", code: pref.code, reason: "seller_preference" };
  const def = usable.find((c) => c.isDefault);
  if (def !== undefined) return { kind: "chosen", code: def.code, reason: "default" };
  const sorted = [...usable].sort((a, b) => {
    if (a.costPiastres !== b.costPiastres) return a.costPiastres < b.costPiastres ? -1 : 1;
    const pa = a.p80TransitHours ?? Number.POSITIVE_INFINITY;
    const pb = b.p80TransitHours ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  const first = sorted[0];
  if (first === undefined) return { kind: "none", reason: "all_unavailable" };
  const failover = covering.some((c) => c.isDefault);
  return { kind: "chosen", code: first.code, reason: failover ? "failover" : "cheapest" };
}

/** Nearest-rank 80th percentile of observed transit hours; null with no samples. */
export function p80(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.8 * sorted.length);
  return sorted[rank - 1] ?? null;
}
