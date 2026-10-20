import { MIN_REQUEST_GAP_MS } from "./types";

/**
 * Per-domain politeness: a slot reservation scheduler (<= 1 request per `gap` per domain), full-jitter
 * backoff and a failure circuit breaker. State is in-memory and owned by one crawler worker; the
 * durable per-domain queue lives in the application layer.
 */

export class DomainPacer {
  private readonly nextFree = new Map<string, number>();

  /** Reserve the next request slot for `domain`; returns the time (ms) the request may be sent. Strictly >= gap apart. */
  reserve(domain: string, nowMs: number, gapMs: number = MIN_REQUEST_GAP_MS): number {
    const free = this.nextFree.get(domain) ?? Number.NEGATIVE_INFINITY;
    const at = Math.max(nowMs, free);
    this.nextFree.set(domain, at + Math.max(gapMs, 0));
    return at;
  }

  /** The gap to use: the larger of our floor and the site's Crawl-delay. */
  static gapFor(crawlDelaySeconds: number | null, floorMs: number = MIN_REQUEST_GAP_MS): number {
    return Math.max(floorMs, crawlDelaySeconds === null ? 0 : Math.round(crawlDelaySeconds * 1_000));
  }
}

/** Full-jitter exponential backoff. `unit` is a caller-supplied uniform sample in [0, 1). */
export function backoffMs(attempt: number, unit: number, baseMs = 2_000, capMs = 300_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.floor(Math.min(Math.max(unit, 0), 0.999999) * exp);
}

export interface BreakerState {
  readonly failures: number;
  readonly openedAtMs: number | null;
}
export const BREAKER_CLOSED: BreakerState = { failures: 0, openedAtMs: null };
export const BREAKER_THRESHOLD = 5;
export const BREAKER_COOL_OFF_MS = 6 * 3_600_000;

export function breakerCanAttempt(s: BreakerState, nowMs: number): boolean {
  return s.openedAtMs === null || nowMs - s.openedAtMs >= BREAKER_COOL_OFF_MS;
}
export function breakerOnSuccess(): BreakerState {
  return BREAKER_CLOSED;
}
export function breakerOnFailure(s: BreakerState, nowMs: number): BreakerState {
  const failures = s.failures + 1;
  return { failures, openedAtMs: failures >= BREAKER_THRESHOLD ? nowMs : s.openedAtMs };
}
