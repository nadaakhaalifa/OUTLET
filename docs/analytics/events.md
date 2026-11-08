# Analytics event taxonomy (Outlex, web MVP)

Status: draft for Phase 0. Source: master prompt section 26 (read HAUL as Outlex), the vision addendum and the specs. Zod schemas will live in `packages/analytics` and this file will be generated from them later. Until then, this file is the spec.

## 1. Rules

1. **Names.** `snake_case`, past tense, `object_action`. Example: `product_viewed`. No spaces, no dots. One name, one meaning.
2. **Versions.** Each event has an integer `schema_version`. Adding an optional property is not a new version. Removing or changing a property is. Old versions are readable for 25 months.
3. **Properties.** Flat, `snake_case`, typed (Zod). No nested free text. Enums are closed lists.
4. **No PII, ever.** Never send phone, email, name, address, date of birth, body measurements, budget amounts, IBAN, card data, raw search text over the length limit, or free-text notes. Send ids, bands and counts. Search events carry `term_char_count`, not the term (a separate redacted query log exists for demand gaps, see section 7). Money is integer piastres plus currency.
5. **Truthful.** Events record what really happened. A counter shown to shoppers (for example "bought today") is computed from these events, never invented.
6. **Consent first.** The analytics SDK starts only after the shopper accepts the `analytics` purpose. Before that, only strictly necessary events are sent (section 3).
7. **Schema registry in CI.** An event not in the registry, or with an unknown property, fails the build and is dropped by the ingest API.
8. **Owner.** Each event has an owning module. Changes need that owner's review.
9. **Retention.** Raw events 25 months, then aggregated (master prompt B1).
10. **Separate from domain events.** Analytics events are lossy and consent-gated. Outbox domain events (section 6) are exact and never used for marketing.

## 2. Common envelope

Every event carries these fields. The client fills what it knows; the server adds the rest.

| Field | Type | Notes |
|---|---|---|
| `event_id` | UUIDv7 | Made on the client (or server for server events). Used to deduplicate. |
| `event_name` | string | From the registry. |
| `schema_version` | int | |
| `occurred_at` | timestamp, UTC (ISO 8601) | Client clock; server also stores `received_at`. Large skew is flagged. |
| `market_id` | string | ISO code, for example `EG` (the URL uses lower-case `eg`). Present from day one (ADR-0006). |
| `locale` | `ar-EG` or `en` | UI language at the time. |
| `direction` | `rtl` or `ltr` | Optional, for layout analysis. |
| `actor_id` | string | Pseudonymous id. Logged-out: random id kept in a first-party cookie, only after consent. Logged-in: a keyed hash of the user id, rotated yearly. Never the raw user id, never phone or email. |
| `session_id` | UUIDv7 | New per visit. |
| `consent_state` | object | `{analytics, personalization, marketing_*}` booleans and `consent_version` at send time. |
| `app_version` | string | Web build id (git sha short). Apps add `platform` later. |
| `platform` | `web` | `ios` and `android` from Phase 2. |
| `surface` | enum | `shopper_web`, `seller_center`, `admin_console`, `server`. |
| `route` | string | Path template, without ids or query text (for example `/store/:slug`). |
| `experiment_ids` | string[] | Optional. |

The server adds `country_code` (from IP, then the IP is dropped) and `bot_score`. IP address is never stored with events.

## 3. Consent classes

| Class | Meaning | Rule |
|---|---|---|
| `necessary` | Needed to run the service or required by law: orders, payments, returns, refunds, security, audit. | Sent without consent. Pseudonymous. Not used for marketing or ads. |
| `analytics` | Product analytics: views, clicks, funnels, search. | Only after the `analytics` consent. |
| `personalization` | Used to personalise feeds or "My Size". | Only after the `personalization` consent. |
| `marketing` | Used for campaigns, retargeting, attribution. | Only after the matching `marketing_*` consent. No budget or defect-sensitive data. |
| `measurements` | Fit or size inputs. | Only after the `measurements` consent. Fashion only. |

Budget data is never an analytics property (master prompt section 12). Budget events carry a band index only, and only with `budget_insights` consent.

## 4. Phase 1 web MVP events

Surface: S = shopper web, C = Seller Center, A = Admin. Class: N = necessary, An = analytics, P = personalization, M = marketing.

### 4.1 App and onboarding

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `app_opened` | S, C, A | An | `launch_type` (cold, warm, pwa), `source` (direct, search_engine, social, whatsapp, referral, ad) | app-shell |
| `consent_changed` | S | N | `purpose`, `granted`, `method`, `consent_version` | privacy |
| `onboarding_step_completed` | S | An | `step`, `skipped` | identity |
| `age_gate_result` | S | N | `result` (passed, blocked) (no DOB) | identity |
| `language_changed` | S | An | `to_locale` | app-shell |
| `market_selected` | S | An | `market_id` | catalog |

### 4.2 Village, store, shelf, discover deals

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `village_viewed` | S | An | `source` | catalog |
| `store_carousel_moved` | S | An | `method` (swipe, arrow, key), `direction` | catalog |
| `category_chip_selected` | S | An | `category_id`, `surface_area` (village, store, deals) | catalog |
| `store_viewed` | S | An | `store_id`, `source` (village, search, deal_tile, link), `position?` | catalog |
| `store_followed` | S | An | `store_id` | catalog |
| `store_unfollowed` | S | An | `store_id` | catalog |
| `shelf_row_scrolled` | S | An | `store_id`, `row_index`, `method` | catalog |
| `quick_view_opened` | S | An | `product_id`, `store_id`, `source` (shelf, deal_tile, search) | catalog |
| `discover_deals_viewed` | S | An | `source` | catalog |
| `discount_band_viewed` | S | An | `band` (70_60, 59_50, 49_40, launch_price), `verified_only` (always true) | price-integrity |
| `deals_sort_changed` | S | An | `sort` | catalog |
| `drop_hour_viewed` | S | An | `drop_id`, `phase` (before, live, after) | drops |
| `drop_reminder_set` | S | An | `drop_id`, `channel` | drops |
| `outlet_party_viewed` | S | An | `party_id` | drops |

### 4.3 Product, defect passport, price proof

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `product_viewed` | S | An | `product_id`, `store_id`, `category_id`, `condition_grade`, `source`, `position?` | catalog |
| `condition_grade_viewed` | S | An | `product_id`, `condition_grade` | catalog |
| `defect_passport_viewed` | S | An | `product_id`, `defect_count`, `via_qr` (bool) | defect-lab |
| `defect_hotspot_opened` | S | An | `product_id`, `defect_type` | defect-lab |
| `defect_ack_checked` | S | N | `product_id`, `defect_count` (the "I have seen the N defects" box) | defect-lab |
| `price_badge_viewed` | S | An | `product_id`, `badge_type` (verified_discount, lowest_30d, launch_price, none) | price-integrity |
| `price_proof_viewed` | S | An | `product_id`, `badge_type`, `evidence_count` | price-integrity |
| `price_reported` | S | An | `product_id`, `report_kind` | price-integrity |
| `size_recommended` | server | measurements | `product_id`, `confidence` (fashion only) | fit |
| `fit_feedback_submitted` | S | measurements | `product_id`, `fit_outcome` | fit |
| `product_shared` | S | An | `product_id`, `channel` | catalog |
| `restock_alert_set` | S | An | `product_id`, `kind` (restock, price_drop) | catalog |

### 4.4 Search and filters

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `search_performed` | S | An | `term_char_count`, `result_count`, `scope`, `has_filters`, `script` (ar, en, mixed, franco) | search |
| `search_no_result` | S | An | `term_char_count`, `scope`, `has_filters` | search |
| `search_suggestion_tapped` | S | An | `kind` (query, store, category), `position` | search |
| `filter_sheet_opened` | S | An | `surface_area` | search |
| `filter_applied` | S | An | `filter_key`, `value_count`, `result_count`, `surface_area?` | search |
| `filter_chip_removed` | S | An | `filter_key` | search |
| `filter_reset` | S | An | `surface_area` | search |
| `saved_search_created` | S | An | `alert_enabled` | search |

Filter keys include `condition`, `discount_band`, `price_band`, `delivery_speed`, `ships_from` (local, global, both), `store`, `category`.

### 4.5 Bag

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `add_to_bag` | S | An | `product_id`, `sku_id`, `store_id`, `quantity`, `source` (shelf, quick_view, pdp, deal_tile) | bag |
| `bag_viewed` | S | An | `line_count`, `store_count` | bag |
| `bag_line_removed` | S | An | `sku_id`, `reason?` | bag |
| `free_delivery_unlocked` | S | An | `store_id` | bag |
| `wishlist_added` | S | An | `product_id`, `intent` | wishlist |
| `wishlist_shared` | S | An | `intent` | wishlist |

### 4.6 Checkout, payment, order

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `checkout_started` | S | An | `bag_line_count`, `store_count`, `total_minor`, `currency` | checkout |
| `checkout_step_viewed` | S | An | `step` (address, delivery, payment, review), `store_count` | checkout |
| `checkout_step_completed` | S | An | `step`, `ms_on_step` | checkout |
| `payment_selected` | S | An | `method` (card, wallet, instapay, fawry, cod, bnpl, store_credit), `split_tender` | checkout |
| `payment_failed` | S | N | `method`, `failure_class` (declined, timeout, abandoned, 3ds_failed) | payments |
| `cod_confirmation_result` | S | N | `result` (confirmed, no_answer, cancelled) | fraud |
| `order_placed` | server | N | `order_group_id`, `seller_order_count`, `line_count`, `total_minor`, `currency`, `payment_method` | checkout |
| `order_paid` | server | N | `order_group_id`, `payment_method`, `ms_to_confirm` | payments |
| `order_shipped` | server | N | `seller_order_id`, `courier` | fulfillment |
| `order_delivered` | server | N | `seller_order_id`, `delivery_attempts` | fulfillment |
| `order_cancelled` | server | N | `seller_order_id`, `by` (shopper, seller, system), `reason` | orders |
| `delivery_failed` | server | N | `seller_order_id`, `reason` | fulfillment |
| `savings_summary_viewed` | S | An | `order_group_id` (the "You saved X" line, verified savings only) | checkout |

### 4.7 Returns and refunds

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `return_requested` | server | N | `return_id`, `reason`, `condition_grade`, `defect_disclosed` (bool) | returns |
| `return_inspected` | server | N | `return_id`, `result` | returns |
| `dispute_opened` | server | N | `return_id`, `reason` | returns |
| `refund_completed` | server | N | `refund_id`, `route`, `amount_minor`, `currency` | refunds |

### 4.8 Price Watch (seller and system)

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `channel_connect_started` | C | An | `channel_type` (shopify, woo, website, sheet) | price-integrity |
| `channel_connect_completed` | C | An | `channel_type`, `ms_taken` | price-integrity |
| `prepublish_check_result` | C | An | `result` (pass, price_blocked, evidence_missing), `claim_type` | price-integrity |
| `price_claim_scored` | server | N | `claim_id`, `trust_band`, `claim_allowed` | price-integrity |
| `price_enforcement_applied` | server | N | `store_id`, `action` | price-integrity |
| `price_claim_appealed` | C | N | `claim_id` | price-integrity |

### 4.9 Seller wizard and Seller Center

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `seller_signup_started` | C | An | `source` | sellers |
| `seller_kyc_step_completed` | C | N | `step`, `status` | sellers |
| `seller_kyc_decided` | server | N | `result` (approved, needs_info, rejected) | sellers |
| `product_wizard_step_viewed` | C | An | `step` (photos, details, price_stock, review) | catalog |
| `product_wizard_step_completed` | C | An | `step`, `ms_on_step` | catalog |
| `product_wizard_photo_added` | C | An | `slot` (main, defect, packaging, video) | catalog |
| `product_wizard_blocked` | C | An | `reason` (missing_defect_photo, missing_condition, price_check) | catalog |
| `product_draft_saved` | C | An | `step` | catalog |
| `product_published` | server | N | `product_id`, `store_id`, `condition_grade`, `defect_count`, `has_size_chart?` | catalog |
| `listing_copilot_used` | C | An | `feature` (title, description, category), `accepted` | catalog |
| `store_design_updated` | C | An | `section` | sellers |
| `shipment_created` | C | N | `seller_order_id`, `courier` | fulfillment |
| `order_accepted` | server | N | `seller_order_id`, `ms_to_accept` | orders |
| `payout_status_changed` | server | N | `payout_id`, `status` | payouts |

### 4.10 Admin Console

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `admin_action_performed` | A | N | `action_code`, `target_type`, `reason_code?` (also written to the audit log) | admin |
| `admin_pii_viewed` | A | N | `target_type`, `reason_code` | admin |
| `admin_approval_decided` | A | N | `approval_type`, `decision` | admin |
| `feature_flag_changed` | A | N | `flag_key`, `to_state` | admin |
| `kill_switch_toggled` | A | N | `switch_key`, `to_state` | admin |

### 4.11 Notifications and growth

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `notification_sent` | server | N (transactional) or M | `kind`, `channel`, `transactional` (bool) | notifications |
| `notification_clicked` | S | M | `kind`, `channel` | notifications |
| `whatsapp_pay_link_opened` | S | An | `link_kind` | checkout |
| `referral_shared` | S | An | `channel` | referrals |
| `referral_converted` | server | N | `referral_id` | referrals |
| `coins_earned` | server | N | `source`, `amount_coins` | rewards |

### 4.12 Master prompt section 26 list, adapted

The section 26 list is covered as follows. Names that changed are shown.

| Section 26 name | Status here |
|---|---|
| `app_open` | Renamed `app_opened` (past tense) |
| `onboarding_step_completed` | Kept |
| `world_selected` | Replaced by `market_selected` and the Local/Global/Both filter (`filter_applied` with `ships_from`). Kept as a V2 name for apps |
| `store_viewed`, `product_viewed`, `filter_applied`, `search_performed`, `search_no_result` | Kept |
| `size_recommended`, `fit_feedback_submitted` | Kept (fashion only, `measurements` consent) |
| `stylist_outfit_generated`, `outfit_added_to_bag` | Phase 2 |
| `affordability_view_opened`, `budget_set`, `budget_warning_shown`, `budget_cap_blocked_checkout` | Phase 2. Bands only, `budget_insights` consent |
| `wishlist_added(intent)`, `add_to_bag`, `free_delivery_unlocked`, `checkout_started`, `payment_selected` | Kept |
| `order_placed`, `order_delivered`, `return_requested`, `refund_completed` | Kept |
| `price_badge_viewed`, `price_reported` | Kept |
| `plus_paywall_viewed`, `plus_started`, `plus_cancelled` | Phase 2 (Plus is not in the web MVP) |
| `gift_card_purchased`, `gift_card_redeemed` | Phase 2 |
| `referral_shared`, `referral_converted`, `coins_earned` | Kept |
| `drop_joined_queue`, `drop_admitted` | Kept as Drop Hour admission events (see 5) |
| `consent_changed` | Kept |

## 5. Phase 1 additions for Drop Hour admission

| Event | Surface | Class | Properties | Owner |
|---|---|---|---|---|
| `drop_joined_queue` | S | An | `drop_id` | drops |
| `drop_admitted` | S | An | `drop_id`, `wait_ms` | drops |
| `drop_sold_out_seen` | S | An | `drop_id`, `sku_id` | drops |

## 6. Outbox domain events (not analytics)

These are written in the same transaction as the state change, relayed at least once, and consumed idempotently (`inbox_processed`). They carry ids and exact amounts. They are internal. They are not sent to the browser and they ignore analytics consent (they are the system of record). Each carries `event_id`, `occurred_at`, `market_id`, `aggregate_id`, `schema_version`.

| Module | Events |
|---|---|
| identity | `user.registered`, `user.age_blocked`, `session.revoked` |
| privacy | `consent.changed`, `privacy.deletion_requested`, `privacy.deletion_completed`, `privacy.export_ready` |
| catalog | `product.published`, `product.updated`, `product.paused`, `store.status_changed` |
| price-integrity | `price.changed`, `price_claim.scored`, `price_enforcement.applied`, `channel_snapshot.ingested` |
| inventory | `inventory.reserved`, `inventory.claimed`, `inventory.released`, `inventory.adjusted` |
| checkout | `order_group.placed`, `order_group.paid`, `order_group.failed`, `order_group.cancelled` |
| payments | `payment.succeeded`, `payment.failed`, `payment.refunded`, `webhook.received` |
| orders | `seller_order.accepted`, `seller_order.rejected`, `seller_order.packed`, `seller_order.closed` |
| fulfillment | `shipment.created`, `shipment.status_changed`, `shipment.delivered`, `cod.collected`, `cod.remitted` |
| returns | `return.requested`, `return.received`, `return.inspected`, `refund.requested`, `refund.completed` |
| ledger | `journal_entry.posted`, `reconciliation.mismatch_found` |
| payouts | `payout.scheduled`, `payout.approved`, `payout.sent`, `payout.settled`, `payout.failed` |
| tax-eta | `eta.invoice_submitted`, `eta.invoice_accepted`, `eta.invoice_rejected` |
| sellers | `seller.kyc_submitted`, `seller.kyc_decided`, `seller.suspended` |
| store-credit | `store_credit.granted`, `store_credit.spent`, `store_credit.expired` |
| notifications | `notification.requested`, `notification.delivered`, `notification.failed` |
| fraud | `risk.decision_made`, `cod.blocked` |
| drops | `drop.scheduled`, `drop.live`, `drop.ended` |

Rule: an analytics event may be derived from a domain event by a consumer (for example `order_placed` from `order_group.placed`), never the other way round.

## 7. Related data stores

- **Redacted query log** (search demand gaps): hashed user, term lowercased, digits and long numbers masked, emails and phone-like strings dropped, 90 days. Needs `analytics` consent. Not part of this taxonomy.
- **Audit log**: separate, append-only, hash-chained (master prompt A2.9). `admin_*` analytics events are a summary only.

## 8. Checks in CI

- Registry test: every event used in code exists here and in the Zod registry.
- Lint: property names that look like PII (`phone`, `email`, `dob`, `address`, `name`, `measure*`, `budget_amount`) fail the build.
- Consent test: with no consent, only `necessary` events leave the browser.
- Copy lint: social-proof counters on screen must come from a named server query, not a literal.
