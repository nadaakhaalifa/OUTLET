export interface Parts { readonly days: number; readonly hours: number; readonly minutes: number }

/**
 * Remaining time from a SERVER-derived offset. `serverNowAtFetchMs` is the server clock when the offset was
 * measured; `elapsedMs` is a monotonic duration since then, so a wrong device clock cannot change the result.
 * Returns null when the deadline has passed or inputs are unusable (the UI then states that honestly).
 */
export function remaining(deadlineIso: string, serverNowAtFetchMs: number | null, elapsedMs: number): Parts | null {
  const deadline = Date.parse(deadlineIso);
  if (serverNowAtFetchMs === null || Number.isNaN(deadline) || !Number.isFinite(elapsedMs)) return null;
  const ms = deadline - (serverNowAtFetchMs + elapsedMs);
  if (ms <= 0) return null;
  const totalMin = Math.floor(ms / 60_000);
  return { days: Math.floor(totalMin / 1440), hours: Math.floor((totalMin % 1440) / 60), minutes: totalMin % 60 };
}
