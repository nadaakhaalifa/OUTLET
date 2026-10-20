/** Seller analytics are served with a <= 15 minute freshness SLO (spec 19.1). */
export const FRESHNESS_SLO_MS = 15 * 60 * 1000;

export interface Freshness {
  /** Occurred-at of the newest event applied for the store; null when none. */
  readonly asOfMs: number | null;
  readonly lagMs: number | null;
  readonly sloMs: number;
  readonly withinSlo: boolean;
}

/** Lag is measured from the store's last ingest, not from the last shopper activity. */
export function freshnessOf(lastIngestMs: number | null, asOfMs: number | null, nowMs: number): Freshness {
  if (lastIngestMs === null) return { asOfMs: null, lagMs: null, sloMs: FRESHNESS_SLO_MS, withinSlo: false };
  const lagMs = Math.max(0, nowMs - lastIngestMs);
  return { asOfMs, lagMs, sloMs: FRESHNESS_SLO_MS, withinSlo: lagMs <= FRESHNESS_SLO_MS };
}
