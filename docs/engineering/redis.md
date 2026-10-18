# Redis adapters

Code: `apps/api/src/production/adapters/redis/`. Decision record: ADR-0033.

## Configuration
`REDIS_URL` (redis:// or rediss://), `REDIS_TLS`, `REDIS_KEY_PREFIX` (default `outlet:v1`), `REDIS_COMMAND_TIMEOUT_MS` (500), `REDIS_CONNECT_TIMEOUT_MS` (2000). Unset `REDIS_URL` keeps the previous bindings.

## Wiring
- `PRODUCTION_PORTS` uses `getRedisAdapters(config.redis)` for the waiting-room queue and the drops sold-out hint.
- Still to wire in `production/compose.ts` (not owned here): `rateLimiter: getRedisAdapters(config.redis)?.rateLimiter ?? new InMemoryRateLimiter()`; `createProductionFlags(redis?.flagProvider)`; add `redis.describe()` to the ready report; call `closeRedisAdapters()` on shutdown.
- Route decorators must keep OTP, checkout, drops and gift-card redemption on `RateLimit(..., "closed")` (see `LIMITER_FAILURE_POLICY`).

## Lua test strategy
ioredis-mock executes the real Lua (fengari), so the production scripts run in tests. Quirks handled in scripts: nil arrives as userdata (use `nz`), integers are 32-bit (format with `%.0f`), array replies built by index assignment are lost (return strings). Equivalence: rate limiter vs `tokenBucketReference`, queue vs the domain `FifoWaitingQueue`, both as fast-check properties. Cluster behaviour and real Lua 5.1 are not covered; run the same suite against a real Redis in staging.

## Operations
Metrics: `conn.stats.snapshot()` (command ok/error per op, breaker rejections, cache hit/miss, limiter allow/deny, degraded counters). Queue key TTL 6 h, refreshed on join; ended tickets expire after 10 min.
