# ADR-0033: Redis usage and failure modes

Status: Accepted (engineering default; hosting region follows ADR-0002). Spec refs: T3, T9, section 16, A2.

## Context
Redis is allowed for caching, rate limits, the waiting-room queue, sold-out hints and flag reads. It is never a source of truth for money or stock (ledger and inventory stay in Postgres). BullMQ is not used.

## Decision
Adapters in `apps/api/src/production/adapters/redis` are bound only when `REDIS_URL` is set; otherwise bindings are unchanged.

| Use | Choice | Alternatives considered | Why |
|---|---|---|---|
| Rate limit | Token bucket in integer units, one Lua script | Fixed window; sliding log | Fixed window allows 2x burst at the boundary; sliding log costs O(limit) memory per key. Bucket is O(1), exact, float-free. |
| Queue | ZSET by arrival seq + ZSET by heartbeat, Lua per operation | Redis list; Streams | ZRANK gives O(log n) position; heartbeat expiry is a score-range scan; Lua gives atomic admit with no duplicates. |
| Flags | One hash, local 5 s TTL cache | Per-key GET | One round trip refreshes all flags. |

Failure modes:
- Rate limiter throws `RedisUnavailableError`; the existing guard applies each route's `onLimiterError`. Policy: auth OTP, checkout, drops, gift-card redemption = closed (503); plain reads = open.
- Queue throws `QueueUnavailableError`: the waiting room fails closed (drops paused). Normal checkout does not touch Redis.
- Sold-out hint: any failure means "not known sold out"; Postgres reserve decides.
- Cache: any failure calls the loader.
- Flags: Redis unreachable and local cache older than TTL gives PROVIDER_NOT_READY, so FlagClient returns the registry default (false = blocked). Polarity unchanged (ADR-0028).
- A circuit breaker (3 failures, 1 s open) makes outages fail fast.
- `/v1/ready` reports Redis as informational (`configured_reachable|configured_unreachable`) and never gates readiness.

Keys hold hashed user, device, drop and token ids only. Ticket hashes hold the raw user id as a value (needed by the port) with a TTL.

## Consequences
Lua scripts return strings (fields joined by US 0x1f, rows by RS 0x1e) and avoid number concatenation; this also keeps them runnable under ioredis-mock. Cluster: all keys of a drop share the `{dropId}` hash tag. Expiry discovered during `admit` is reported by the next `expire()` (the pure domain queue drops it).
