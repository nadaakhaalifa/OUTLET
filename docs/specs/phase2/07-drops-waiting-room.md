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
