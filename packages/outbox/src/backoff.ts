import { InvalidConfigError } from './errors.js';
import type { Random } from './ports.js';

export interface BackoffConfig {
  readonly baseMs: number;
  readonly capMs: number;
}

export function assertBackoffConfig(c: BackoffConfig): void {
  if (!Number.isInteger(c.baseMs) || c.baseMs < 1) throw new InvalidConfigError('baseMs must be an integer >= 1');
  if (!Number.isInteger(c.capMs) || c.capMs < c.baseMs) throw new InvalidConfigError('capMs must be >= baseMs');
}

/**
 * Exponential backoff with "equal jitter": the ceiling is
 * min(cap, base * 2^(attempt-1)); the delay is half the ceiling plus a random
 * share of the other half. Always in [ceiling/2, ceiling], so retries never
 * collapse to zero and never synchronise. `attempt` is 1-based (the attempt
 * that just failed). Randomness is injected.
 */
export function computeBackoffMs(attempt: number, config: BackoffConfig, random: Random): number {
  assertBackoffConfig(config);
  if (!Number.isInteger(attempt) || attempt < 1) throw new InvalidConfigError('attempt must be an integer >= 1');
  const exponent = Math.min(attempt - 1, 52);
  const ceiling = Math.min(config.capMs, config.baseMs * 2 ** exponent);
  const r = random();
  if (!(r >= 0 && r < 1)) throw new InvalidConfigError('random must return a value in [0, 1)');
  const half = Math.floor(ceiling / 2);
  return half + Math.floor(r * (ceiling - half + 1));
}
