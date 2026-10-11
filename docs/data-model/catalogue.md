# Entity catalogue

Status: Draft for review · Generated from the Entities table of each module document on 2026-10-10. If a module document and this catalogue disagree, the module document wins and this file must be regenerated. Conventions and legends are in [../data-model.md](../data-model.md).

Columns: `Ph` is the delivery phase (P0 to P3, spec §P3). `PII` is the data class (P0 public, P1 internal, P2 personal, P3 sensitive and field-encrypted, spec §A3). A cell with more than one class means the table mixes classes by column, and the highest class decides storage and access rules.

## platform

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `outbox_events` | P0 | P1; payload must contain no P3 and only the P2 the consumer needs | none (events carry `store_id` in headers) | monthly by `occurred_at` | published rows 30 d (proposed); unpublished never purged; business truth lives in module tables, not here |
| `inbox_processed` | P0 | P1 | none | monthly by `processed_at` (proposed) | 30 d (proposed, must exceed the longest redelivery window) |
| `idempotency_keys` | P0 | P2 (response may embed the caller's own PII) | none | none | 24 h then purged (spec §A2.5) |
| `audit_log` | P0 | P2 (IP, device, diff redacted) | none, readable only by `dpo`, `security`, `super_admin` | monthly by `occurred_at` | not defined in spec (B1 says "follows §B1"); proposed 7 y, shipped to WORM storage (§T5), I-77. VERIFY BEFORE… |
| `audit_chain_checkpoints` | P0 | P1 | none | none | same as `audit_log` |
| `saga_instances` | P0 | P1 | none | none | 90 d after terminal state (proposed); financial outcome is in ledger and orders |
| `saga_steps` | P0 | P1 | none | none | with parent |
| `dead_letter_events` | P0 | P2 (raw payload may hold PII) | none | none | 90 d (proposed), webhook DLQ rows follow raw-webhook retention (7 y, §B1) |
| `job_runs` | P0 | P1 | none | none | 13 months (proposed) |
| `media_assets` | P1 | P2 by default, P3 for KYC documents and body photos | `store_id` where store-owned | none | follows the owner row; deleted with the owner; private bucket, signed URLs at most 15 min (§T5) |
| `crypto_key_registry` | P0 | P1 | none | none | key metadata kept for the life of any ciphertext that references it |

## auth

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `identities` | P0 | P2 (`subject` encrypted: phone, email or provider sub) | `user_id` | none | RET-USER |
| `passkey_credentials` | P0 | P1 (public key only, no secret) | `user_id` | none | RET-USER |
| `devices` | P0 | P2 (install id, push token) | `user_id` | none | RET-USER; unbound devices 90 d after `last_seen` (proposed) |
| `session_families` | P0 | P1 | `user_id` | none | 90 d after revoke or expiry (proposed) |
| `sessions` | P0 | P1 (hash only) | `user_id` | none | 30 d after `expires_at` (proposed) |
| `otp_challenges` | P0 | P2 (phone blind index, ip hash) | none | daily by `created_at` | 7 d (proposed) |
| `otp_send_counters` | P0 | P1 | none | none | 48 h (proposed) |
| `age_block_devices` | P0 | P2 (device hash only, no DOB, no phone) | none | none | `blocked_until` + 7 d (proposed) |
| `account_merges` | P1 | P1 | `user_id` | none | RET-TAX (audit evidence) |

## users

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `users` | P0 | P3 (phone, DOB), P2 (email, locale) | `user_id` (self) | none | RET-USER; on deletion fields erased, row pseudonymized and kept while orders exist (RET-TAX) |
| `age_attestations` | P0 | P2 | `user_id` | none | RET-USER |
| `age_policy` | P0 | P1 | none | none | indefinite (config history, audited) |
| `user_profiles` | P1 | P2 | `user_id` | none | RET-USER |
| `addresses` | P1 | P3 | `user_id` | none | RET-USER; soft-deleted rows purged 30 d after last order reference (proposed) |
| `address_tokens` | P1 | P1 (token only) | `user_id` via address | none | until revoked or expiry + 30 d (proposed) |
| `user_settings` | P1 | P2 | `user_id` | none | RET-USER |
| `user_favorite_stores` | P1 | P2 | `user_id` | none | RET-USER |
| `user_friendships` | P3 | P2 (private graph, opt-in) | `user_id` | none | RET-USER |
| `staff_memberships_ref` | P0 | P1 | see sellers and admin | none | mirrors sellers.store_members and admin.role_assignments, read model only (I-53) |

## privacy

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `consent_text_versions` | P0 | P0 | none | none | indefinite (legal evidence of what was shown) |
| `consent_records` | P0 | P2 | `user_id` when subject is user | yearly by `occurred_at` (proposed) | proof of consent: retained for the life of the relationship plus the limitation period; VERIFY BEFORE LAUNCH |
| `consents_current` | P0 | P2 | `user_id` | none | RET-USER |
| `dsar_requests` | P1 | P2 | `user_id` | none | 5 y after completion as DSAR evidence (proposed, VERIFY BEFORE LAUNCH) |
| `dsar_module_results` | P1 | P1 | none | none | with parent |
| `data_exports` | P1 | P3 (archive contents), row itself P1 | `user_id` via dsar | none | file removed at `url_expires_at` + 7 d (proposed), row kept with parent |
| `user_tombstones` | P1 | P1 | none | none | as long as retained financial rows reference the pseudonym (RET-TAX) |
| `breach_register` | P1 | P1 (counts, not subjects) | none, DPO only | none | 5 y (proposed, VERIFY BEFORE LAUNCH) |
| `processors` | P1 | P1 | none | none | indefinite (transfer register) |
| `retention_runs` | P1 | P1 | none | none | 13 months (proposed) |

## catalog

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `brands` | P1 | P0 | none | none | RET-CONFIG |
| `categories` | P1 | P0 | none | none | RET-CONFIG |
| `products` | P1 | P0 (seller text is untrusted, never P3) | `store_id` (RLS `app.current_store_id` for writes, public read of ACTIVE rows) | none | RET-TAX for rows referenced by orders (snapshot lives on order line), else delisted rows purged 24 months aft… |
| `skus` | P1 | P0 | `store_id` | none | with product |
| `product_media` | P1 | P0 after moderation | `store_id` via product | none | with product |
| `product_defects` | P1 | P0 | `store_id` via product | none | with product |
| `offer_groups` | P2 | P0 | none | none | RET-CONFIG (derived, rebuilt) |
| `buybox_weight_sets` | P2 | P1 | none | none | indefinite (A/B evidence) |
| `drops` | P2 | P0 | `store_id` | none | RET-TAX when orders reference it, else 24 months after `ENDED` (proposed) |
| `drop_items` | P2 | P0 | `store_id` via drop | none | with drop |
| `drop_price_steps` | P2 | P0 | `store_id` via drop | none | with drop |
| `saved_searches` | P1 | P2 (may reveal intent, see I-48) | `user_id` | none | RET-USER |
| `saved_search_alert_runs` | P2 | P2 | `user_id` via parent | monthly by `ran_at` (proposed) | 90 d (proposed) |

## pricing-integrity

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `price_events` | P1 | P1 (actor id of staff is P2 only when staff) | `store_id` | monthly by `valid_from` (T3) | RET-TAX 7 y (evidence trail for Consumer Protection Agency inquiries, proposed, VERIFY BEFORE LAUNCH) |
| `sku_availability_events` | P1 | P1 | `store_id` | monthly by `valid_from` | RET-TAX 7 y with price events (purchasable intervals decide the claim) |
| `sku_price_reference` | P1 | P1 | `store_id` via sku | none | derived, rebuilt from events |
| `channel_connections` | P1 | P1 (token is a KMS reference, never the token) | `store_id` | none | store lifetime + 90 d |
| `crawler_domains` | P2 | P1 | `store_id` | none | store lifetime |
| `channel_listings` | P2 | P0 (third-party public data) | `store_id` via connection | none | 24 months after last seen (proposed) |
| `channel_snapshots` | P2 | P0 | `store_id` via listing | daily by `captured_at` per spec, monthly per T3 (I-19) | 13 months raw, then aggregated to daily low (proposed) |
| `product_matches` | P2 | P1 | `store_id` via sku | none | life of SKU, labeled pairs kept for ML evaluation |
| `price_evidence` | P1 | P0 | `store_id` via sku | monthly by `observed_at` | RET-TAX 7 y when cited by an order line, else 13 months |
| `price_evidence_documents` | P1 | P2 if the file shows people or personal data, else P1 | `store_id` | none | per retention policy once ADR-0002 is decided, 7 y when cited (VERIFY BEFORE LAUNCH) |
| `price_claims` | P1 | P0 for the public projection (tier, display kind, pct), P1 otherwise | `store_id` | monthly by `evaluated_at` | RET-TAX 7 y when cited, else 13 months |
| `price_claim_evidence` | P1 | P1 | via claim | with claim | with claim (replaces spec array `evidence_ids[]`, I-17) |
| `price_trust_scores` | P1 | P1 | `store_id` | none | 24 months |
| `enforcement_policies` | P1 | P1 | none | none | RET-CONFIG |
| `enforcement_actions` | P1 | P1 | `store_id` | none | 5 y (proposed) |
| `price_violations` | P1 | P1 | `store_id` | none | 5 y (proposed) |
| `price_engine_config` | P1 | P1 | none | none | RET-CONFIG, kept: each claim stores its `config_version` |
| `price_appeals` | P1 | P1 | `store_id` | none | 5 y (proposed) |
| `price_reports` | P2 | P2 | `user_id` | none | 13 months (proposed) |

## search-sync

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `search_index_state` | P1 | P0 | none | none | rebuilt, row removed 30 d after `DELETED` (proposed) |
| `search_reindex_runs` | P1 | P1 | none | none | 13 months |
| `search_synonym_sets` | P1 | P0 | none | none | RET-CONFIG |
| `search_queries` | P1 | P1 by design (pseudonymous, no user id, no free-text PII) | none | monthly by `occurred_at` | RET-EVENTS 25 months then aggregated (inventory `search_queries`) |
| `search_demand_gaps` | P1 | P1 (aggregate, k-threshold applied) | none | none | 25 months |

## inventory

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `locations` | P1 | P1 (warehouse address is business data) | `store_id` | none | store lifetime |
| `stock_pools` | P1 | P0 | none | none | RET-CONFIG |
| `inventory_levels` | P1 | P0 | `store_id` | none | life of SKU |
| `inventory_units` | P1 | P1 | `store_id` via level | hash on `sku_id` (16 partitions, proposed) | claimed and written-off rows 13 months after `state_changed_at` (proposed), order line keeps the truth |
| `reservation_ttl_policies` | P1 | P0 | none | none | RET-CONFIG, versions kept (a reservation cites the policy it ran under) |
| `reservations` | P1 | P2 (user id) | `user_id` | none | 90 d after resolution (proposed) |
| `reservation_lines` | P1 | P2 via parent | `user_id` via parent | none | with parent |
| `inventory_adjustments` | P1 | P1 | `store_id` | monthly by `occurred_at` | RET-TAX 7 y (stock movements support tax and dispute evidence, proposed) |
| `purchase_limits` | P2 | P0 | `store_id` via sku | none | RET-CONFIG |
| `purchase_limit_counters` | P2 | P2 (device and user ids) | `user_id` when subject is user | none | 30 d after `valid_to` (proposed) |
| `drop_admissions` | P2 | P2 | `user_id` | none | 30 d after drop end (proposed) |

## cart

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `carts` | P1 | P2 | `user_id` | none | RET-USER |
| `cart_lines` | P1 | P2 | `user_id` via cart | none | RET-USER; lines removed 30 d after conversion to order (proposed) |
| `wishlists` | P1 | P2 (`gift_nickname`, title) | `user_id` | none | RET-USER |
| `wishlist_items` | P1 | P2 | `user_id` via wishlist | none | RET-USER |
| `wishlist_gift_orders` | P2 | P2 | `user_id` of buyer | none | RET-TAX when order retained, pseudonymised (buyer id replaced by tombstone) |
| `product_alerts` | P1 | P2 | `user_id` | none | RET-USER; inactive rows 13 months (proposed) |

## checkout

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `checkout_sessions` | P1 | P2 | `user_id` | monthly by `created_at` (proposed) | 90 d after terminal state, committed ones are superseded by `order_groups` (proposed) |
| `checkout_session_lines` | P1 | P1 | `user_id` via session | with parent | with parent |
| `checkout_fee_lines` | P1 | P1 | `user_id` via session | with parent | with parent |
| `checkout_applied_promotions` | P1 | P1 | `user_id` via session | with parent | with parent |
| `cod_confirmations` | P1 | P2 | `user_id` via group | none | RET-TAX with the order |
| `checkout_risk_decisions` | P1 | P1 | `user_id` via session | none | with parent |

## payments

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `payment_providers` | P1 | P1 | none | none | RET-CONFIG |
| `psp_routes` | P1 | P1 | none | none | RET-CONFIG, versions kept |
| `payment_intents` | P1 | P2 (user key) | `user_id` | monthly by `created_at` (proposed, uniqueness via `order_group_id` is kept in orders as w… | RET-TAX |
| `payment_attempts` | P1 | P1 | `user_id` via intent | with intent | RET-TAX |
| `payment_tenders` | P1 | P2 | `user_id` via order group | none | RET-TAX |
| `payment_events_raw` | P1 | P2 (body may include payer name, masked PAN, phone) | none | monthly by `received_at` (T3) | RET-WEBHOOK, 7 y (spec §B1, financial evidence, VERIFY) |
| `payment_event_dedup` | P1 | P1 | none | none | same as raw |
| `payment_methods` | P1 | P2 (last4, brand, expiry) | `user_id` | none | RET-USER, token deleted at provider on removal |
| `refunds` | P1 | P2 | `user_id` via order group; `store_id` via seller order for seller views | none | RET-TAX |
| `refund_lines` | P1 | P1 | via refund | none | RET-TAX |
| `refund_attempts` | P1 | P1 | via refund | none | RET-TAX |
| `bnpl_quote_requests` | P1 | P1 | none | none | 7 d, cache only (24 h freshness per §4) |
| `installment_quotes` | P1 | P1 | none | none | with request |
| `bnpl_applications` | P1 | P2 | `user_id` via order group | none | RET-TAX |
| `chargebacks` | P1 | P2 | none | none | RET-TAX |
| `settlement_files` | P1 | P1 | none | none | RET-TAX |
| `settlement_lines` | P1 | P1 | none | monthly by `value_date` (proposed) | RET-TAX |

## ledger

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `ledger_account_types` | P0 | P1 | none | none | RET-CONFIG |
| `ledger_accounts` | P0 | P1 (an `owner_id` holding a user id makes the row personal data, pseudonymized on erasure) | owner (`store` rows are visible to that store's finance role only through views) | none | RET-TAX |
| `journal_entries` | P0 | P1 | none, no direct app read, finance views per store | monthly by `occurred_at` (proposed, needs a global unique on `idempotency_key` kept in an… | RET-TAX |
| `postings` | P0 | P1 | none | monthly by entry `occurred_at` (proposed, with the entry table) | RET-TAX |
| `ledger_holds` | P1 | P1 | none | none | 90 d after `settled_at` (proposed), financial effect lives in the captured entry |
| `balance_projections` | P1 | P1 | none | none | rebuilt from postings, no retention of its own |
| `balance_drift_reports` | P1 | P1 | none | none | 13 months (proposed) |
| `ledger_chain_links` | P0 | P1 | none | monthly by chain day (proposed) | RET-TAX |
| `ledger_snapshots` | P0 | P1 | none | none | RET-TAX, WORM copy |
| `reconciliation_runs` | P1 | P1 | none | none | RET-TAX |
| `reconciliation_items` | P1 | P1 | none | none | RET-TAX |

## payouts

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `payout_instruments` | P1 | P3 (IBAN, holder name) | `store_id` when `owner_type = STORE` (finance role only) | none | RET-KYC: contract plus 5 years (spec §B1), VERIFY |
| `payout_cycles` | P1 | P1 | none | none | RET-TAX |
| `payout_accruals` | P1 | P1 | `store_id` | none | RET-TAX |
| `payouts` | P1 | P2 (links to an identified store or creator) | `store_id` via owner | none | RET-TAX |
| `payout_items` | P1 | P1 | via payout | none | RET-TAX |
| `payout_adjustments` | P1 | P1 | `store_id` | none | RET-TAX |
| `payout_holds` | P1 | P1 | `store_id` via owner | none | RET-TAX |
| `payout_statements` | P1 | P1 | `store_id` | none | RET-TAX |

## tax-eta

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `tax_categories` | P1 | P0 | none | none | RET-CONFIG |
| `tax_category_rates` | P1 | P1 | none | none | RET-CONFIG, kept (historic orders refer to it) |
| `eta_taxpayer_profiles` | P1 | P2 (tax registration number of a business, personal for a sole trader) | `store_id` when STORE | none | RET-KYC |
| `eta_credentials` | P1 | P1 (only references, never the secret) | `store_id` via profile | none | contract end plus tail (proposed) |
| `tax_documents` | P1 | P2 (B2C receipt can identify a shopper) | `store_id` for seller-issued or B2B documents, `user_id` for receipts | monthly by `issued_at` (proposed) | RET-TAX 7 y (VERIFY), pseudonymize recipient on deletion |
| `tax_document_lines` | P1 | P1 | via document | with document | RET-TAX |
| `eta_submissions` | P1 | P2 (response may contain taxpayer details) | none | monthly by `submitted_at` (proposed) | RET-TAX |
| `eta_reconciliation_reports` | P1 | P1 | none | none | RET-TAX |
| `vat_report_runs` | P1 | P1 | `store_id` | none | RET-TAX |

## orders

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `order_groups` | P1 | P2 | `user_id` (RLS `app.current_user_id`); admin by scope | monthly by `placed_at` (proposed; uniqueness of `idempotency_key` kept by a small unparti… | RET-TAX, pseudonymized after deletion |
| `seller_orders` | P1 | P2 | `store_id` (RLS `app.current_store_id`) and `user_id` via group | with parent group (hash by `order_group_id` if partitioned) | RET-TAX |
| `order_lines` | P1 | P1 | `store_id` | with order | RET-TAX |
| `order_line_price_evidence` | P1 | P1 | `store_id` via line | with line | RET-TAX (consumer-agency inquiry trail) |
| `order_line_promotions` | P1 | P1 | `store_id` via line | with line | RET-TAX |
| `order_status_history` | P1 | P1 | `store_id` via order | monthly by `occurred_at` | RET-TAX |
| `delivery_snapshots` | P1 | P3 (name, phone, address) | `user_id`; sellers only through an active access grant | none | `delivery_records` 24 months then pseudonymize (proposed), erased on deletion unless legal hold |
| `seller_delivery_access_grants` | P1 | P1 | `store_id` | none | 30 d after expiry (proposed) |
| `order_cancellations` | P1 | P1 | `store_id` | none | RET-TAX |

## fulfillment

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `couriers` | P1 | P1 | none | none | RET-CONFIG |
| `courier_coverage` | P1 | P0 | none | none | RET-CONFIG |
| `courier_service_levels` | P1 | P1 | none | none | RET-CONFIG |
| `transit_time_stats` | P1 | P1 | none | none | 24 months |
| `shipments` | P1 | P2 (delivery data is reached via the snapshot, not stored here) | `store_id` | monthly by `created_at` (proposed) | `delivery_records` 24 months then pseudonymize (proposed); COD fields follow RET-TAX |
| `shipment_seller_orders` | P1 | P1 | `store_id` via shipment | with shipment | with shipment |
| `shipment_events` | P1 | P1 | `store_id` via shipment | monthly by `occurred_at` (T3) | 24 months (proposed) |
| `courier_events_raw` | P1 | P2 (body may include recipient name, phone, address) | none | monthly by `received_at` (T3) | RET-WEBHOOK where it supports COD financial evidence (7 y, VERIFY), otherwise 24 months |
| `courier_event_dedup` | P1 | P1 | none | none | same as raw |
| `delivery_attempts` | P1 | P1 | `store_id` via shipment | with shipment | 24 months (proposed) |
| `proofs_of_delivery` | P1 | P2 (photo may show a person or home) | `store_id` via shipment | none | 24 months (proposed), media private |
| `cod_remittances` | P1 | P1 | none | none | RET-TAX |
| `cod_remittance_lines` | P1 | P1 | none | none | RET-TAX |
| `shipment_carbon` | P1 | P1 | `store_id` via shipment | none | 24 months |

## returns

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `return_reason_codes` | P1 | P0 | none | none | RET-CONFIG |
| `return_policies` | P1 | P0 | none | none | RET-CONFIG, versions kept (windows applied at the time of order are re-derivable) |
| `return_policy_rules` | P1 | P1 | none | none | RET-CONFIG |
| `returns` | P1 | P2 | `user_id` and `store_id` | none | `returns_evidence` for photos 12 months (proposed); the return row itself RET-TAX because it justifies a refu… |
| `return_evidence` | P1 | P2 (photos of person or home are possible) | `store_id` via return | none | `returns_evidence` 12 months after closure (proposed, VERIFY) |
| `return_inspections` | P1 | P1 | `store_id` via return | none | RET-TAX |
| `return_disputes` | P1 | P2 | `user_id`, `store_id` via return | none | RET-TAX |
| `return_status_history` | P1 | P1 | via return | monthly by `occurred_at` | RET-TAX |
| `returner_standing` | P1 | P2 | `user_id` | none | RET-USER, recomputed daily |
| `return_resale_items` | P2 | P0 | `store_id` of the owner | none | RET-CONFIG |

## promotions

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `promotions` | P1 | P0 | `store_id` (seller promotions), none for platform | none | RET-TAX when an order references it, else RET-CONFIG |
| `promotion_rules` | P1 | P0 | `store_id` via promotion | none | with promotion |
| `promotion_targets` | P1 | P1 | `store_id` via promotion | none | with promotion |
| `promotion_caps` | P1 | P1 | `store_id` via promotion | none | with promotion |
| `vouchers` | P1 | P2 when personal (`assigned_user_id`) | `user_id` for personal vouchers; public lookup by code through rate-limited API | none | RET-USER for personal rows, 24 months for expired (proposed) |
| `voucher_redemptions` | P1 | P2 | `user_id` | monthly by `redeemed_at` (proposed) | RET-TAX |
| `promotion_usage_counters` | P1 | P2 for USER keys | `user_id` for USER keys | none | with promotion |
| `stacking_policies` | P1 | P1 | none | none | RET-CONFIG, kept |
| `sponsored_campaigns` | P2 | P1 | `store_id` | none | RET-TAX for billing, 24 months otherwise |
| `sponsored_items` | P2 | P0 | `store_id` via campaign | none | with campaign |
| `sponsored_clicks` | P2 | P1 (pseudonymous id only, no user id) | `store_id` via campaign | monthly by `occurred_at` | 13 months (proposed) |

## gift-cards

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `gift_card_designs` | P2 | P0 | none | none | RET-CONFIG |
| `gift_cards` | P2 | P2 (recipient contact, purchaser) | `user_id` (purchaser) and redemption by code | none | RET-TAX for value records (liability); recipient contact `gift_recipient_contact` 30 d after event date (prop… |
| `gift_card_messages` | P2 | P2 (free text, photos) | `user_id` via card | none | with card, media deleted at expiry plus 30 d (proposed) |
| `gift_card_deliveries` | P2 | P1 | via card | none | 90 d (proposed) |
| `gift_card_redemptions` | P2 | P2 | `user_id` | none | RET-TAX |
| `gift_card_redeem_attempts` | P2 | P2 (user, device, ip hash) | none | monthly by `occurred_at` | 13 months (proposed), fraud window |
| `group_gift_pots` | P2 | P2 | `user_id` (organizer) | none | 30 d after close for contact, rest RET-TAX |
| `group_gift_contributions` | P2 | P2 | `user_id` (payer) | none | RET-TAX |
| `corporate_accounts` | P2 | P2 | `corporate_account_id` | none | RET-KYC |
| `corporate_gift_batches` | P2 | P2 (recipient CSV is held in a private object, deleted after issue) | `corporate_account_id` | none | RET-TAX |

## store-credit

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `credit_kind_policies` | P1 | P0 | none | none | RET-CONFIG |
| `credit_sub_balances` | P1 | P2 (user key, financial) | `user_id` | none | RET-TAX (liability evidence), pseudonymized on deletion |
| `credit_grants` | P1 | P2 | `user_id` | none | RET-TAX |
| `credit_spend_allocations` | P1 | P2 | `user_id` via sub-balance | none | RET-TAX |
| `credit_balances` | P1 | P2 | `user_id` | none | rebuilt from postings |
| `credit_expiry_runs` | P1 | P1 | none | none | 13 months |
| `credit_forfeitures` | P1 | P2 | `user_id` | none | RET-TAX |
| `wallet_transactions` | P1 | P2 | `user_id` | monthly by `occurred_at` (proposed) | RET-USER, derived and rebuildable |
| `partner_wallet_accounts` | P3 | P2 | `user_id` | none | RET-KYC, only when licensed partner exists (VERIFY BEFORE LAUNCH) |

## subscriptions

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `plans` | P2 | P0 | none | none | RET-CONFIG, kept (invoices reference versions) |
| `plan_price_changes` | P2 | P1 | none | none | RET-CONFIG |
| `subscriptions` | P2 | P2 | `user_id` | none | RET-TAX (invoices); row itself RET-USER, pseudonymized on deletion |
| `subscription_periods` | P2 | P1 | `user_id` via subscription | none | RET-TAX |
| `subscription_invoices` | P2 | P2 | `user_id` via subscription | none | RET-TAX |
| `subscription_charge_attempts` | P2 | P1 | via invoice | none | RET-TAX |
| `subscription_disclosures` | P2 | P2 | `user_id` | none | RET-TAX (evidence of disclosure) |
| `subscription_state_history` | P2 | P1 | via subscription | monthly by `occurred_at` | RET-TAX |
| `family_seats` | P2 | P2 | `user_id` | none | RET-USER |
| `trial_claims` | P2 | P2 (hashed identifiers) | none (fraud use) | none | 24 months (proposed, VERIFY) |
| `plus_gifts` | P2 | P2 | `user_id` (purchaser) | none | RET-TAX |
| `plus_savings_ledger` | P2 | P2 | `user_id` | monthly by `occurred_at` (proposed) | RET-USER |

## rewards

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `coin_earn_rules` | P2 | P0 | none | none | RET-CONFIG |
| `coin_accounts` | P2 | P2 | `user_id` | none | RET-USER |
| `coin_lots` | P2 | P2 | `user_id` | none | RET-USER; liability evidence follows RET-TAX through conversions |
| `coin_transactions` | P2 | P2 | `user_id` | monthly by `occurred_at` | 25 months then aggregated (proposed) |
| `coin_conversions` | P2 | P2 | `user_id` | none | RET-TAX |
| `tier_definitions` | P2 | P0 | none | none | RET-CONFIG |
| `user_tiers` | P2 | P2 | `user_id` | none | RET-USER |
| `game_definitions` | P2 | P0 | none | none | RET-CONFIG |
| `game_odds_versions` | P2 | P0 | none | none | indefinite (disclosure evidence) |
| `game_plays` | P2 | P2 | `user_id` | monthly by `played_at` | 25 months (proposed) |
| `challenges` | P2 | P0 | none | none | RET-CONFIG |
| `challenge_progress` | P2 | P2 | `user_id` | none | RET-USER |
| `user_streaks` | P2 | P2 | `user_id` | none | RET-USER |

## referrals

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `referral_programs` | P1 | P0 | none | none | RET-CONFIG |
| `referral_codes` | P1 | P2 | `user_id` | none | RET-USER |
| `referral_attributions` | P1 | P2 (device and IP hashes) | none (referrer sees counts only) | monthly by `attributed_at` (proposed) | 13 months (proposed) for unconverted, with the referral for converted |
| `referrals` | P1 | P2 | `user_id` (referrer) | none | RET-TAX when a reward was paid, else RET-USER |
| `referral_milestones` | P1 | P2 | `user_id` | none | RET-USER |
| `creator_accounts` | P3 | P2 | `user_id` | none | RET-KYC |
| `creator_kyc_records` | P3 | P3 (national id, legal name) | `creator_id`, finance and compliance only | none | RET-KYC contract plus 5 years (spec §B1, VERIFY) |
| `affiliate_links` | P3 | P1 | `creator_id` | none | RET-CONFIG |
| `affiliate_clicks` | P3 | P1 (pseudonymous id, never user id) | `creator_id` via link (aggregates only) | monthly by `clicked_at` (spec: partitioned) | 13 months, `affiliate_attribution` (proposed) |
| `commissions` | P3 | P2 | `creator_id` | none | RET-TAX |
| `creator_looks` | P3 | P0 | `creator_id` | none | RET-USER |

## budget

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `budgets` | P2 | P3 | `user_id` | none | RET-BUDGET: until consent withdrawn or account deleted (spec, proposed purge job) |
| `budget_cycles` | P2 | P3 | `user_id` | none | RET-BUDGET |
| `budget_cycle_entries` | P2 | P3 | `user_id` | monthly by `occurred_at` | RET-BUDGET |
| `installment_commitments` | P2 | P3 | `user_id` | none | RET-BUDGET |
| `savings_goals` | P2 | P3 | `user_id` | none | RET-BUDGET |
| `spending_locks` | P2 | P3 | `user_id` | none | RET-BUDGET |
| `wellbeing_settings` | P2 | P3 | `user_id` | none | RET-BUDGET |
| `purchase_plans` | P2 | P3 | `user_id` | none | RET-BUDGET |
| `budget_reports` | P2 | P3 | `user_id` | none | RET-BUDGET (object deleted with the data) |

## sizing

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `size_profiles` | P1 | P3 | `user_id` | none | RET-MEASUREMENTS: until user deletes or the account is deleted (spec §B1) |
| `size_chart_templates` | P1 | P0 | none | none | RET-CONFIG |
| `size_charts` | P1 | P0 | `store_id` | none | RET-CONFIG, versions kept while referenced |
| `fit_feedback` | P1 | P2 | `user_id` | none | RET-PERSONALIZATION 24 months after consent withdrawal rule (proposed) |
| `item_fit_flags` | P1 | P0 (aggregate counts, no user) | none | none | derived, rebuilt |
| `brand_size_bias` | P1 | P0 | none | none | derived, rebuilt |
| `user_latent_sizes` | P1 | P3 | `user_id` via profile | none | with profile |
| `size_recommendation_log` | P1 | P1 (pseudonymous id, never user id) | none | monthly by `occurred_at` | RET-EVENTS 25 months then aggregated |
| `seller_size_demand_agg` | P1 | P0 (k at least 50 enforced at write, rows below k are not created) | `store_id` | none | 24 months |
| `body_scan_captures` | P3 | P3 | `user_id` | none | deleted with profile, media by explicit consent only |

## stylist-gateway

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `product_attributes` | P2 | P0 | none | none | RET-CONFIG, old versions pruned after 90 d (proposed) |
| `product_embeddings` | P2 | P0 | none (LLM08: per scope, no user data) | none | with attributes |
| `style_profiles` | P2 | P2 | `user_id` | none | RET-PERSONALIZATION, 24 months or on consent withdrawal and history clear (within 24 h) |
| `outfit_requests` | P2 | P3 when `budget_enc` present, else P2 | `user_id` | monthly by `created_at` (proposed) | RET-PERSONALIZATION 24 months |
| `outfits` | P2 | P2 | `user_id` | monthly by `created_at` (proposed) | RET-PERSONALIZATION |
| `outfit_items` | P2 | P2 | `user_id` via outfit | with outfit | with outfit |
| `stylist_feedback` | P2 | P2 | `user_id` | none | RET-PERSONALIZATION |
| `capsules` | P2 | P2, P3 for budget | `user_id` | none | RET-PERSONALIZATION |
| `stylist_usage_counters` | P2 | P2 | `user_id` | none | 90 d (proposed) |
| `llm_audit_log` | P2 | P1 (pseudonymous id, prompt hash only, no prompt text) | none | monthly by `occurred_at` | 13 months (proposed) |
| `wardrobe_items` | P3 | P2 (images user-deletable) | `user_id` | none | `user_content` until user removes or deletes the account |
| `outfit_calendar_events` | P3 | P2 | `user_id` | none | RET-USER |

## recommendations-gateway

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `user_events` | P1 | P2 | `user_id` | monthly by `occurred_at` (spec: partitioned) | RET-EVENTS 25 months then aggregated (spec §13) |
| `history_controls` | P1 | P2 | `user_id` | none | RET-USER |
| `recently_viewed` | P1 | P2 | `user_id` | none | RET-USER, cleared with history |
| `user_features` | P1 | P2 | `user_id` | none | RET-PERSONALIZATION, purged within 24 h of clear or consent withdrawal |
| `item_similarity` | P1 | P0 | none | none | derived, rebuilt per batch |
| `ranking_models` | P1 | P1 | none | none | indefinite (model cards) |
| `recommendation_impressions` | P1 | P1 (pseudonymous id) | none | monthly by `occurred_at` | RET-EVENTS 13 months (proposed) |
| `feed_items` | P1 | P0 | `store_id` | none | RET-CONFIG |
| `feed_item_products` | P1 | P0 | via feed item | none | with feed item |
| `social_proof_counters` | P1 | P0 | none | none | cache only, rebuilt each minute |

## notifications

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `notification_templates` | P1 | P0 | none | none | RET-CONFIG, versions kept |
| `notification_preferences` | P1 | P2 | `user_id` | none | RET-USER |
| `notification_suppressions` | P1 | P2 (hashed address) | none | none | until unsuppressed or 24 months (proposed) |
| `notification_requests` | P1 | P2 (payload may contain order refs and names) | `user_id` | monthly by `created_at` (proposed) | `notification_log` 12 months (proposed) |
| `notification_log` | P1 | P2 | `user_id` | monthly by `sent_at` (spec: partitioned) | 12 months (proposed) |
| `inbox_messages` | P1 | P2 | `user_id` | none | 90 d after read or expiry (proposed) |
| `frequency_counters` | P1 | P2 | `user_id` | none | 14 d |
| `journeys` | P1 | P0 | none | none | RET-CONFIG |
| `journey_enrollments` | P1 | P2 | `user_id` | none | RET-USER |
| `channel_providers` | P1 | P1 | none | none | RET-CONFIG |
| `send_time_windows` | P1 | P2 | `user_id` | none | RET-PERSONALIZATION, purged with personalization data |

## analytics-ingest

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `analytics_event_schemas` | P0 | P0 | none | none | RET-CONFIG |
| `ingest_batches` | P0 | P1 | none | monthly by `received_at` | 13 months (proposed) |
| `ingest_rejections` | P0 | P1 | none | monthly by `occurred_at` | 90 d (proposed) |
| `pseudonym_epochs` | P0 | P1 | none | none | indefinite (key metadata) |
| `experiments` | P1 | P1 | none | none | RET-CONFIG |
| `experiment_exposures` | P1 | P1 (pseudonymous id) | none | monthly by `occurred_at` | RET-EVENTS 25 months then aggregated |
| `warehouse_models` | P0 | P1 | none | none | RET-CONFIG |
| `seller_report_schedules` | P1 | P1 | `store_id` | none | RET-CONFIG |
| `seller_report_exports` | P1 | P1 | `store_id` | none | 90 d object, record RET-TAX not required (proposed) |

## sellers

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `sellers` | P1 | P2 (sole traders are natural persons) | `seller_id` (stores of one seller) | none | RET-KYC contract plus 5 years (spec, VERIFY) |
| `stores` | P1 | P0 (public profile) | `store_id` (self) | none | RET-CONFIG, kept while orders reference it |
| `store_settings` | P1 | P1 | `store_id` | none | RET-CONFIG, versioned history |
| `store_vacation_windows` | P1 | P0 | `store_id` | none | 24 months |
| `store_members` | P1 | P2 | `store_id` | none | `staff_access`: contract end plus 12 months (proposed) |
| `store_member_invitations` | P1 | P2 (email hash) | `store_id` | none | 30 d |
| `seller_kyc_records` | P1 | P3 | `seller_id`, ops and compliance roles only | none | RET-KYC contract plus 5 years (spec, VERIFY) |
| `kyc_documents` | P1 | P3 (identity documents) | `seller_id` via kyc | none | with KYC, private bucket |
| `kyc_checks` | P1 | P2 | via kyc | none | with KYC |
| `kyc_review_tasks` | P1 | P2 | ops roles | none | with KYC |
| `seller_brand_authorizations` | P1 | P1 | `seller_id` | none | contract plus 5 years (proposed) |
| `seller_agreements` | P1 | P0 | none | none | indefinite (legal evidence) |
| `seller_agreement_acceptances` | P1 | P2 | `seller_id` | none | RET-TAX |
| `seller_health_scores` | P1 | P1 | `store_id` | monthly by `computed_at` (proposed) | 24 months |
| `seller_penalty_events` | P1 | P1 | `store_id` | none | 24 months |
| `store_directory_stats` | P1 | P0 | none | none | derived cache |
| `storefront_pages` | P2 | P0 | `store_id` | none | RET-CONFIG |

## admin

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `admin_roles` | P0 | P1 | none | none | RET-CONFIG |
| `role_permissions` | P0 | P1 | none | none | RET-CONFIG |
| `role_assignments` | P0 | P2 | none (admin) | none | 12 months after revoke (`staff_access`, proposed) |
| `elevations` | P0 | P2 | none | none | 12 months |
| `approval_requests` | P0 | P1 | none | none | RET-TAX when finance related, else 24 months |
| `approval_decisions` | P0 | P2 | none | none | with request |
| `pii_access_log` | P0 | P2 | readable by DPO and Security only | monthly by `occurred_at` | same as audit log (7 y proposed, VERIFY) |
| `staff_accounts` | P0 | P2 | `store_id` for seller staff | none | `staff_access` contract end plus 12 months (proposed) |
| `feature_flags` | P0 | P0 | none | none | RET-CONFIG |
| `feature_flag_rules` | P0 | P1 | none | none | RET-CONFIG, history in audit |
| `config_parameters` | P0 | P0 | none | none | RET-CONFIG |
| `config_parameter_versions` | P0 | P1 | none | none | RET-CONFIG, kept (orders reference effective values) |
| `segments` | P1 | P1 | none | none | RET-CONFIG |
| `segment_memberships` | P1 | P2 | `user_id` | none | recomputed, erased with user |
| `support_tickets` | P1 | P2 | `user_id`, `store_id` for seller-raised | none | `support_chats` 2 years (spec §B1) |
| `support_messages` | P1 | P2 (free text) | via ticket | monthly by `sent_at` (proposed) | 2 years (spec §B1) |
| `support_macros` | P1 | P0 | none | none | RET-CONFIG |
| `merch_layouts` | P1 | P0 | none | none | RET-CONFIG |
| `campaign_events` | P1 | P0 | none | none | RET-CONFIG |

## fraud

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `risk_models` | P1 | P1 | none | none | indefinite (model cards) |
| `risk_rules` | P1 | P1 | none | none | RET-CONFIG |
| `risk_assessments` | P1 | P2 | none (fraud and support roles only) | monthly by `created_at` | RET-FRAUD 24 months (inventory `fraud_signals`, proposed, VERIFY) |
| `device_ip_graph_edges` | P1 | P2 (hashed identifiers) | none | none | RET-FRAUD, rolling window |
| `fraud_clusters` | P1 | P1 | none | none | RET-FRAUD |
| `fraud_cluster_members` | P1 | P2 | none | none | RET-FRAUD |
| `cod_refusal_history` | P1 | P2 | none | none | RET-FRAUD 24 months (inventory `cod_refusal_history`) |
| `cod_standing` | P1 | P2 | `user_id` (user sees own status only as a reason in checkout) | none | RET-FRAUD |
| `fraud_blocklist_entries` | P1 | P2 (hashed) | none | none | until expiry plus 12 months |
| `card_testing_signals` | P1 | P2 | none | daily or monthly by `observed_at` | 90 d |
| `fraud_cases` | P1 | P2 | none | none | RET-FRAUD |
| `fraud_appeals` | P1 | P2 | `user_id` | none | RET-FRAUD |

## trust-safety

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `reviews` | P1 | P2 (public display name, free text) | `user_id` for write, public read of PUBLISHED, `store_id` for response | none | `user_content`: until user removes or deletes the account, then anonymised |
| `review_photos` | P1 | P2 (photos may show persons) | via review | none | with review |
| `review_responses` | P1 | P1 | `store_id` via review | none | with review |
| `product_questions` | P1 | P2 | `user_id` | none | `user_content` |
| `product_answers` | P1 | P2 | `store_id` or `user_id` | none | `user_content` |
| `product_rating_aggregates` | P1 | P0 | none | none | derived |
| `moderation_items` | P1 | P2 | none (T&S roles) | monthly by `created_at` (proposed) | 12 months after decision (proposed) |
| `moderation_decisions` | P1 | P1 | none | none | with item |
| `ugc_reports` | P1 | P2 | `user_id` for reporter | none | 12 months (proposed) |
| `ip_rights_holders` | P1 | P2 (contact hash) | none | none | RET-KYC contract plus 5 years (proposed) |
| `counterfeit_notices` | P1 | P1 | `store_id` (seller may read notices about its products) | none | RET-TAX not required, 5 years (proposed, legal evidence) |
| `ts_cases` | P1 | P2 | none (T&S roles) | none | 5 years for suspension and counterfeit, 12 months for UGC (proposed) |
| `image_hash_matches` | P1 | P0 | none | none | 24 months |
| `seller_content_strikes` | P1 | P1 | `store_id` | none | 24 months |
| `prohibited_item_rules` | P1 | P0 | none | none | RET-CONFIG |
| `live_sessions` | P3 | P0 | `store_id` | none | 24 months |
| `live_chat_messages` | P3 | P2 | `user_id` | daily or monthly by `sent_at` | 30 days (inventory `live_chat`, proposed) |

## voc

| Entity | Ph | PII | Tenancy | Partition | Retention |
|---|---|---|---|---|---|
| `survey_definitions` | P2 | P0 | none | none | RET-CONFIG |
| `survey_invitations` | P2 | P2 | `user_id` | none | 90 d after expiry (proposed) |
| `survey_responses` | P2 | P2 (comment may include PII) | `user_id` for owner, `store_id` aggregate only | monthly by `created_at` (proposed) | 13 months then user link dropped and kept as aggregate (proposed, VERIFY) |
| `topic_taxonomy` | P2 | P0 | none | none | RET-CONFIG |
| `topic_assignments` | P2 | P1 (no text copy, only references) | `store_id` via aggregates | monthly by `assigned_at` (proposed) | 25 months then aggregated |
| `support_ticket_tags` | P2 | P1 | none | none | with ticket (2 years) |
| `feature_request_clusters` | P2 | P1 | none | none | RET-CONFIG |
| `voc_metrics_daily` | P2 | P1 | `store_id` when scope is a store | none | 25 months |
| `voc_reports` | P2 | P1 (aggregates only) | `store_id` | none | 24 months |

Total entities: 379.
