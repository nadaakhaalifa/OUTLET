import type { ExporterDescriptor, ExporterExemption } from "../domain/ports";

/**
 * Exporter manifest: which exporter owns which inventory table, and which tables are explicitly
 * exempt from the shopper DSAR export (spec B1 data subject rights).
 *
 * The coverage test (exporter-coverage.test.ts) fails when docs/privacy/data_inventory.yaml gains a
 * P2/P3 table tagged for export that is in neither list. Add the table to the exporter of the module
 * that owns it, or add an exemption WITH a reason. Exporters are implemented behind ExporterPort by
 * the owning module; this manifest only declares ownership.
 */
export const EXPORTER_MANIFEST: readonly ExporterDescriptor[] = [
  { key: "account_auth", tables: ["devices", "identities", "session_families", "sessions", "users"] },
  { key: "age_assurance", tables: ["age_attestations"] },
  { key: "budget_insights", tables: ["budget_cycles", "budgets", "installment_commitments", "savings_goals"] },
  { key: "catalog_browse", tables: ["accessibility_preferences", "carts", "saved_searches", "user_favorite_stores", "wishlist_items", "wishlists"] },
  { key: "consent_management", tables: ["consent_records"] },
  { key: "customer_support", tables: ["support_messages", "support_tickets"] },
  { key: "delivery_logistics", tables: ["cod_remittance_lines", "courier_events_raw", "shipments"] },
  { key: "fit_sizing", tables: ["body_scan_capture", "fit_feedback", "fit_model_params", "size_alerts", "size_demand_events", "size_profiles"] },
  { key: "gifting", tables: ["gift_card_messages", "gift_card_redemptions", "gift_cards", "group_gift_pots"] },
  { key: "loyalty_referral", tables: ["affiliate_clicks", "commissions", "creator_accounts", "referral_codes", "referrals"] },
  { key: "marketing_comms", tables: ["notification_frequency_counters", "notification_preferences"] },
  { key: "order_fulfilment", tables: ["addresses", "delivery_snapshots", "order_buyer_contacts", "order_groups", "order_lines", "order_status_history", "promotion_redemptions", "reservation_lines", "reservations", "seller_orders"] },
  { key: "payment_processing", tables: ["payment_events_raw", "payment_methods"] },
  { key: "personalization_stylist", tables: ["outfit_calendar_events", "outfits", "style_profiles", "stylist_feedback", "wardrobe_items"] },
  { key: "privacy_rights", tables: ["breach_affected_subjects", "dsar_requests"] },
  { key: "returns_refunds", tables: ["return_disputes", "return_evidence", "returner_standing", "returns"] },
  { key: "reviews_social", tables: ["live_chat_messages", "moderation_log", "questions", "reviews", "ugc_reports"] },
  { key: "subscriptions_plus", tables: ["subscription_invoices", "subscriptions"] },
  { key: "tax_receipts", tables: ["eta_signed_documents", "tax_documents"] },
  { key: "transactional_comms", tables: ["inbox_messages", "notification_log", "notification_push_tokens", "notification_requests", "notification_suppressions"] },
  { key: "wallet_ledger", tables: ["ledger_accounts"] },
];

export const EXPORT_EXEMPTIONS: readonly ExporterExemption[] = [
  { table: "age_block_devices", reason: "Visitor device hash, not linkable to an account by design (spec section 1 Rules)." },
  { table: "analytics_events", reason: "Pseudonymous rotating identifier, not linkable to an account without additional data. VERIFY with counsel." },
  { table: "audit_log", reason: "Append-only hash-chained evidence. The subject's entries are released by the DPO on request. VERIFY." },
  { table: "catalog_imports", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "cod_refusal_history", reason: "Fraud-prevention signal; the outcome is visible in the order history that is exported. VERIFY." },
  { table: "corporate_accounts", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "crash_reports", reason: "Pseudonymous, scrubbed at the SDK. VERIFY with counsel." },
  { table: "device_ip_graph_edges", reason: "Fraud-prevention signal; disclosure would defeat the control. VERIFY the lawful exemption under PDPL." },
  { table: "idempotency_keys", reason: "Technical dedup row: request hash and cached response envelope, expires within 24 hours." },
  { table: "inventory_adjustments", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "llm_external_calls", reason: "Call audit holds prompt hash, model and token counts only (spec T12). VERIFY field list when the table lands." },
  { table: "otp_challenges", reason: "Credential material: code hash only, valid 5 minutes, purged within 30 days." },
  { table: "outbox_events", reason: "Technical relay row: identifiers only, removed after publication (retention technical_dedup)." },
  { table: "payout_instruments", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "price_events", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "promotions", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "request_logs", reason: "Edge logs keyed by IP, 30 day retention, not indexed by account. VERIFY with counsel." },
  { table: "reservation_ttl_policies", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "risk_assessments", reason: "Fraud-prevention signal; disclosure would defeat the control. VERIFY the lawful exemption under PDPL." },
  { table: "admin_approval_requests", reason: "Staff-only dual-approval record: requester and approver are staff user ids, served by the staff privacy flow; subject_id is an identifier of the guarded object with no content. VERIFY." },
  { table: "admin_elevations", reason: "Staff-only just-in-time elevation record keyed by a staff user id, served by the staff privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "answers", reason: "Seller or staff answer: author_user_id is the answering staff member, served by the Seller Center privacy flow. The shopper question it answers is exported under reviews_social." },
  { table: "kyc_suspension_reviews", reason: "Seller KYC suspension review: personal fields are staff reviewer ids and the seller is a business; served by the Seller Center privacy flow. VERIFY." },
  { table: "review_replies", reason: "Seller public reply: author_user_id is the replying staff member and the body is a business reply, served by the Seller Center privacy flow." },
  { table: "seller_analytics_facts", reason: "Only a pseudonymous analytics shopper_key used for distinct counts, never joined to an account in this table; same treatment as analytics_events. VERIFY with counsel." },
  { table: "tax_exemption_audit", reason: "Staff-only audit of admin edits to tax exemptions (actor_id is an admin user id), retained by law and served by the staff privacy flow. VERIFY." },
  { table: "search_queries", reason: "Query log without a user key; cannot be attributed to an account." },
  { table: "seller_kyc_records", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "staff_accounts", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "store_legal_identity_public", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
  { table: "stores", reason: "Seller, staff or business data subject: served by the Seller Center privacy flow, not the shopper DSAR export. VERIFY." },
];
