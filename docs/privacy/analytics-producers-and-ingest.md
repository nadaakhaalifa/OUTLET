# Analytics server producers and client ingest (dashboard foundations track 5)

Status: built behind kill switches, default BLOCKED, synthetic data and fakes only. Enabling either switch with real users is gated by VR-DASH-03 (lawful basis, owner and counsel) and, for ingest, VR-DASH-07 (attestation with a server challenge).

## Server producers (`kill.analytics.producers`)
Written to `outbox_events` in the same transaction as the state change. Blocked: nothing is appended and the transition commits exactly as before. The flag is read once, before the transaction opens.

| Event | Where it is written | Personal data |
|---|---|---|
| `seller_order.placed` | extra fields on the existing orders event: `placed_at_ms`, `lines[{product_id, sku_id, qty}]`, `shopper_key` | `shopper_key` P2 (only with `analytics` consent, else null) |
| `order_line.purchased` | orders `place()`, one per line | `shopper_key` P2; `governorate` P1 (coarse code from the delivery snapshot, never the address); `size_label` P1 |
| `return_line.received` | returns `save()` on the RECEIVED state | `shopper_key` P2 |
| `inventory.level_changed` | inventory `claim`, `unclaim`, `applySync`, one per SKU per transaction | none (stock totals) |

Amounts are integer piastres as decimal strings. `shopper_key` = HMAC-SHA256(user id, purpose `seller-analytics`), rotated yearly. No user id, device id or IP is in any payload. Event ids are deterministic (SHA-256 of type and natural key), so a repeated transition cannot append twice.

Retention and erasure: payloads sit in `outbox_events.payload` until the `outbox.published` purge (30 days after publish) or indefinitely while unpublished; see the `outbox_events.payload` entry in `data_inventory.yaml` (H3) and track 6 `forgetShopper`.

## Client ingest (`kill.analytics.ingest`, `POST /v1/analytics/events`)
- Blocked: 503 `analytics_ingest_disabled`, nothing read or stored.
- Buyer tokens only. `X-App-Attest` and `X-Client-Platform` required, else 401 `attestation_required` (counted). The verifier is still called with an empty challenge (VR-DASH-07).
- Strict schema; keys `user_id, phone, email, address, dob, measurements, budget_*` fail the whole batch with 400 `forbidden_property`. Unknown keys or enum values fail only that event (counted).
- Consent is read from `consents_current` on every batch, uncached (M4). Not consented: 202 with all counts 0, nothing stored.
- Plausibility: per-(user, product, surface) dedupe 15 min; at most 30 impressions per user per surface per minute; `sent_at` at most 5 min ahead; `occurred_at` at most `sent_at` + 5 s and within 7 days back to 5 min ahead; duplicate positions rejected; re-sent `event_id` counted as duplicate; 600 events per user per minute. Store unavailable: 503, never accepted unchecked. Dedupe keys are HMACs, never raw ids.
- Rate limits: 60 batches per minute per (user, session), 120 per user, keyed on the verified session id, never the install id.
- Terms (M9): normalised; phone, email, URL and long digit shapes rejected; stored in clear only when every token is catalogue vocabulary (P1); any other term only as `term_hash` (keyed HMAC, P2, never released); shorter than 3 characters dropped.
- Storage: one `analytics.client_batch` outbox row per accepted batch with `shopper_key` (never a user id).
