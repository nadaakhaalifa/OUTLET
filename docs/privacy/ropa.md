<!-- Generated from data_inventory.yaml (same schema source as docs/data-model.md). Edit the source, not this file. -->

# Records of Processing Activities (RoPA), draft

Outlex (code name Outlet NK). Generated 2026-11-07.

> **Status: DRAFT, not reviewed by counsel or the DPO. Not legal advice.** Every lawful basis, retention period and residency value is an engineering proposal. Items marked ⚠ are VERIFY BEFORE LAUNCH and point to rows in `docs/compliance/verify-register.md`. **No real personal data may be processed** until the controller is incorporated, a DPO is appointed, the PDPC licence or registration is in place (V1) and the residency decision ADR-0002 is accepted (V2).

## 1. Legal frame (as stated in the master prompt; counsel to confirm)

| Source | What it requires of us | ⚠ |
|---|---|---|
| Personal Data Protection Law 151/2020 | Lawful processing, data subject rights, controller duties | V70 (lawful bases) |
| Executive Regulations, Ministerial Decision 816/2025 (issued 1 Nov 2025) | Full compliance due by **1 November 2026**: PDPC licensing or registration with fees by activity and volume; a **mandatory DPO** registered with the PDPC; breach notice to the PDPC within **72 hours** and to affected people within **3 days**; cross-border transfer only with a licence or authorisation, adequate protection and a transfer impact assessment; consent that is explicit, informed, specific, freely given and easy to withdraw | V1, V2, V39 |
| Consumer Protection Law 181/2018 | Arabic invoices and contracts, seller identity on listings, return windows from delivery | V7, V19, V75 |
| Tax law and ETA e-invoicing | Keeping invoices and financial records for the legal period | V6, V71 |

The compliance date in the master prompt (1 November 2026) has passed as of this draft. This RoPA is written now so the licence application, DPO onboarding and transfer filings can use it.

## 2. Controller and contacts

| Item | Value |
|---|---|
| Controller | Outlex operating entity in Egypt: **not yet incorporated** ⚠ |
| DPO | **Not yet appointed** ⚠ V1. Admin role `dpo` and the DPO console exist in the design. |
| PDPC licence or registration | Category and fee unknown ⚠ V1 |
| Data plane | Hybrid (owner-accepted working default): personal, money and stock data in the **EG cell in Egypt** (candidate Huawei Cloud Cairo after a 1-week spike, V37, V38); public catalog on a global edge. Final choice is ADR-0002 (stop-and-ask). |
| Joint controllers / independent controllers | Sellers receive delivery data as independent controllers or processors under the Seller Agreement DPA (counsel to classify). PSPs and BNPL lenders are likely independent controllers for card and credit data (V4, V5). |

## 3. Inventory summary

| Measure | Count |
|---|---|
| Tables designed (Phase 0–1, plus Phase 2 tables named by a spec) | 209 |
| Columns tagged | 2142 |
| P0 public / P1 internal / P2 personal / P3 sensitive | 271 / 1643 / 207 / 21 |
| Tables holding personal data | 99 |
| Residency: `cell` / `cell_publishable` / `global` | 150 / 26 / 33 |

Global tables hold **no personal data** (checked by the generator). `cell_publishable` tables send only P0 columns to the global plane.

## 4. Processing activities by purpose

### Account, sign-in and session security (`account_auth`)

Create and authenticate accounts (phone OTP, Apple, Google, passkey), keep sessions, stop sign-in abuse.

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper, visitor |
| Lawful basis (proposed) | `contract` |
| Tables | `devices`, `otp_challenges`, `passkey_credentials`, `refresh_tokens`, `session_families`, `totp_credentials`, `user_identities`, `users` |
| Personal fields (P2) | 27: `users.id`, `users.phone_bidx`, `users.email_ct`, `users.email_bidx`, `users.display_name`, `users.locale`, `users.phone_verified_at`, `user_identities.user_id`, `user_identities.subject_ct`, `user_identities.subject_bidx`, `user_identities.verified_at`, `user_identities.last_auth_at`, `passkey_credentials.user_id`, `passkey_credentials.credential_id`, `passkey_credentials.last_used_at`, `totp_credentials.user_id`, `otp_challenges.phone_bidx`, `otp_challenges.code_hash`, `otp_challenges.device_id`, `otp_challenges.ip_hmac`, `devices.id`, `devices.user_id`, `devices.install_id_hash`, `devices.web_push_ct`, `session_families.user_id`, `session_families.device_id`, `refresh_tokens.token_hash` |
| Sensitive fields (P3) | 2: `users.phone_ct`, `totp_credentials.secret_ct` |
| Recipients and processors | `cloud_cell`, `email_provider`, `sms_provider`, `web_push`, `whatsapp_bsp` |
| Possible cross-border transfer | `email_provider` (unknown), `sms_provider` (unknown), `web_push` (yes), `whatsapp_bsp` (yes) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `auth_30d`: 30 days after expiry or revocation; `device_13m`: 13 months after last seen; `otp_30d`: 30 days |
| Technical measures (field level) | `blind_index_hmac`, `field_envelope`, `one_way_hash` |
| ⚠ VERIFY | V2, V8, V37, V38, V39, V44, V45, V73, V76 |

### Age assurance and capability gates (`age_assurance`)

Enforce 18+ to shop and 21+ for contracts using DOB and attestation (master prompt B6, V8).

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper, visitor |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `age_attestations`, `age_blocks`, `users` |
| Personal fields (P2) | 6: `users.age_band`, `users.limited_capacity`, `age_attestations.user_id`, `age_attestations.attested_18_at`, `age_blocks.device_hash`, `age_blocks.dob_hash` |
| Sensitive fields (P3) | 1: `users.dob_ct` |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `consent_evidence`: Life of the account plus 5 years after withdrawal or closure (proposed); `underage_block_30d`: 30 days (soft re-try block) |
| Technical measures (field level) | `field_envelope`, `one_way_hash` |
| ⚠ VERIFY | V1, V2, V8, V37, V38, V70, V73 |

### Consent records (`consent_management`)

Prove which consent was given or withdrawn, when and how (PDPL).

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper, visitor |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `agreement_acceptances`, `consent_records`, `consent_state` |
| Personal fields (P2) | 10: `consent_records.user_id`, `consent_records.device_id`, `consent_records.granted`, `consent_records.ip_hmac`, `consent_state.user_id`, `consent_state.granted`, `agreement_acceptances.party_id`, `agreement_acceptances.accepted_by_user_id`, `agreement_acceptances.accepted_at`, `agreement_acceptances.ip_hmac` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `consent_evidence`: Life of the account plus 5 years after withdrawal or closure (proposed) |
| Technical measures (field level) | `blind_index_hmac` |
| ⚠ VERIFY | V1, V2, V37, V38, V70, V76 |

### Data subject rights and breach handling (`privacy_rights`)

DSAR export, deletion, rectification, breach register and transfer register.

| Item | Value |
|---|---|
| Data subjects | shopper |
| Lawful basis (proposed) | `legal_obligation` |
| Tables | `privacy_requests` |
| Personal fields (P2) | 1: `privacy_requests.user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `consent_evidence`: Life of the account plus 5 years after withdrawal or closure (proposed) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V1, V2, V37, V38, V70, V77 |

### Seller onboarding, KYC and payout identity (`seller_onboarding_kyc`)

Verify sellers and signatories, check brand authorisation, verify IBAN for payouts.

| Item | Value |
|---|---|
| Data subjects | admin_staff, seller_representative, shopper |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `brand_authorizations`, `kyc_checks`, `kyc_documents`, `media_assets`, `payout_instruments`, `seller_kyc_cases`, `seller_signatories`, `sellers` |
| Personal fields (P2) | 8: `media_assets.uploaded_by`, `seller_signatories.user_id`, `seller_signatories.national_id_bidx`, `seller_signatories.role_title`, `seller_signatories.verified_at`, `seller_kyc_cases.decided_by`, `payout_instruments.iban_bidx`, `brand_authorizations.reviewed_by` |
| Sensitive fields (P3) | 8: `seller_signatories.full_name_ct`, `seller_signatories.national_id_ct`, `seller_signatories.dob_ct`, `seller_signatories.phone_ct`, `kyc_documents.extracted_ct`, `kyc_checks.raw_ct`, `payout_instruments.iban_ct`, `payout_instruments.account_name_ct` |
| Recipients and processors | `cloud_cell`, `global_catalog_plane`, `global_edge`, `kyc_provider`, `psp_primary` |
| Possible cross-border transfer | `global_catalog_plane` (yes), `global_edge` (yes), `kyc_provider` (unknown) |
| Residency | `cell`, `cell_publishable` |
| Retention | `catalog_life`: Life of the listing plus 24 months after archive (proposed); `kyc_records`: Contract end plus 5 years (master prompt B1) |
| Technical measures (field level) | `blind_index_hmac`, `field_envelope` |
| ⚠ VERIFY | V2, V4, V5, V8, V16, V36, V37, V38, V39, V41, V46, V47, V68, V72, V73, V75 |

### Catalog and storefront publishing (`catalog_publishing`)

Listings, condition grades, defect cards, defect passports, storefronts, public product pages.

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper |
| Lawful basis (proposed) | `contract` |
| Tables | `media_assets` |
| Personal fields (P2) | 1: `media_assets.uploaded_by` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `global_catalog_plane`, `global_edge` |
| Possible cross-border transfer | `global_catalog_plane` (yes), `global_edge` (yes) |
| Residency | `cell`, `cell_publishable` |
| Retention | `catalog_life`: Life of the listing plus 24 months after archive (proposed) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V16, V37, V38, V39, V47, V68, V75 |

### Price Watch and discount verification (`price_integrity`)

Verify reference prices, monitor seller channels with consent, enforce honest discounts (CPL 181/2018).

| Item | Value |
|---|---|
| Data subjects | admin_staff, seller_representative, shopper |
| Lawful basis (proposed) | `contract`, `legitimate_interest` |
| Tables | `enforcement_actions`, `price_appeals`, `price_check_runs`, `price_events`, `price_reports`, `product_matches` |
| Personal fields (P2) | 7: `product_matches.confirmed_by`, `price_events.actor_id`, `enforcement_actions.reviewed_by`, `price_appeals.submitted_by`, `price_check_runs.requested_by`, `price_reports.user_id`, `price_reports.note` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `global_catalog_plane`, `global_edge` |
| Possible cross-border transfer | `global_catalog_plane` (yes), `global_edge` (yes) |
| Residency | `cell`, `cell_publishable` |
| Retention | `fraud_24m`: 24 months rolling (proposed); `price_evidence_7y`: 7 years (evidence for consumer-protection inquiries; proposed); `snapshots_13m`: 13 months raw; evidence cited by a claim or finding is copied into price_evidence |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V13, V15, V16, V20, V28, V37, V38, V39, V47, V68, V70, V71, V75, V78 |

### Orders and fulfilment (`order_fulfilment`)

Bag, checkout, order split by store, order tracking and delivery data shared with sellers.

| Item | Value |
|---|---|
| Data subjects | delivery_recipient, seller_representative, shopper |
| Lawful basis (proposed) | `contract` |
| Tables | `addresses`, `cart_lines`, `carts`, `checkout_sessions`, `delivery_snapshots`, `inventory_adjustments`, `order_groups`, `order_lines`, `order_status_history`, `reservations`, `seller_orders`, `wishlist_items`, `wishlist_members`, `wishlists` |
| Personal fields (P2) | 29: `addresses.user_id`, `addresses.label`, `addresses.geo_area_id`, `reservations.user_id`, `inventory_adjustments.actor_id`, `carts.user_id`, `cart_lines.user_id`, `cart_lines.defect_ack_at`, `wishlists.user_id`, `wishlists.intent`, `wishlists.title`, `wishlists.target_date`, `wishlists.budget_minor`, `wishlists.share_token_hash`, `wishlist_members.user_id`, `wishlist_items.note`, `wishlist_items.added_by`, `checkout_sessions.user_id`, `checkout_sessions.cart_snapshot`, `checkout_sessions.address_id`, `order_groups.user_id`, `order_groups.placed_at`, `seller_orders.user_id`, `order_lines.user_id`, `order_lines.defect_ack_at`, `delivery_snapshots.user_id`, `delivery_snapshots.country_code`, `delivery_snapshots.geo_area_id`, `order_status_history.actor_id` |
| Sensitive fields (P3) | 8: `addresses.recipient_name_ct`, `addresses.phone_ct`, `addresses.address_ct`, `addresses.pin_ct`, `delivery_snapshots.recipient_name_ct`, `delivery_snapshots.phone_ct`, `delivery_snapshots.address_ct`, `delivery_snapshots.pin_ct` |
| Recipients and processors | `cloud_cell`, `courier_domestic` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `cart_active`: While the account is active; abandoned lines purged after 180 days; `checkout_90d`: 90 days; `delivery_24m`: 24 months after delivery or return closure; seller access ends 30 days after delivery; `tax_records`: 7 years after the financial year end (proposed; master prompt assumes 5-7 years) |
| Technical measures (field level) | `field_envelope`, `one_way_hash` |
| ⚠ VERIFY | V2, V6, V7, V11, V19, V26, V33, V37, V38, V43, V71, V77 |

### Payment processing (`payment_processing`)

Create, confirm, refund and reconcile payments through PSPs. Card data stays with the PSP (PCI SAQ A).

| Item | Value |
|---|---|
| Data subjects | shopper |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `payment_events_raw`, `payment_intents`, `payment_links`, `payment_tenders`, `saved_payment_methods` |
| Personal fields (P2) | 11: `payment_links.user_id`, `payment_links.token_hash`, `payment_intents.user_id`, `payment_tenders.user_id`, `saved_payment_methods.user_id`, `saved_payment_methods.brand`, `saved_payment_methods.last4`, `saved_payment_methods.exp_month`, `saved_payment_methods.exp_year`, `saved_payment_methods.fingerprint_hash`, `payment_events_raw.body_ct` |
| Sensitive fields (P3) | 1: `saved_payment_methods.psp_token_ct` |
| Recipients and processors | `cloud_cell`, `psp_fawry`, `psp_primary`, `whatsapp_bsp` |
| Possible cross-border transfer | `whatsapp_bsp` (yes) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `checkout_90d`: 90 days; `raw_webhooks_financial`: 7 years (financial evidence, master prompt B1); bodies pseudonymised on erasure; `tax_records`: 7 years after the financial year end (proposed; master prompt assumes 5-7 years) |
| Technical measures (field level) | `field_envelope`, `one_way_hash` |
| ⚠ VERIFY | V2, V4, V5, V6, V36, V37, V38, V41, V44, V71, V73 |

### Ledger and closed-loop store credit (`wallet_ledger`)

Double-entry ledger, store credit lots, holds and payouts (ADR-0003).

| Item | Value |
|---|---|
| Data subjects | admin_staff, shopper |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `credit_lot_movements`, `credit_lots`, `ledger_accounts`, `payout_holds` |
| Personal fields (P2) | 5: `ledger_accounts.code`, `ledger_accounts.owner_id`, `payout_holds.created_by`, `credit_lots.user_id`, `credit_lot_movements.user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `tax_records`: 7 years after the financial year end (proposed; master prompt assumes 5-7 years) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V3, V6, V37, V38, V71, V77 |

### Tax, invoicing and accounting records (`tax_accounting`)

ETA e-invoices and e-receipts, VAT, financial records kept for the legal period.

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper |
| Lawful basis (proposed) | `legal_obligation` |
| Tables | `eta_submissions`, `tax_documents` |
| Personal fields (P2) | 3: `tax_documents.recipient_id`, `tax_documents.signed_doc_media_id`, `eta_submissions.response_ct` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `eta_portal` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `tax_records`: 7 years after the financial year end (proposed; master prompt assumes 5-7 years) |
| Technical measures (field level) | `field_envelope` |
| ⚠ VERIFY | V2, V6, V37, V38, V71 |

### Delivery and COD logistics (`delivery_logistics`)

Shipping quotes, parcels, courier tracking, proof of delivery, COD remittance.

| Item | Value |
|---|---|
| Data subjects | delivery_recipient, seller_representative, shopper |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `courier_events_raw`, `delivery_snapshots`, `shipment_events`, `shipment_quotes`, `shipments`, `store_locations` |
| Personal fields (P2) | 13: `store_locations.address_ct`, `store_locations.contact_phone_ct`, `delivery_snapshots.user_id`, `delivery_snapshots.country_code`, `delivery_snapshots.geo_area_id`, `shipment_quotes.user_id`, `shipment_quotes.destination_country`, `shipment_quotes.dest_geo_area_id`, `shipments.user_id`, `shipments.label_media_id`, `shipments.proof_media_id`, `shipment_events.location_text`, `courier_events_raw.body_ct` |
| Sensitive fields (P3) | 4: `delivery_snapshots.recipient_name_ct`, `delivery_snapshots.phone_ct`, `delivery_snapshots.address_ct`, `delivery_snapshots.pin_ct` |
| Recipients and processors | `cloud_cell`, `courier_domestic` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `catalog_life`: Life of the listing plus 24 months after archive (proposed); `delivery_24m`: 24 months after delivery or return closure; seller access ends 30 days after delivery; `quotes_30d`: 30 days; quotes used by an order are copied onto the order; `raw_webhooks_financial`: 7 years (financial evidence, master prompt B1); bodies pseudonymised on erasure |
| Technical measures (field level) | `field_envelope` |
| ⚠ VERIFY | V2, V11, V26, V33, V34, V37, V38, V43, V71 |

### Returns, refunds and disputes (`returns_refunds`)

Return requests with evidence, inspections, disputes and refund routing.

| Item | Value |
|---|---|
| Data subjects | admin_staff, seller_representative, shopper |
| Lawful basis (proposed) | `contract`, `legal_obligation` |
| Tables | `disputes`, `media_assets`, `refunds`, `return_evidence`, `return_inspections`, `return_requests` |
| Personal fields (P2) | 7: `media_assets.uploaded_by`, `return_requests.user_id`, `return_evidence.media_id`, `return_inspections.inspected_by`, `disputes.user_id`, `disputes.assigned_staff_id`, `refunds.user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `global_catalog_plane`, `global_edge`, `psp_primary` |
| Possible cross-border transfer | `global_catalog_plane` (yes), `global_edge` (yes) |
| Residency | `cell`, `cell_publishable` |
| Retention | `catalog_life`: Life of the listing plus 24 months after archive (proposed); `returns_evidence_24m`: 24 months after the return closes (proposed); `tax_records`: 7 years after the financial year end (proposed; master prompt assumes 5-7 years) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V4, V5, V6, V7, V16, V19, V36, V37, V38, V39, V41, V47, V68, V71, V75 |

### Promotions, vouchers and drops (`promotions`)

Vouchers, store bundles, Drop Hour, Outlet Parties and per-user purchase limits.

| Item | Value |
|---|---|
| Data subjects | shopper |
| Lawful basis (proposed) | `contract` |
| Tables | `drop_purchase_counters`, `voucher_redemptions`, `vouchers` |
| Personal fields (P2) | 3: `vouchers.assigned_user_id`, `voucher_redemptions.user_id`, `drop_purchase_counters.user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `fraud_24m`: 24 months rolling (proposed); `tax_records`: 7 years after the financial year end (proposed; master prompt assumes 5-7 years) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V6, V37, V38, V71, V78 |

### Fraud, abuse and COD risk (`fraud_prevention`)

Risk scores, COD refusal history, device and instrument links, rate-limit evidence.

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper, visitor |
| Lawful basis (proposed) | `contract`, `legitimate_interest` |
| Tables | `cod_confirmations`, `cod_refusals`, `drop_purchase_counters`, `otp_challenges`, `risk_assessments`, `risk_links`, `user_risk_profiles` |
| Personal fields (P2) | 20: `otp_challenges.phone_bidx`, `otp_challenges.code_hash`, `otp_challenges.device_id`, `otp_challenges.ip_hmac`, `drop_purchase_counters.user_id`, `risk_assessments.user_id`, `risk_assessments.score`, `risk_assessments.decision`, `risk_assessments.reasons`, `user_risk_profiles.user_id`, `user_risk_profiles.cod_status`, `user_risk_profiles.cod_restricted_until`, `user_risk_profiles.refusals_90d`, `user_risk_profiles.delivered_orders`, `cod_refusals.user_id`, `cod_refusals.reason`, `cod_refusals.refused_at`, `cod_confirmations.user_id`, `risk_links.value_hash`, `risk_links.user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `sms_provider`, `whatsapp_bsp` |
| Possible cross-border transfer | `sms_provider` (unknown), `whatsapp_bsp` (yes) |
| Residency | `cell` |
| Retention | `delivery_24m`: 24 months after delivery or return closure; seller access ends 30 days after delivery; `fraud_24m`: 24 months rolling (proposed); `otp_30d`: 30 days |
| Technical measures (field level) | `blind_index_hmac`, `one_way_hash` |
| ⚠ VERIFY | V2, V26, V37, V38, V44, V45, V70, V78 |

### Transactional messages (`transactional_comms`)

Order, delivery, security and price-enforcement messages that do not need marketing consent.

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper |
| Lawful basis (proposed) | `consent`, `contract` |
| Tables | `in_app_messages`, `notification_deliveries`, `notification_requests`, `product_alerts` |
| Personal fields (P2) | 7: `product_alerts.user_id`, `notification_requests.user_id`, `notification_requests.payload`, `notification_deliveries.destination_hash`, `in_app_messages.user_id`, `in_app_messages.title`, `in_app_messages.body` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `email_provider`, `sms_provider`, `web_push`, `whatsapp_bsp` |
| Possible cross-border transfer | `email_provider` (unknown), `sms_provider` (unknown), `web_push` (yes), `whatsapp_bsp` (yes) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `in_app_90d`: 90 days; `notification_12m`: 12 months |
| Technical measures (field level) | `one_way_hash` |
| ⚠ VERIFY | V2, V37, V38, V39, V44, V45 |

### Marketing messages (`marketing_comms`)

Marketing push, WhatsApp and email, only with the matching consent purpose.

| Item | Value |
|---|---|
| Data subjects | seller_representative, shopper |
| Lawful basis (proposed) | `consent`, `contract` |
| Tables | `notification_deliveries`, `notification_preferences`, `notification_requests` |
| Personal fields (P2) | 5: `notification_preferences.user_id`, `notification_preferences.enabled`, `notification_requests.user_id`, `notification_requests.payload`, `notification_deliveries.destination_hash` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `email_provider`, `sms_provider`, `web_push`, `whatsapp_bsp` |
| Possible cross-border transfer | `email_provider` (unknown), `sms_provider` (unknown), `web_push` (yes), `whatsapp_bsp` (yes) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `notification_12m`: 12 months |
| Technical measures (field level) | `one_way_hash` |
| ⚠ VERIFY | V2, V37, V38, V39, V44, V45 |

### Search and discovery (`search_discovery`)

Search index sync, saved searches, query logs without direct identifiers.

| Item | Value |
|---|---|
| Data subjects | shopper, visitor |
| Lawful basis (proposed) | `contract`, `legitimate_interest` |
| Tables | `saved_searches`, `search_queries`, `store_follows`, `user_preferences` |
| Personal fields (P2) | 10: `user_preferences.user_id`, `user_preferences.numeral_pref`, `user_preferences.world_filter`, `user_preferences.destination_country`, `user_preferences.personalization_enabled`, `store_follows.user_id`, `store_follows.last_seen_at`, `saved_searches.user_id`, `saved_searches.filter_json`, `search_queries.normalized_query` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `account_active`: Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period); `search_logs_25m`: 25 months, then aggregated |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V37, V38, V76 |

### Size and fit (`fit_sizing`)

Size profiles and measurements for My Size Only, only with the measurements consent.

| Item | Value |
|---|---|
| Data subjects | child, shopper |
| Lawful basis (proposed) | `consent` |
| Tables | `size_profiles` |
| Personal fields (P2) | 6: `size_profiles.user_id`, `size_profiles.label`, `size_profiles.is_child`, `size_profiles.usual_sizes`, `size_profiles.fit_pref`, `size_profiles.modest_fit` |
| Sensitive fields (P3) | 1: `size_profiles.measurements_ct` |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `measurements`: Until the user deletes the profile, withdraws the measurements consent or closes the account |
| Technical measures (field level) | `field_envelope` |
| ⚠ VERIFY | V2, V37, V38, V73, V74 |

### Reviews and shopper requests (`reviews_ugc`)

Verified-purchase fit-photo reviews and WhatsApp see-it-first video requests.

| Item | Value |
|---|---|
| Data subjects | shopper |
| Lawful basis (proposed) | `consent`, `contract` |
| Tables | `review_media`, `reviews`, `see_it_first_requests` |
| Personal fields (P2) | 6: `reviews.user_id`, `reviews.order_line_id`, `reviews.body`, `reviews.show_display_name`, `review_media.media_id`, `see_it_first_requests.user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `whatsapp_bsp` |
| Possible cross-border transfer | `whatsapp_bsp` (yes) |
| Residency | `cell` |
| Retention | `delivery_24m`: 24 months after delivery or return closure; seller access ends 30 days after delivery; `ugc_published`: While published; 24 months after removal for disputes (proposed) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V37, V38, V44 |

### Product analytics (`analytics_product`)

Pseudonymous product events, only after the analytics consent.

| Item | Value |
|---|---|
| Data subjects | shopper, visitor |
| Lawful basis (proposed) | `consent`, `legitimate_interest` |
| Tables | `analytics_events`, `search_queries` |
| Personal fields (P2) | 3: `search_queries.normalized_query`, `analytics_events.pseudo_id`, `analytics_events.session_hash` |
| Sensitive fields (P3) | none |
| Recipients and processors | `analytics_warehouse`, `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `analytics_25m`: 25 months, then aggregated (master prompt B1); `search_logs_25m`: 25 months, then aggregated |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V37, V38, V76 |

### Security logging and audit (`security_audit`)

Hash-chained audit log, staff PII-access log, approval records.

| Item | Value |
|---|---|
| Data subjects | admin_staff, seller_representative, shopper |
| Lawful basis (proposed) | `legal_obligation` |
| Tables | `approval_requests`, `audit_log`, `pii_access_log` |
| Personal fields (P2) | 8: `audit_log.actor_id`, `audit_log.diff`, `audit_log.ip_hmac`, `audit_log.device_id`, `approval_requests.requested_by`, `approval_requests.decided_by`, `pii_access_log.staff_id`, `pii_access_log.subject_user_id` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `audit_7y`: 7 years (proposed), WORM copy; `pii_access_2y`: 24 months (proposed) |
| Technical measures (field level) | `blind_index_hmac` |
| ⚠ VERIFY | V1, V2, V37, V38, V70, V71 |

### Staff access control (`staff_access`)

Admin staff accounts, roles, just-in-time grants and dual approval.

| Item | Value |
|---|---|
| Data subjects | admin_staff, seller_representative |
| Lawful basis (proposed) | `contract` |
| Tables | `staff_accounts`, `staff_passkeys`, `staff_role_assignments`, `staff_sessions`, `store_invites`, `store_members` |
| Personal fields (P2) | 19: `staff_accounts.id`, `staff_accounts.email_ct`, `staff_accounts.email_bidx`, `staff_accounts.display_name`, `staff_accounts.sso_subject_hash`, `staff_passkeys.staff_id`, `staff_passkeys.credential_id`, `staff_role_assignments.staff_id`, `staff_role_assignments.granted_by`, `staff_sessions.staff_id`, `staff_sessions.ip_hmac`, `staff_sessions.user_agent_hash`, `store_members.user_id`, `store_members.invited_by`, `store_members.joined_at`, `store_members.removed_at`, `store_invites.contact_bidx`, `store_invites.token_hash`, `store_invites.created_by` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `auth_30d`: 30 days after expiry or revocation; `staff_access`: 12 months after the staff contract ends |
| Technical measures (field level) | `blind_index_hmac`, `field_envelope`, `one_way_hash` |
| ⚠ VERIFY | V2, V37, V38 |

### Reliability plumbing (`platform_reliability`)

Outbox, inbox, idempotency keys, sagas and dedup records that stop duplicate side effects.

| Item | Value |
|---|---|
| Data subjects | admin_staff, seller_representative, shopper |
| Lawful basis (proposed) | `contract` |
| Tables | `dlq_messages`, `idempotency_keys`, `outbox_events`, `saga_instances` |
| Personal fields (P2) | 5: `outbox_events.payload`, `idempotency_keys.actor_id`, `idempotency_keys.response_body`, `saga_instances.context`, `dlq_messages.payload` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell` |
| Possible cross-border transfer | none planned (cell only) |
| Residency | `cell` |
| Retention | `checkout_90d`: 90 days; `dedup_90d`: 90 days (webhook dedup window); `idempotency_24h`: 24 hours (partition dropped after 48 hours); `outbox_60d`: 60 days after publish (partition drop) |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V37, V38 |

### AI assistance metering (`ai_assist`)

Listing copilot and NL search usage metering; only public catalog data is sent to models.

| Item | Value |
|---|---|
| Data subjects | seller_representative |
| Lawful basis (proposed) | `contract` |
| Tables | `listing_copilot_runs` |
| Personal fields (P2) | 1: `listing_copilot_runs.requested_by` |
| Sensitive fields (P3) | none |
| Recipients and processors | `cloud_cell`, `llm_provider` |
| Possible cross-border transfer | `llm_provider` (yes) |
| Residency | `cell` |
| Retention | `llm_meter_13m`: 13 months |
| Technical measures (field level) | row access control only (RLS, policy guard) |
| ⚠ VERIFY | V2, V37, V38 |

## 5. Recipients, processors and transfers

| Key | Processor or recipient | Candidates | Location | Cross-border | DPA | ⚠ VERIFY |
|---|---|---|---|---|---|---|
| `cloud_cell` | Market cell cloud (Postgres, object storage, KMS, queues) for EG | Huawei Cloud Cairo (after 1-week spike), AWS me-central-1 fallback (needs transfer licence) | EG (target) | no | not started | V2, V37, V38 |
| `global_edge` | Global edge: CDN, WAF, bot management, waiting room — Sees IP addresses and request metadata of every visitor. Caches only public pages. Counts as a transfer for request metadata. | Cloudflare (Cairo PoP) | global | yes | not started | V2, V16, V39, V68 |
| `global_catalog_plane` | Global public plane: Next.js rendering, public catalog read models, search engine, public images — Receives only P0 columns through public outbox events (CI test on the projection). P0 can still be personal data where a sole trader's legal identity is published (V75), so it is treated as a possible transfer. | Vercel or AWS + Typesense/Meilisearch/OpenSearch (bake-off) | global | yes | not started | V2, V47, V75 |
| `psp_primary` | Payment service provider (cards, Apple Pay, Meeza, wallets, InstaPay, BNPL via PSP) | Paymob, Kashier | EG (verify) | no | not started | V4, V5, V36, V41 |
| `psp_fawry` | Fawry reference-code and failover channel | Fawry | EG (verify) | no | not started | V4 |
| `courier_domestic` | Domestic couriers | Bosta, Aramex | EG (verify) | no | not started | V11, V26, V33, V43 |
| `courier_international` | International express couriers (Phase 2) | Aramex, DHL Express, Egypt Post EMS | EG + destination | yes | not started | V2, V33, V34 |
| `sms_provider` | SMS OTP and transactional SMS | to be chosen | unknown | unknown | not started | V2, V45 |
| `whatsapp_bsp` | WhatsApp Business Solution Provider | to be chosen | unknown (Meta infrastructure abroad) | yes | not started | V2, V44 |
| `email_provider` | Transactional and marketing email | to be chosen | unknown | unknown | not started | V2 |
| `web_push` | Browser push services (Apple, Google, Mozilla push endpoints) — Payloads are end-to-end encrypted (RFC 8291) and carry no personal data beyond the endpoint. | platform push services | global | yes | not started | V2, V39 |
| `kyc_provider` | KYC: ID OCR, liveness, face match | Valify | unknown (verify) | unknown | not started | V2, V46, V73 |
| `eta_portal` | Egyptian Tax Authority e-invoice / e-receipt portal — Public authority recipient, not a processor. | ETA | EG | no | not started | V6 |
| `llm_provider` | LLM provider via llm-gateway (listing copilot, NL search parse) — Receives public catalog text and seller-authored listing drafts only; no P2/P3. | to be chosen | abroad (likely) | yes | not started | V2 |
| `seller_channels` | Seller's own shop platforms (Shopify, WooCommerce, feeds) — Source of price evidence. We read from them with seller consent; we send no personal data. | Shopify, WooCommerce | global | no | not started | V27 |
| `observability` | Logs, traces, error tracking | self-hosted in the cell (default), Sentry (only with transfer licence) | EG (default) | no | not started | V2 |
| `analytics_warehouse` | Analytics warehouse (ClickHouse, self-hosted in the cell) | ClickHouse in cell | EG | no | not started | V2 |

## 6. Retention schedule

| Rule | Period | Tables using it | ⚠ VERIFY |
|---|---|---|---|
| `account_active` | Life of the account; erase or pseudonymise 14 days after a deletion request (cooling period) | 15 | - |
| `auth_30d` | 30 days after expiry or revocation | 3 | - |
| `otp_30d` | 30 days | 1 | - |
| `device_13m` | 13 months after last seen | 1 | - |
| `underage_block_30d` | 30 days (soft re-try block) | 1 | - |
| `consent_evidence` | Life of the account plus 5 years after withdrawal or closure (proposed) | 4 | V1, V70 |
| `tax_records` | 7 years after the financial year end (proposed; master prompt assumes 5-7 years) | 51 | V6, V71 |
| `raw_webhooks_financial` | 7 years (financial evidence, master prompt B1); bodies pseudonymised on erasure | 2 | V71 |
| `kyc_records` | Contract end plus 5 years (master prompt B1) | 7 | V72 |
| `staff_access` | 12 months after the staff contract ends | 5 | - |
| `audit_7y` | 7 years (proposed), WORM copy | 6 | V71 |
| `pii_access_2y` | 24 months (proposed) | 1 | V1 |
| `analytics_25m` | 25 months, then aggregated (master prompt B1) | 1 | - |
| `delivery_24m` | 24 months after delivery or return closure; seller access ends 30 days after delivery | 6 | - |
| `returns_evidence_24m` | 24 months after the return closes (proposed) | 3 | V7 |
| `notification_12m` | 12 months | 2 | - |
| `in_app_90d` | 90 days | 1 | - |
| `dedup_30d` | 30 days (technical dedup window) | 1 | - |
| `dedup_90d` | 90 days (webhook dedup window) | 2 | - |
| `idempotency_24h` | 24 hours (partition dropped after 48 hours) | 1 | - |
| `outbox_60d` | 60 days after publish (partition drop) | 1 | - |
| `quotes_30d` | 30 days; quotes used by an order are copied onto the order | 1 | - |
| `checkout_90d` | 90 days | 6 | - |
| `cart_active` | While the account is active; abandoned lines purged after 180 days | 2 | - |
| `fraud_24m` | 24 months rolling (proposed) | 6 | V78 |
| `measurements` | Until the user deletes the profile, withdraws the measurements consent or closes the account | 1 | V74 |
| `ugc_published` | While published; 24 months after removal for disputes (proposed) | 2 | - |
| `search_logs_25m` | 25 months, then aggregated | 1 | - |
| `snapshots_13m` | 13 months raw; evidence cited by a claim or finding is copied into price_evidence | 2 | - |
| `price_evidence_7y` | 7 years (evidence for consumer-protection inquiries; proposed) | 13 | V20, V71 |
| `catalog_life` | Life of the listing plus 24 months after archive (proposed) | 25 | - |
| `config_versions` | Life of the platform; versions kept while referenced | 34 | - |
| `llm_meter_13m` | 13 months | 1 | - |

## 7. DSAR scope (export and erasure)

Tables keyed to a user (`user_id`, or `users.id`) are in the export. On erasure, rows under `tax_records`, `raw_webhooks_financial`, `audit_7y` or `price_evidence_7y` are pseudonymised (user link tombstoned, P2/P3 fields nulled or crypto-shredded), not deleted (V47). Everything else is deleted after the 14-day cooling period.

| Table | On erasure |
|---|---|
| `users` | delete |
| `user_identities` | delete |
| `passkey_credentials` | delete |
| `totp_credentials` | delete |
| `devices` | delete |
| `session_families` | delete |
| `age_attestations` | pseudonymise, keep for `consent_evidence` |
| `addresses` | delete |
| `user_preferences` | delete |
| `store_follows` | delete |
| `consent_records` | pseudonymise, keep for `consent_evidence` |
| `consent_state` | delete |
| `privacy_requests` | pseudonymise, keep for `consent_evidence` |
| `seller_signatories` | pseudonymise, keep for `kyc_records` |
| `store_members` | delete |
| `size_profiles` | delete |
| `reviews` | delete |
| `see_it_first_requests` | delete |
| `price_reports` | delete |
| `reservations` | delete |
| `carts` | delete |
| `cart_lines` | delete |
| `wishlists` | delete |
| `wishlist_members` | delete |
| `product_alerts` | delete |
| `checkout_sessions` | delete |
| `order_groups` | pseudonymise, keep for `tax_records` |
| `seller_orders` | pseudonymise, keep for `tax_records` |
| `order_lines` | pseudonymise, keep for `tax_records` |
| `delivery_snapshots` | delete |
| `payment_links` | delete |
| `payment_intents` | pseudonymise, keep for `tax_records` |
| `payment_tenders` | pseudonymise, keep for `tax_records` |
| `saved_payment_methods` | delete |
| `credit_lots` | pseudonymise, keep for `tax_records` |
| `credit_lot_movements` | pseudonymise, keep for `tax_records` |
| `return_requests` | pseudonymise, keep for `tax_records` |
| `disputes` | delete |
| `refunds` | pseudonymise, keep for `tax_records` |
| `shipment_quotes` | delete |
| `shipments` | delete |
| `voucher_redemptions` | pseudonymise, keep for `tax_records` |
| `drop_purchase_counters` | delete |
| `risk_assessments` | delete |
| `user_risk_profiles` | delete |
| `cod_refusals` | delete |
| `cod_confirmations` | delete |
| `risk_links` | delete |
| `notification_preferences` | delete |
| `notification_requests` | delete |
| `in_app_messages` | delete |
| `saved_searches` | delete |

## 8. Security measures (all purposes)

| Area | Measure |
|---|---|
| Encryption | TLS 1.2+ (prefer 1.3); AES-256 at rest; P3 fields with KMS envelope encryption (AES-256-GCM, key id in the ciphertext header); HMAC blind indexes with a separate key; yearly key rotation with lazy re-encryption; separate keys for encryption, blind index and audit signing. |
| Access control | Deny by default; policy guard on every route plus Postgres RLS (FORCE, non-owner role, `SET LOCAL` per transaction); 404 for objects not owned; passkeys mandatory for seller staff and admins; just-in-time admin roles; dual approval for exports, high refunds, payouts and role grants. |
| Accountability | Hash-chained, sealed `audit_log` with WORM copy; `pii_access_log` for every staff reveal of P2/P3 with a reason code; consent records append-only. |
| Minimisation | Sellers see delivery data only for active orders and lose access 30 days after delivery; masked relay phone numbers where couriers support them; no raw IPs (keyed hashes only); search logs without user ids; no P2/P3 to LLMs; public reviews anonymous by default. |
| Residency | Personal, money and stock data in the cell; only P0 columns cross to the global plane through public outbox events, checked in CI. |
| Payment data | PCI SAQ A: card data never touches our systems; only PSP tokens, brand, last 4 and expiry. |
| Resilience | PITR, RPO ≤ 15 min, RTO ≤ 1 h, monthly restore drills. |
| Breach response | Runbook with triage ≤ 4 h, DPO decision, PDPC notice ≤ 72 h, subject notice ≤ 3 days, tracked in `breach_records` (V1). |
| Retention | Nightly purge jobs per rule with a metric (`retention_runs`); partitions dropped for time-boxed data. |

## 9. Data subject rights

| Right | How | Deadline |
|---|---|---|
| Access and portability | `POST /v1/me/privacy/export` → AR/EN ZIP, signed URL valid 24 h | ≤ 30 days default, statutory deadline ⚠ V1 |
| Erasure | `POST /v1/me/privacy/delete`; blocked while orders, returns or disputes are open; 14-day cooling; financial rows pseudonymised (V77) | as above |
| Rectification | Profile edit; DOB once through support with audit | as above |
| Withdraw consent | One tap in Privacy Center; takes effect immediately in `consent_state` | immediate |
| Object / restrict | `privacy_requests.kind = object / restrict`; personalization toggle | as above |
| Automated decisions | COD restrictions explained with reason codes; human review on request (V78) | as above |

## 10. Open items for counsel and the DPO

V1, V2, V39 (licence, transfer, encrypted data abroad); V70 (lawful bases); V71, V72 (retention periods); V73, V74 (sensitive and children's data); V75 (public seller identity); V76 (pre-consent server events); V77 (erasure vs retention); V78 (automated decisions). V70–V78 are **proposed** numbers and may be renumbered when merged into the verify register.
