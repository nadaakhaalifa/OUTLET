# Event taxonomy (spec section 26, A3 Events blocks, T6)

Status: DRAFT. Engineering proposal, not reviewed by counsel or the DPO. Nothing here is legal advice. Items tagged **VERIFY BEFORE LAUNCH** are collected in the last section and must land in `docs/compliance/verify-register.md`. No real personal data may be processed until ADR-0002 is accepted.

Source of truth in code: `packages/analytics` (`@outlet/analytics`). The tables below are generated from the catalog by `renderTaxonomyTables()`; if they disagree with the code, the code wins and this file must be regenerated.

Spec naming note: the master prompt (section 26) says the taxonomy lives at `/docs/analytics/events.md`. The task that owns this folder named it `event-taxonomy.md`. This file is that document; add a one-line `events.md` pointer if the spec path must resolve.

## 1. Two kinds of event, never mixed

| | Domain (outbox) event | Analytics event |
|---|---|---|
| Purpose | Business truth between modules (spec A2.7) | Product measurement (spec section 26) |
| Written | Same DB transaction as the state change, outbox relay, at-least-once, idempotent consumers | Client SDK or server mirror, through the consent-gated tracker |
| Name | `aggregate.action`, exactly one dot, snake_case | snake_case, no dot |
| Max PII class | P2 (only what a consumer needs), never P3 | P0 or P1 only. P2 and P3 are rejected |
| Identity | `user_id` allowed (P2) | Rotating pseudonymous id only. No user id, device id, phone, email |
| Consent | Not consent-gated: needed for the contract, security or a legal duty (`strictly_necessary`) | Gated by the purpose in the catalog, checked on every emit |
| Registry | `domainEvents` in `domain-events.ts`, versioned (`event_version`) | `analyticsEvents` in `analytics-events.ts` |

A domain event may have a pseudonymous analytics **mirror** (for example `order_group.placed` to `order_placed`). The mirror is a separate event with a separate, smaller schema: it is built from the domain event, never forwarded.

## 2. Naming convention

- Analytics event: `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`, 3 to 64 characters. Order is `object_action` where natural (`wishlist_added`, `budget_set`); spec names are kept verbatim.
- Domain event: `aggregate.action`, both sides snake_case, at most 80 characters (`order_group.placed`, `price_claim.scored`).
- Property key: snake_case, 1 to 40 characters, flat (no nesting), no camelCase.
- Forbidden tokens in any name or key (split on `_`): `email`, `phone`, `msisdn`, `password`, `otp`, `token`, `secret`, `dob`, `birth`, `name`, `address`, `street`, `lat`, `lng`, `latitude`, `longitude`, `gps`, `ip`, `photo`, `selfie`, `height`, `weight`, `bust`, `waist`, `hip`, `measurement`, `query`, `text`, `message`, `comment`, `note`, `body`, and similar (full list: `FORBIDDEN_NAME_TOKENS` in `naming.ts`). The list exists to stop PII and free text from entering through a property name. Example: the search events carry `term_char_count`, not `query_length`, because `query` is on the list.
- Money is `*_minor`: integer piastres as a decimal string (JSON has no bigint), at most 9 digits.
- Enumerations are closed `z.enum` where the spec fixes the set. Where a module spec does not exist yet, the field is a bounded `code` (`^[a-z][a-z0-9_]{0,31}$`) and is marked "proposed" in code; tighten it when the module spec lands.
- Every property schema is `z.strictObject`: an unknown key is a validation error, so a new field needs a catalog change and a review.
- Changes: adding an optional property is backward compatible. Renaming, removing or changing a type means a new `event_version` (domain) or a new event name (analytics).

## 3. PII classes and the property policy

Classes follow spec A3: P0 public, P1 internal (non-personal operational), P2 personal, P3 sensitive.

Analytics properties are enforced twice:

1. **Type level**: each catalog entry must classify every property, and only `P0`/`P1` are assignable. A P2/P3 property cannot be declared.
2. **Runtime** (`inspectProperties`, run by the tracker on every emit): rejects non-flat values, more than 32 properties, strings longer than 128 characters, arrays longer than 50, and values that look like email, phone or national-id digit runs (Arabic-Indic digits normalised first), IPv4, coordinate pairs, JWT/bearer tokens, and finite-number violations. UUIDs and ULIDs are exempt from the digit-run rule. This is defence in depth, not proof of absence of PII.

Deliberate omissions (the value is personal or can contain personal data):

- Search events record `term_char_count` and counts, never the query text.
- Budget events record a band index and a threshold percentage, never the amount.
- Fit events record a confidence or outcome, never body measurements (P3).
- Return and cancellation reasons are taxonomy codes, never free text.
- No event records an address, phone, email, precise location, IP or device identifier.

## 4. Consent purposes and gating

Purposes (spec B1): `marketing_push`, `marketing_whatsapp`, `marketing_email`, `analytics`, `personalization`, `budget_insights`, `measurements`, `location_precise`, `cross_border_ml`, plus the catalog value `strictly_necessary`.

`ConsentGatedTracker` (`tracker.ts`) rules, in order, on every call:

1. Unknown event: dropped. Event whose origin is `server` on a client tracker: dropped, even if strictly necessary.
2. Consent: the injected checker is asked for the event's purpose right now (never cached). Not granted: dropped. `strictly_necessary` is only expressible for server-origin events and needs no consent (spec section 26: strictly-necessary server events are pseudonymous).
3. Properties: strict Zod schema, then the PII policy. Failure: dropped.
4. Consent is re-checked immediately before the pseudonymous id is requested and the transport is called, so a withdrawal during validation wins.
5. Transport. Any thrown or rejected error is contained and reported as dropped. No retry and no offline buffer in this package: a dropped event is gone, so nothing can be replayed after withdrawal. If a client-side offline queue is ever added, it must be flushed or purged on withdrawal and re-checked per event (open decision, section 7).

Initialisation: the SDK transport (PostHog or other) must not be constructed before the `analytics` purpose is granted. That wiring lives in the mobile app, not in this package.

`consent_changed` is `strictly_necessary` and server-origin on purpose: a withdrawal must be recorded and must not depend on the purpose it reports.

Purpose per area: budget events need `budget_insights` (P3 financial behaviour, never shared with sellers, ads or ranking); `size_recommended` and `fit_feedback_submitted` need `measurements`; stylist events need `personalization`; general product telemetry needs `analytics`. Holding `analytics` never unlocks `budget_insights` or `measurements` (tested).

## 5. Pseudonymous identifiers (spec T6: rotated yearly)

- Format `px_` + 16 to 64 URL-safe characters.
- Client: random id from an injected generator, stored on device, **rotated when the UTC calendar year changes**; a stored epoch in the future (clock moved back) also rotates. A new id is never derived from the old one. Corrupt stored state is discarded. `reset()` is called on `analytics` withdrawal so a later grant starts a fresh id.
- Server (strictly-necessary events): `derivePseudonymousId(userKey, at, hmac)` with an injected HMAC (key in KMS in production). Same user and same year give the same id; a new year gives a new id; no mapping table is stored. The user key is never part of the output.
- The clock and the id/MAC functions are injected, so rotation is deterministic in tests.
- Pseudonymised data is still personal data under most privacy regimes: this reduces risk, it does not take the events out of scope. VERIFY BEFORE LAUNCH with the DPO.

## 6. Catalog

### 6.1 Analytics events (43)

Origin `client` events are emitted by the app and need the listed consent. Origin `server` events are emitted by the backend; those marked `strictly_necessary` are pseudonymous mirrors of committed transactions. Properties marked `?` are optional. "Retention" ids are explained in 6.3.

| Event | Owner | Origin | Purpose required | Properties | PII class per property | Retention | Spec |
|---|---|---|---|---|---|---|---|
| `app_open` | app-shell | client | `analytics` | `launch_type`, `source` | launch_type=P0, source=P0 | `analytics_25m` | §26 |
| `onboarding_step_completed` | identity | client | `analytics` | `step`, `skipped` | step=P0, skipped=P0 | `analytics_25m` | §1, §26 |
| `world_selected` | catalog | client | `personalization` | `world`, `previous_world?` | world=P1, previous_world=P1 | `analytics_25m` | §3, §26 |
| `store_viewed` | catalog | client | `analytics` | `store_id`, `world`, `source` | store_id=P1, world=P1, source=P0 | `analytics_25m` | §3, §26 |
| `product_viewed` | catalog | client | `analytics` | `product_id`, `store_id`, `source`, `position?` | product_id=P1, store_id=P1, source=P0, position=P0 | `analytics_25m` | §5, §26 |
| `filter_applied` | search | client | `analytics` | `filter_key`, `value_count`, `result_count` | filter_key=P0, value_count=P0, result_count=P0 | `analytics_25m` | §4, §26 |
| `search_performed` | search | client | `analytics` | `term_char_count`, `result_count`, `scope`, `has_filters` | term_char_count=P0, result_count=P0, scope=P1, has_filters=P0 | `analytics_25m` | §4, §26 |
| `search_no_result` | search | client | `analytics` | `term_char_count`, `scope`, `has_filters` | term_char_count=P0, scope=P1, has_filters=P0 | `analytics_25m` | §4, §26 |
| `size_recommended` | fit | server | `measurements` | `product_id`, `confidence` | product_id=P1, confidence=P1 | `analytics_25m` | §5, §10, §26 |
| `fit_feedback_submitted` | fit | client | `measurements` | `product_id`, `fit_outcome` | product_id=P1, fit_outcome=P1 | `analytics_25m` | §10, §26 |
| `stylist_outfit_generated` | stylist | server | `personalization` | `outfit_count`, `budget_used`, `latency_ms`, `model_version` | outfit_count=P0, budget_used=P1, latency_ms=P0, model_version=P0 | `analytics_25m` | §11, §26 |
| `outfit_added_to_bag` | stylist | client | `personalization` | `outfit_id`, `item_count` | outfit_id=P1, item_count=P0 | `analytics_25m` | §11, §26 |
| `stylist_feedback` | stylist | client | `personalization` | `outfit_id`, `rating` | outfit_id=P1, rating=P1 | `analytics_25m` | §11 |
| `affordability_view_opened` | budget | client | `budget_insights` | `entry_point` | entry_point=P0 | `analytics_25m` | §12, §26 |
| `budget_set` | budget | client | `budget_insights` | `budget_band_index`, `cap_enabled` | budget_band_index=P1, cap_enabled=P1 | `analytics_25m` | §12, §26 |
| `budget_warning_shown` | budget | client | `budget_insights` | `threshold_pct` | threshold_pct=P1 | `analytics_25m` | §12, §26 |
| `budget_cap_blocked_checkout` | budget | client | `budget_insights` | `bag_line_count` | bag_line_count=P0 | `analytics_25m` | §12, §26 |
| `wishlist_added` | wishlist | client | `analytics` | `product_id`, `intent` | product_id=P1, intent=P1 | `analytics_25m` | §8, §26 |
| `wishlist_alert_sent` | notifications | server | `analytics` | `alert_type`, `channel` | alert_type=P0, channel=P0 | `analytics_25m` | §8 |
| `gift_purchase_from_list` | wishlist | server | `strictly_necessary` | `wishlist_id`, `mode` | wishlist_id=P1, mode=P0 | `analytics_25m` | §8 |
| `add_to_bag` | bag | client | `analytics` | `product_id`, `sku_id`, `store_id`, `quantity`, `source` | product_id=P1, sku_id=P1, store_id=P1, quantity=P0, source=P0 | `analytics_25m` | §6, §26 |
| `free_delivery_unlocked` | bag | client | `analytics` | `store_id` | store_id=P1 | `analytics_25m` | §6, §26 |
| `checkout_started` | checkout | client | `analytics` | `bag_line_count`, `store_count`, `total_minor` | bag_line_count=P0, store_count=P0, total_minor=P1 | `analytics_25m` | §7, §26 |
| `payment_selected` | checkout | client | `analytics` | `method`, `split_tender` | method=P1, split_tender=P1 | `analytics_25m` | §7, §26 |
| `order_placed` | checkout | server | `strictly_necessary` | `order_group_id`, `seller_order_count`, `line_count`, `total_minor`, `payment_method` | order_group_id=P1, seller_order_count=P0, line_count=P0, total_minor=P1, payment_method=P1 | `analytics_25m` | §7, §26 |
| `order_delivered` | checkout | server | `strictly_necessary` | `seller_order_id`, `delivery_attempts` | seller_order_id=P1, delivery_attempts=P0 | `analytics_25m` | §21, §26 |
| `return_requested` | returns | server | `strictly_necessary` | `return_id`, `reason` | return_id=P1, reason=P1 | `analytics_25m` | §22, §26 |
| `refund_completed` | refunds | server | `strictly_necessary` | `refund_id`, `route`, `amount_minor` | refund_id=P1, route=P1, amount_minor=P1 | `analytics_25m` | §15.6, §22, §26 |
| `price_badge_viewed` | price-integrity | client | `analytics` | `product_id`, `badge_type` | product_id=P1, badge_type=P0 | `analytics_25m` | §5, §9, §26 |
| `price_reported` | price-integrity | client | `analytics` | `product_id`, `report_kind` | product_id=P1, report_kind=P0 | `analytics_25m` | §9, §26 |
| `plus_paywall_viewed` | plus | client | `analytics` | `entry_point` | entry_point=P0 | `analytics_25m` | §14, §26 |
| `plus_started` | plus | server | `strictly_necessary` | `plan`, `trial` | plan=P1, trial=P1 | `analytics_25m` | §14, §26 |
| `plus_renewed` | plus | server | `strictly_necessary` | `plan` | plan=P1 | `analytics_25m` | §14 |
| `plus_payment_failed` | plus | server | `strictly_necessary` | `attempt` | attempt=P0 | `analytics_25m` | §14 |
| `plus_cancelled` | plus | server | `strictly_necessary` | `plan`, `reason` | plan=P1, reason=P1 | `analytics_25m` | §14, §26 |
| `gift_card_purchased` | gift-cards | server | `strictly_necessary` | `amount_minor`, `group_gift` | amount_minor=P1, group_gift=P1 | `analytics_25m` | §15.1, §26 |
| `gift_card_redeemed` | gift-cards | server | `strictly_necessary` | `amount_minor` | amount_minor=P1 | `analytics_25m` | §15.1, §26 |
| `referral_shared` | referrals | client | `analytics` | `surface` | surface=P0 | `analytics_25m` | §15.4, §26 |
| `referral_converted` | referrals | server | `strictly_necessary` | `referral_id` | referral_id=P1 | `analytics_25m` | §15.4, §26 |
| `coins_earned` | rewards | server | `strictly_necessary` | `coins`, `source` | coins=P1, source=P1 | `analytics_25m` | §15.5, §26 |
| `drop_joined_queue` | drops | server | `strictly_necessary` | `drop_id`, `drop_type` | drop_id=P1, drop_type=P0 | `analytics_25m` | §16, §26 |
| `drop_admitted` | drops | server | `strictly_necessary` | `drop_id`, `wait_seconds` | drop_id=P1, wait_seconds=P0 | `analytics_25m` | §16, §26 |
| `consent_changed` | privacy | server | `strictly_necessary` | `purpose`, `granted`, `consent_version`, `method` | purpose=P1, granted=P1, consent_version=P0, method=P0 | `analytics_25m` | §B1, §26 |

Spec section 26 lists 38 names; all 38 are present. Events added from A3 Events blocks: `stylist_feedback` (section 11), `wishlist_alert_sent`, `gift_purchase_from_list` (section 8), `plus_renewed`, `plus_payment_failed` (section 14).

### 6.2 Domain (outbox) events (21)

Every domain event in a module's `Events` list is an outbox row (spec A2.7). Payload shapes are proposals: the spec names the events and a few arguments only. The `Purpose` column is the consent purpose needed to process the event: all are `strictly_necessary` because they run the contract, security or a legal duty. Using any of them for analytics or marketing needs its own purpose and goes through the tracker as a mirror.

| Event | Version | Aggregate | Owner | Payload | PII class per field | Max class | Purpose | Record retention | Analytics mirror | Spec |
|---|---|---|---|---|---|---|---|---|---|---|
| `user.registered` | 1 | user | identity | `user_id`, `auth_method`, `locale` | user_id=P2, auth_method=P1, locale=P1 | P2 | `strictly_necessary` | `account_lifetime_verify` | none | §1 |
| `user.age_blocked` | 1 | age_gate | identity | `attempt_id`, `reason` | attempt_id=P1, reason=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §1, §B6 |
| `consent.changed` | 1 | consent | privacy | `user_id`, `purpose`, `granted`, `consent_version`, `method` | user_id=P2, purpose=P1, granted=P1, consent_version=P1, method=P1 | P2 | `strictly_necessary` | `legal_proof_verify` | `consent_changed` | §1, §B1 |
| `session.revoked` | 1 | session | identity | `user_id`, `session_id`, `reason` | user_id=P2, session_id=P1, reason=P1 | P2 | `strictly_necessary` | `operational_proposed_verify` | none | §1 |
| `privacy.deletion_requested` | 1 | privacy_request | privacy | `user_id`, `request_id`, `cooling_off_ends_at` | user_id=P2, request_id=P1, cooling_off_ends_at=P1 | P2 | `strictly_necessary` | `legal_proof_verify` | none | §2 |
| `privacy.deletion_completed` | 1 | privacy_request | privacy | `request_id`, `completed_at` | request_id=P1, completed_at=P1 | P1 | `strictly_necessary` | `legal_proof_verify` | none | §2 |
| `privacy.export_ready` | 1 | privacy_request | privacy | `user_id`, `request_id`, `expires_at` | user_id=P2, request_id=P1, expires_at=P1 | P2 | `strictly_necessary` | `legal_proof_verify` | none | §2, §B1 |
| `cart.line_unavailable` | 1 | cart | bag | `user_id`, `cart_id`, `sku_id`, `reason` | user_id=P2, cart_id=P1, sku_id=P1, reason=P1 | P2 | `strictly_necessary` | `operational_proposed_verify` | none | §6 |
| `order_group.placed` | 1 | order_group | checkout | `order_group_id`, `user_id`, `seller_order_count`, `line_count`, `total_minor`, `payment_method` | order_group_id=P1, user_id=P2, seller_order_count=P1, line_count=P1, total_minor=P1, payment_method=P1 | P2 | `strictly_necessary` | `financial_tax_period_verify` | `order_placed` | §7 |
| `order_group.paid` | 1 | order_group | checkout | `order_group_id`, `total_minor`, `payment_method` | order_group_id=P1, total_minor=P1, payment_method=P1 | P1 | `strictly_necessary` | `financial_tax_period_verify` | none | §7 |
| `order_group.failed` | 1 | order_group | checkout | `order_group_id`, `failure_code` | order_group_id=P1, failure_code=P1 | P1 | `strictly_necessary` | `financial_tax_period_verify` | none | §7 |
| `inventory.reserved` | 1 | reservation | inventory | `reservation_id`, `sku_id`, `quantity`, `expires_at` | reservation_id=P1, sku_id=P1, quantity=P1, expires_at=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §7, §20.2 |
| `inventory.claimed` | 1 | reservation | inventory | `reservation_id`, `sku_id`, `quantity`, `order_group_id` | reservation_id=P1, sku_id=P1, quantity=P1, order_group_id=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §7, §20.2 |
| `inventory.released` | 1 | reservation | inventory | `reservation_id`, `sku_id`, `quantity`, `reason` | reservation_id=P1, sku_id=P1, quantity=P1, reason=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §7, §20.2 |
| `price.changed` | 1 | sku_price | price-integrity | `sku_id`, `store_id`, `price_minor`, `source` | sku_id=P1, store_id=P1, price_minor=P0, source=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §9.7 |
| `price_claim.scored` | 1 | price_claim | price-integrity | `claim_id`, `sku_id`, `trust_score`, `status` | claim_id=P1, sku_id=P1, trust_score=P1, status=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §9.7 |
| `price_enforcement.applied` | 1 | enforcement_action | price-integrity | `action_id`, `store_id`, `sku_id?`, `action` | action_id=P1, store_id=P1, sku_id=P1, action=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §9.5, §9.7 |
| `channel_snapshot.ingested` | 1 | channel_snapshot | price-integrity | `snapshot_id`, `store_id`, `channel`, `item_count` | snapshot_id=P1, store_id=P1, channel=P1, item_count=P1 | P1 | `strictly_necessary` | `operational_proposed_verify` | none | §9.7 |
| `return.received` | 1 | return | returns | `return_id`, `seller_order_id` | return_id=P1, seller_order_id=P1 | P1 | `strictly_necessary` | `financial_tax_period_verify` | none | §22 |
| `return.inspected` | 1 | return | returns | `return_id`, `result` | return_id=P1, result=P1 | P1 | `strictly_necessary` | `financial_tax_period_verify` | none | §22 |
| `refund.completed` | 1 | refund | refunds | `refund_id`, `user_id`, `order_group_id`, `route`, `amount_minor` | refund_id=P1, user_id=P2, order_group_id=P1, route=P1, amount_minor=P1 | P2 | `strictly_necessary` | `financial_tax_period_verify` | `refund_completed` | §15.6, §22 |

Names in the spec that are **not** domain events:

- `payment.succeeded` is an inbound PSP webhook (HMAC-verified, deduplicated by PSP event id), not an outbox event. It results in `order_group.paid`.
- Analytics names listed inside Events blocks (`onboarding_step_completed`, `product_viewed`, `add_to_bag`, `checkout_started`, `payment_selected`, ...) are analytics events, section 6.1.
- `return_requested(reason=size)` (section 10) is the analytics event `return_requested` with `reason` of `too_small` or `too_large`.

### 6.3 Retention ids

Outbox rows: published rows are purged after 30 days (proposed in `docs/data-model/platform.md`); the business record keeps its own retention (the "Record retention" column). Analytics events: 25 months, then aggregated (spec B1), the only fixed number in the spec.

| Retention id | Meaning | Verify before launch |
|---|---|---|
| `analytics_25m` | 25 months, then aggregated (spec §B1, §13 user_events). | no |
| `financial_tax_period_verify` | Tax-law period for orders, invoices and refunds. Spec assumes 5-7 years. VERIFY BEFORE LAUNCH. | yes |
| `account_lifetime_verify` | Lifetime of the account, then deleted or anonymised per the deletion flow (§2). VERIFY BEFORE LAUNCH. | yes |
| `legal_proof_verify` | Proof of consent or data-subject-request handling, kept for a limitation period that Legal/DPO must set. VERIFY BEFORE LAUNCH. | yes |
| `outbox_published_30d_verify` | Published outbox rows are purged after 30 days (proposed in docs/data-model/platform.md). Business truth lives in module tables under their own policy. VERIFY BEFORE LAUNCH. | yes |
| `operational_proposed_verify` | Operational record. Spec gives no period; proposed default is 25 months to align with analytics. VERIFY BEFORE LAUNCH. | yes |

## 7. Open decisions and VERIFY BEFORE LAUNCH

1. **Pseudonymisation status and DPO view.** Whether rotating pseudonymous ids still count as personal data, and whether server-side `strictly_necessary` analytics need a lawful basis other than consent (for example legitimate interest) documented in the RoPA. VERIFY BEFORE LAUNCH.
2. **Calendar-year versus rolling 365-day rotation.** Calendar year is implemented: simple and deterministic, but every user rotates at 00:00 UTC on 1 January, which creates a visible discontinuity in year-over-year cohorts. Rolling rotation needs stored issue time per user.
3. **Retention periods other than 25 months.** Tax-law period (spec assumes 5 to 7 years), account lifetime, proof-of-consent period, operational-record period and outbox 30 days are placeholders. All marked `verify: true` in `retention.ts`. VERIFY BEFORE LAUNCH.
4. **Aggregation after 25 months.** The aggregation method and its k-anonymity floor are not specified. Proposed: reuse the k >= 50 floor the spec uses for seller size demand. Needs owner confirmation.
5. **Offline buffering on device.** Not implemented. If added: purge on withdrawal, re-check consent per event at flush, and cap age.
6. **Event-to-purpose mapping for `wishlist_alert_sent` and `price_badge_viewed`.** Mapped to `analytics`; a counsel view may require `personalization` when the badge or alert is driven by a profile. Sending the alert itself is gated by the `marketing_*` purpose in the notifications module, not by this event.
7. **Cross-border transfer of analytics data.** Where the warehouse (ClickHouse) and any SDK host data decides whether a transfer licence applies. Depends on ADR-0002. VERIFY BEFORE LAUNCH.
8. **Enumerations still `code`.** `source`, `entry_point`, `badge_type`, `report_kind`, `reason` on `plus_cancelled`, `surface`, `status`, `action`, `channel` are bounded codes until the owning module specs fix the sets.
9. **Module names.** `OWNER_MODULES` follows ADR-0001 where it names a module and proposes the rest; reconcile with the backend module map.
10. **Schema registry in CI.** The spec requires one. The catalog is the registry; a CI job that diffs the catalog against the previous release (breaking-change detection) and the dbt data contracts are not built yet.
11. **No statistics.** This document contains no market statistics. Do not add funnel or conversion targets here without a verified source.
