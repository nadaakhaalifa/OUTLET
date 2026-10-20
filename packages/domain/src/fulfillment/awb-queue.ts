/** AWB creation retry policy (spec 21 failure handling): exponential backoff with jitter, then DLQ. */
export const AWB_RETRY_POLICY = {
  baseDelayMs: 30_000,
  factor: 2,
  capDelayMs: 900_000,
  maxAttempts: 8,
} as const;

/**
 * Delay before attempt number `failedAttempts + 1`, given `failedAttempts >= 1` failures so far.
 * "Equal jitter": half the exponential delay is fixed, the other half scaled by `jitter01` in [0, 1].
 * Integer arithmetic only; the caller supplies the randomness so this stays pure.
 */
export function awbBackoffMs(failedAttempts: number, jitter01: number): number {
  const n = Math.max(1, Math.floor(failedAttempts));
  const j = Math.min(1, Math.max(0, jitter01));
  let delay: number = AWB_RETRY_POLICY.baseDelayMs;
  for (let i = 1; i < n && delay < AWB_RETRY_POLICY.capDelayMs; i += 1) delay *= AWB_RETRY_POLICY.factor;
  delay = Math.min(delay, AWB_RETRY_POLICY.capDelayMs);
  const fixed = Math.floor(delay / 2);
  return fixed + Math.floor(j * (delay - fixed));
}

export type AwbRetryDecision = "retry" | "dead_letter";

/** After a transient failure: retry until `maxAttempts` failures have happened, then dead-letter. */
export function awbRetryDecision(failedAttempts: number): AwbRetryDecision {
  return failedAttempts >= AWB_RETRY_POLICY.maxAttempts ? "dead_letter" : "retry";
}

/** Webhook timestamp window, +/- 5 minutes (spec 7 webhook rule). */
export const WEBHOOK_TOLERANCE_MS = 300_000;

export function withinWebhookTolerance(timestampMs: number, nowMs: number, toleranceMs = WEBHOOK_TOLERANCE_MS): boolean {
  return Math.abs(nowMs - timestampMs) <= toleranceMs;
}
