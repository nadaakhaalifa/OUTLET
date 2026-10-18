# Spec 07: Drops and waiting room

Refs: §16, §20.2, §T9, ADR-0005 (row-per-unit), ADR-0024 (vendor), VR-16. Phase 2.

## Flow
Seller builds a drop (type, SKUs, schedule, per-user limits). Drop types: Public, Members-only (Plus 24h early access), Flash hour, Mystery box (value range disclosed, minimum value guaranteed; lottery rules VR-09), Price ladder (published schedule), Last chance. Shopper: drop page -> at start, waiting room issues signed admission token (JWT, 15 min) -> drop PDP/checkout -> purchase within 15-min window. Waitlist for sold-out.

## Rules
- Drop state machine: `DRAFT -> SCHEDULED -> EARLY_ACCESS -> LIVE -> SOLD_OUT | ENDED -> ARCHIVED`. After `SCHEDULED` seller cannot change price or lower stock (only increase).
- Admission: Redis sorted set FIFO by arrival timestamp with per-device fairness (one active ticket per device; many tickets per account collapse to earliest). Admission rate set per drop so checkout stays inside SLO (`admit_per_sec`, autoscaled by checkout p95). Tokens single use per drop, bound to user+device, expire 15 min.
- FIFO fairness: ordering honoured within +-1% (rank inversion rate measured).
- Per-user and per-device per-SKU purchase limits; App Attest required to join; bot scoring.
- Inventory via row-per-unit pool; Redis only as "definitely sold out" pre-filter and queue. **Redis down -> waiting room fails closed (drops paused), normal checkout continues.**
- Members-only: entitlement `commerce_benefits.early_access_24h`. Fawry excluded for drop SKUs (§7).
- Truthful social proof: "N bought" and "N viewing" real events, 1-min refresh, shown only above threshold; remaining stock only real and <= 5.
- Kill switches: `drops_all`, `drop_type_<type>`, `waiting_room`, `mystery_box`.
- Price ladder: schedule published before start, server-timed; countdown rings use server time.

## Edge cases
Token replay -> reject; user leaves queue -> slot released after heartbeat TTL 30 s; clock skew -> server time; ladder step during checkout -> price-lock 10 min honours price at checkout start; drop cancelled by T&S mid-run -> orders honoured, unsold stock released; Plus lapse during early access -> re-checked at admission.

## Data
`drops(id, store_id, type, state, starts_at, early_access_at, ends_at, limits jsonb, ladder jsonb, mystery jsonb)` P0 · `drop_items(drop_id, sku_id, stock_cap, price)` P0 · `queue_tickets(id, drop_id, user_id, device_id, joined_at, state, admitted_at)` P2 (Redis primary; durable audit row on admit) · `admission_tokens(jti, drop_id, user_id, expires_at, used_at)` P2.

## API
| Endpoint | Auth | Idem | Rate |
|---|---|---|---|
| `GET /v1/drops`, `GET /v1/drops/{id}` | any | no | 60/min |
| `POST /v1/drops/{id}/queue` | shopper 18+, attest | yes | 3/min |
| `GET /v1/drops/{id}/queue/status` | owner | no | 1/s |
| `POST /v1/drops/{id}/waitlist` | shopper | yes | 5/min |
| `CRUD /v1/seller/drops` | seller staff, RLS | yes | 30/min |
| `POST /v1/admin/drops/{id}/pause` | admin T&S | yes | 30/min |

## Events
`drop.scheduled/live/sold_out/ended`, `queue.joined/admitted/abandoned`, analytics `drop_joined_queue`, `drop_admitted`.

## Failure handling
Edge waiting room vendor down -> origin-side queue fallback at reduced admit rate or pause by flag; token validation stateless (JWT) so checkout survives queue outage; sweepers idempotent; 20x load test before launch; release freeze 48h before mega events.

## Security and abuse
Bots (API6): attest, per-device limits, velocity, scoring; ticket stuffing across accounts -> device graph; token binding; seller cannot see queue users; BOLA on seller drops.

## Metrics
Sell-through, waiting-room abandonment, bot block rate, checkout success during drops >= 99%, FIFO deviation <= 1%.

## Acceptance
```
Given 50k virtual users on a 500-unit drop (k6), Then zero oversell, <= 500 claimed, FIFO within +-1%.
Given Redis down, Then drops pause and normal checkout still succeeds.
Given a SCHEDULED drop, When seller lowers stock or changes price, Then 409.
Given an expired admission token, Then checkout returns 403 and user rejoins at the back.
Given a non-Plus user during EARLY_ACCESS, Then the queue refuses with an explanation.
Given the same device with 3 accounts, Then one active ticket.
```

## Build notes
Written during the Phase 2 build (migration 0042, `packages/domain/src/drops`, `apps/api/src/modules/drops`, `apps/api/src/modules/waiting-room`).

**Algorithm choices.**
- Queue order: (a) Redis ZSET scored by arrival sequence with a Lua join/admit script, (b) per-device token buckets that interleave devices. Chosen: (a) semantics behind `QueuePort`, specified and tested as the pure `FifoWaitingQueue`. Fairness is structural (one active ticket per device, accounts collapse to the earliest) so strict FIFO is also fair; (b) would break the +-1% FIFO bound for no abuse benefit.
- Rank lookup: scanning waiting tickets is O(n) per poll (50k polls = 2.5e9); a Fenwick tree over arrival sequence gives O(log n).
- Admission token: (a) opaque random id looked up in Redis, (b) signed JWT. Chosen: HS256 JWT with `kid` rotation via `SecretPort`, because checkout must verify while Redis is down. Single use is a Postgres row (`admission_tokens.used_at`), not Redis.

**Decisions and deviations (record as ADR if the integrator agrees).**
1. Redis-down behaviour: join, status polling of waiting tickets and the admit sweeper return 503 `drops_paused` / paused; token verification, unit reservation, public drop reads and the lifecycle sweeper do not touch the queue. An already admitted shopper is served the token from Postgres.
2. `SOLD_OUT` is reached when units are CLAIMED (paid), not merely reserved. The Drop machine has no `SOLD_OUT -> LIVE` edge, so moving on reservation would strand stock released by an abandoned payment. The "definitely sold out" flag (TTL 30 s, cleared on release) is the pre-filter for reserved-out pools.
3. Admin T&S "pause" is a reversible `paused` flag, not a state. "End" uses `WINDOW_CLOSED` (EARLY_ACCESS or LIVE only). The machine has no CANCEL from a running drop, so a mid-run cancel is `end` + `closeDrop` (orders honoured, unsold pool freed).
4. Social proof "N bought today" is a trailing 24 h count (Cairo midnight shifts with DST), exposed as `bought_24h`. Defaults: show bought >= 20, viewing >= 10, remaining 1..5; recomputed at most once per minute per drop; any unavailable signal shows nothing.
5. Members-only drops must open exactly 24 h before the start (`EARLY_ACCESS_MS`), matching "Plus 24h early access".
6. Price ladder is a published list of (time, price of the first SKU); other SKUs scale by the same ratio with integer floor division, so one schedule serves many SKUs and never exceeds a published step.
7. SCHEDULED drops lock price, SKU set and schedule; stock may only rise. Anything past SCHEDULED is not editable by the seller.
8. Per-user allowance is checked then recorded after the single-use token is consumed. One token per queue pass means one in-flight request per account; a unique constraint on (drop, sku, user) is not used because a user may legitimately hold two units under `per_user = 2`.
9. "Shopper 18+" is satisfied by account creation (B6 gate); no separate age check runs on the queue route.
10. Ticket TTL release after the token window is tracked in-process by the sweeper; the Redis adapter should use key TTLs instead.

## Addendum: ops view and checkout admission (gap closure)

**GET /v1/admin/drops/ops** (admin audience, passkey; roles trust_safety, ops, super_admin; 60/min per user). Keyset cursor (invalid -> 400). One row per active drop (SCHEDULED, EARLY_ACCESS, LIVE), ordered by (starts_at, id). Values come from stored counters only: `queue_depth` from the queue backend (null when unreachable), `admitted_last_minute` and `bot_block_rate_bps` (rejected / (admitted + rejected)) from `queue_tickets` and `admission_tokens` over 60 s (`AdmissionStore.countsSince`), `waitlist_size` from the drops store. `admission_health`: unmeasured when depth is null; degraded when a live, unpaused drop has people waiting and nobody was admitted in the window; else healthy. Nothing is invented: no source means null.

**Checkout admission** (spec 16, T-LLM none). `POST /v1/checkout` accepts `admission_token`. If the bag has drop SKUs (`BagLine.dropId`), the server verifies the HS256 token (signature, drop, user, device hash, expiry) and consumes its jti exactly once (`DropAdmissionPort.redeem`, implemented by waiting-room `CheckoutDropAdmission`). Missing or no drop id or no port: 409 `admission_required` (fail closed). Invalid: 403 `admission_invalid`. Reused: 409 `admission_used`. Idempotent replay of the same key never re-consumes. Threat notes: token replay (single use), token theft (bound to user and device hash), queue outage (verification is stateless, Postgres single-use row).

**Quote `plus_savings`** (checkout): for non-members, the delivery total the order would pay (Plus waives all delivery); null for members. Server computed, never client supplied.
