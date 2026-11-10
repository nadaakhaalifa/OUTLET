# @outlet/pricing-integrity

Price Watch, step P1-03a: internal price evidence only (external channels and the crawler are P1-03b+). Migration `0012_price_events.sql`.

- `domain/`: `computeWindow`, `vrpFromInternal`, `discountPct` (integer floor on minor units), `claimAllowed` (>= 5%), `displayDecision` (brand mode public / member_only / hidden).
- `application/`: `PriceEventIngestor` (consumes `price.changed` through the inbox, closes the open row and opens a new one in one tx, refreshes `sku_price_windows`), `PriceSnapshotService.snapshotForOrderLine`, `PriceEvidencePublic.get`.
- Reference rule: lowest price in the 30 days before the FIRST reduction of the current run of decreases; only with >= 30 days of history before that reduction and a run that started within the last 30 days. A price that went back up ends the run (reference resets). Launch items (< 30 days) never get a percentage.
- Kill switch `pricing.price_watch` (register it in `@outlet/flags` as a money-class, fail-closed switch): killed or unreadable means plain prices everywhere; ingestion keeps recording evidence.
- `sku_price_windows` is a maintained table (one targeted upsert per event), not a materialized view. Its low is exact as of `updated_at`; shopper-facing reads recompute from events at `now`.

## Price Watch review fixes (chief-reviewer pass; two-key area)

- Findings resolve only when their rule was **evaluated** in the pass (a re-score without a rule's inputs cannot absolve it). The seller's "was" price is persisted in `sku_claimed_reference`; `claimedReferenceMinor: undefined` loads it, a bigint stores it, `null` clears it. Stale external evidence never creates a `fake_reference`.
- External evidence is currency-pinned (`channel_snapshots.currency = history currency`); ingest drops items outside `marketCurrencies` (default `["EGP"]`). A matched product left with no same-currency evidence is stale (fail closed), not "no evidence".
- Claims carry `valid_until` = the earliest `last fetch + 72 h` of the matches they relied on. `ClaimScorer.resweepExpiredClaims(now)` re-scores expired claims; `readLiveClaim` (used by `PriceEvidencePublic` and `PriceSnapshotService`) treats `valid_until < now` as plain at once. A scored claim can only tighten the internal reference.
- Per connection: a disconnected/revoked channel behind a match raises `channel_disconnected` even if another channel is active; a `failed` channel (unsafe target, or 3 failed runs of 3 backed-off attempts each) is stale evidence immediately; failed connections are retried and recover to `active`.
- `product_matches`: a trigger lets `outlet_app` change status only from `needs_confirmation` to `seller_confirmed|rejected`; a rejected sub-tau match is re-proposed when new evidence reaches tau.
- Politeness: `DomainRateLimiterPort` (in-memory `DomainRateLimiter`; `SharedDomainRateLimiter` over a `SlotStore` for a Redis Lua adapter, `InMemorySlotStore` as the fake) is reserved before EVERY HTTP call (retries, redirect hops); robots.txt is checked per hop path via `safeFetch`'s `gate`. SSRF also blocks 2002::/16, 2001::/32, 100::/64. **Adapter contract:** a `ChannelFetchPort` implementation must connect to `req.address` (never re-resolve) and send `Host` from `req.url`.
- Appeals: keys are unique per `(store, key)`; reuse for a different finding is a `WatchError("invalid")` (422), never a database error. `AppealService.processOpsDecision(adminActor, appealId, decision)` settles `ops_queue` appeals (finding `upheld`/back to `open`, pending suspension lifted/confirmed, `decided_by` stored). Authorizing the admin is the caller's guard.
- Detectors `duplicate_reset` and `image_reuse` run behind `ListingFingerprintPort` (info findings, no auto-enforcement); `risk_tier` follows `riskTierOf(trust)`; `liftExpiredActions(now)` expires time-boxed sanctions and re-scores what they hid; a suspension emits `payouts.hold_requested` (payload for the payouts module to consume).

### ADR-lite: ladder defaults (V15 counsel, V28 owner)

| Parameter | Default | Why |
|---|---|---|
| `repeatThreshold` | 6 violations in 90 days | Suspension (with human review within 5 business days) needs a repeat pattern well past the 3-violation sanction step; 6 avoids suspending on a few honest mistakes. Proposed default, not legal advice. |
| `sanctionThreshold` / `sanctionDays` | 3 violations / 30 days | `lose_verified`, `commission_surcharge`, `block_drops` expire after 30 days and are lifted by `liftExpiredActions`. |
| Parity grace (`PARITY_GRACE_MS`) | 48 h | Master 9.3: demote at once, auto-pause after 48 h unfixed. |

Both remain defaults until counsel (V15) and the owner (V28) confirm; changing them is a parameter change (`LadderParams`), not a code change.

### Not built
- Ghost-discount and stock-mismatch detectors (channel shows the item out of stock or the discount absent while we advertise it).
- The pre-publish check (moment A, spec 2.2): the scorer only runs after a price exists.
- `duplicate_reset` history inheritance (the detector reports `inheritsFrom`; nothing copies the history).
- Redis adapter for `SlotStore`; the in-memory limiter is per process.
- Public claim reads under `outlet_app` without a store context: `price_claims` only has store-isolation policies (0026), so `PriceSnapshotService.snapshotForOrderLine` and `PriceEvidencePublic.get` see no scored claim from the shopper request path and cannot tighten or withdraw the reference. Tests pass on a superuser client only. Before composing either in apps/api, add a `price_claims__app_public_read` policy (status in ('active','withdrawn'), columns: sku_id, market_id, status, reference_minor, evidence kind) or move the read into the catalog public read model built by the worker. Found 2026-11-08 by the coverage tester.
