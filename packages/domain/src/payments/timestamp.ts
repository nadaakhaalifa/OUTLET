/** Webhook freshness (spec 7: timestamp +-5 min). Both directions, so a skewed or replayed message fails. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export function withinTolerance(timestampMs: number, nowMs: number, toleranceMs: number = WEBHOOK_TOLERANCE_MS): boolean {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs)) return false;
  return Math.abs(nowMs - timestampMs) <= toleranceMs;
}
