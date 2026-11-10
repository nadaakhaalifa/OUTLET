export interface RateRule {
  readonly limit: number;
  readonly periodMs: number;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** 0 when allowed. */
  readonly retryAfterMs: number;
  readonly remaining: number;
}

/** One atomic GCRA step for `key`. Implementations: MemoryRateLimiter (tests, single process), RedisRateLimiter. */
export interface RateLimiterPort {
  hit(key: string, rule: RateRule): Promise<RateDecision>;
}
