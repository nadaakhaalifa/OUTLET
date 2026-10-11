export type SlaLevel = "ok" | "warning" | "overdue" | "none";

export interface SlaCountdown {
  readonly level: SlaLevel;
  readonly remainingMs: number;
  readonly hours: number;
  readonly minutes: number;
}

export const SLA_WARNING_MS = 2 * 3_600_000;

/**
 * Remaining time to accept an order. `serverNowMs` is the server clock at fetch time and `elapsedSinceFetchMs`
 * comes from a monotonic timer, so a wrong device clock cannot extend or shorten the deadline.
 * Without a server time we show no countdown at all (never a guess).
 */
export function slaCountdown(input: {
  readonly deadlineIso: string | null;
  readonly serverNowMs: number | null;
  readonly elapsedSinceFetchMs: number;
}): SlaCountdown {
  const none: SlaCountdown = { level: "none", remainingMs: 0, hours: 0, minutes: 0 };
  if (input.deadlineIso === null || input.serverNowMs === null) return none;
  const deadline = Date.parse(input.deadlineIso);
  if (Number.isNaN(deadline)) return none;
  const now = input.serverNowMs + Math.max(0, input.elapsedSinceFetchMs);
  const remaining = deadline - now;
  if (remaining <= 0) return { level: "overdue", remainingMs: 0, hours: 0, minutes: 0 };
  const totalMinutes = Math.ceil(remaining / 60_000);
  return {
    level: remaining <= SLA_WARNING_MS ? "warning" : "ok",
    remainingMs: remaining,
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}
