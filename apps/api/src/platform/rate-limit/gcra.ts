import type { RateDecision, RateRule } from "./port.js";

/**
 * Generic Cell Rate Algorithm. State is one number per key: the theoretical arrival time (TAT, epoch ms).
 * emission = period / limit; tolerance = period, so a burst of exactly `limit` is allowed from idle and the
 * sustained rate is `limit` per `period`. Times are milliseconds (not money).
 */
const EPSILON_MS = 1e-6;

export const gcra = (tat: number | undefined, now: number, rule: RateRule): RateDecision & { readonly tat: number } => {
  const emission = rule.periodMs / rule.limit;
  const tolerance = rule.periodMs;
  const base = Math.max(tat ?? now, now);
  const next = base + emission;
  const allowAt = next - tolerance;
  // Float emission (period/limit) accumulates rounding error; a microsecond epsilon keeps the burst exactly `limit`.
  if (allowAt - now > EPSILON_MS) return { allowed: false, retryAfterMs: Math.ceil(allowAt - now), remaining: 0, tat: base };
  return { allowed: true, retryAfterMs: 0, remaining: Math.max(0, Math.floor((tolerance - (next - now)) / emission)), tat: next };
};
