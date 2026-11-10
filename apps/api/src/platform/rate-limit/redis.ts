import { z } from "zod";
import { CircuitBreaker, withTimeout } from "../outbound.js";
import type { RateDecision, RateLimiterPort, RateRule } from "./port.js";

/**
 * Atomic GCRA in one EVAL. Uses the Redis server clock (TIME) so all API instances agree; the TAT is stored with a
 * PX expiry equal to how far it is in the future, so idle keys disappear on their own.
 * KEYS[1] = key; ARGV[1] = emission ms; ARGV[2] = tolerance ms. Returns {allowed 0/1, retry_after_ms, remaining}.
 */
export const GCRA_LUA = `
local emission = tonumber(ARGV[1])
local tolerance = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tat = tonumber(redis.call('GET', KEYS[1]))
if tat == nil or tat < now then tat = now end
local nxt = tat + emission
local allow_at = nxt - tolerance
if allow_at - now > 0.000001 then
  return {0, math.ceil(allow_at - now), 0}
end
redis.call('SET', KEYS[1], string.format('%.3f', nxt), 'PX', math.max(1, math.ceil(nxt - now)))
return {1, 0, math.max(0, math.floor((tolerance - (nxt - now)) / emission))}
`;

/** The subset of ioredis used here, so tests can pass a stub. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const Reply = z.tuple([z.number().int(), z.number().int().nonnegative(), z.number().int().nonnegative()]);

export class RedisRateLimiter implements RateLimiterPort {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly redis: RedisEval,
    private readonly opts: { readonly timeoutMs?: number; readonly prefix?: string; readonly breaker?: CircuitBreaker } = {},
  ) {
    this.breaker = opts.breaker ?? new CircuitBreaker({ label: "redis.rate-limit" });
  }

  async hit(key: string, rule: RateRule): Promise<RateDecision> {
    const emission = rule.periodMs / rule.limit;
    const raw = await this.breaker.call(() =>
      withTimeout("redis.rate-limit", this.opts.timeoutMs ?? 50, () => this.redis.eval(GCRA_LUA, 1, `${this.opts.prefix ?? "rl:"}${key}`, emission, rule.periodMs)),
    );
    const [allowed, retryAfterMs, remaining] = Reply.parse(raw);
    return { allowed: allowed === 1, retryAfterMs, remaining };
  }
}
