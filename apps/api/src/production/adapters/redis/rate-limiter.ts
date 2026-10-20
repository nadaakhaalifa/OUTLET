import type { RateLimitOutcome, RateLimitRule, RateLimiter } from "../../../platform/ports";
import { RedisUnavailableError, type RedisConnection } from "./connection";

/**
 * Token bucket in integer "units": capacity = limit * windowMs, refill = `limit` units per ms,
 * one request costs `windowMs` units. No floats, so the Lua script and the TS reference agree
 * exactly. A bucket refills fully after `windowMs` idle, which is also its key TTL.
 */
export interface BucketState {
  readonly units: number;
  readonly ts: number;
}

export function tokenBucketReference(
  prev: BucketState | null,
  nowMs: number,
  rule: RateLimitRule,
): { readonly state: BucketState; readonly outcome: RateLimitOutcome } {
  const { limit, windowMs } = rule;
  const cap = limit * windowMs;
  let units = prev === null ? cap : prev.units;
  let now = nowMs;
  if (prev !== null && now < prev.ts) now = prev.ts; // clock skew between app instances never rewinds the bucket
  if (prev !== null) units = Math.min(cap, units + (now - prev.ts) * limit);
  const allowed = units >= windowMs;
  if (allowed) units -= windowMs;
  const need = allowed ? cap - units : windowMs - units;
  return {
    state: { units, ts: now },
    outcome: { allowed, limit, remaining: Math.floor(units / windowMs), resetAtMs: now + Math.ceil(need / limit) },
  };
}

export const RATE_LIMIT_LUA = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local win = tonumber(ARGV[3])
local cap = limit * win
local h = redis.call('HMGET', KEYS[1], 'u', 't')
local units = tonumber(h[1])
local ts = tonumber(h[2])
if units == nil or ts == nil then
  units = cap
  ts = now
end
if now < ts then now = ts end
units = math.min(cap, units + (now - ts) * limit)
local allowed = 0
if units >= win then
  units = units - win
  allowed = 1
end
redis.call('HSET', KEYS[1], 'u', string.format('%.0f', units), 't', string.format('%.0f', now))
redis.call('PEXPIRE', KEYS[1], win)
local need = win - units
if allowed == 1 then need = cap - units end
local resetAt = now + math.ceil(need / limit)
return {allowed, math.floor(units / win), string.format('%.0f', resetAt)}
`;

/**
 * Failure policy per route class. The guard already honours RateLimit(..., "closed" | "open") per
 * route; this table is the reviewed source of truth that route decorators and a test assert against.
 */
export const LIMITER_FAILURE_POLICY = {
  auth_otp: "closed",
  checkout: "closed",
  drops: "closed",
  gift_card_redemption: "closed",
  read: "open",
} as const;
export type RouteClass = keyof typeof LIMITER_FAILURE_POLICY;

/**
 * Distributed limiter. Keys arrive hashed from the guard (`rl:v1:<sha256>`); the adapter only adds
 * the deployment prefix. On any Redis failure it throws RedisUnavailableError and the guard applies the
 * route's own policy (503 for closed routes, allow for open routes).
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly run;
  constructor(private readonly conn: RedisConnection) {
    this.run = conn.script("rate_limit", RATE_LIMIT_LUA, 1);
  }

  async consume(key: string, rule: RateLimitRule, nowMs: number): Promise<RateLimitOutcome> {
    if (!Number.isInteger(rule.limit) || rule.limit < 1 || !Number.isInteger(rule.windowMs) || rule.windowMs < 1) {
      throw new RangeError("rate limit rule must have positive integer limit and windowMs");
    }
    const raw = await this.run([this.conn.key("rl", key)], [Math.trunc(nowMs), rule.limit, rule.windowMs]);
    if (!Array.isArray(raw) || raw.length !== 3) throw new RedisUnavailableError("command", new Error("bad limiter reply"));
    const [allowed, remaining, resetAt] = raw as [unknown, unknown, unknown];
    const outcome: RateLimitOutcome = {
      allowed: Number(allowed) === 1,
      limit: rule.limit,
      remaining: Number(remaining),
      resetAtMs: Number(resetAt),
    };
    this.conn.stats.inc(outcome.allowed ? "ratelimit.allowed" : "ratelimit.denied");
    return outcome;
  }
}
