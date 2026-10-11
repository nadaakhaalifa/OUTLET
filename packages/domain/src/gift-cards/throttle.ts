/** Redemption brute force limits (spec 15.1): 5 failures per hour per account, 20 per day per device. */
export const REDEMPTION_THROTTLE = {
  accountFailures: 5,
  accountWindowMs: 3_600_000,
  deviceFailures: 20,
  deviceWindowMs: 86_400_000,
  /** Per source address hash; looser than device because carrier NAT shares addresses. */
  ipFailures: 50,
  ipWindowMs: 86_400_000,
} as const;

export type ThrottleDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly scope: "account" | "device" | "ip"; readonly retryAfterMs: number };

interface Window {
  readonly timesMs: readonly number[];
  readonly limit: number;
  readonly windowMs: number;
}

/** Retry delay when the failures inside the sliding window already reach the limit, else null. */
function blockedFor(w: Window, nowMs: number): number | null {
  const inWindow = w.timesMs.filter((t) => t > nowMs - w.windowMs && t <= nowMs).sort((a, b) => a - b);
  if (inWindow.length < w.limit) return null;
  // the attempt becomes possible once enough old failures have slid out
  const pivot = inWindow[inWindow.length - w.limit] ?? nowMs;
  return Math.max(1, pivot + w.windowMs - nowMs);
}

/**
 * Pure. While a window is saturated every attempt, correct or not, is refused, so a guesser gains
 * nothing from a 429; the right code works again once failures slide out of the window.
 */
export function evaluateThrottle(input: {
  readonly nowMs: number;
  readonly accountFailuresMs: readonly number[];
  readonly deviceFailuresMs: readonly number[];
  readonly ipFailuresMs?: readonly number[];
}): ThrottleDecision {
  const t = REDEMPTION_THROTTLE;
  const account = blockedFor({ timesMs: input.accountFailuresMs, limit: t.accountFailures, windowMs: t.accountWindowMs }, input.nowMs);
  const device = blockedFor({ timesMs: input.deviceFailuresMs, limit: t.deviceFailures, windowMs: t.deviceWindowMs }, input.nowMs);
  if (account !== null && (device === null || account >= device)) return { allowed: false, scope: "account", retryAfterMs: account };
  if (device !== null) return { allowed: false, scope: "device", retryAfterMs: device };
  const ip = blockedFor({ timesMs: input.ipFailuresMs ?? [], limit: t.ipFailures, windowMs: t.ipWindowMs }, input.nowMs);
  if (ip !== null) return { allowed: false, scope: "ip", retryAfterMs: ip };
  return { allowed: true };
}
