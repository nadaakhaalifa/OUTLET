import type { Exemption, RuleDisposition } from "./bridge";
import type { PurgeTarget } from "./ports";

/** Resolved/terminal reservation: the order keeps the legal record. A reservation still referenced by a unit row waits for the unit rule. */
const RESERVATION_DONE = `t.status <> 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM inventory_units u WHERE u.reservation_id = t.id)`;
const RETURN_CLOSED = `EXISTS (SELECT 1 FROM returns r WHERE r.id = t.return_id AND r.state IN ('CLOSED','REFUNDED','EXCHANGED','REJECTED','CANCELLED') AND NOT EXISTS (SELECT 1 FROM return_disputes d WHERE d.return_id = r.id AND d.status IN ('OPEN','UNDER_REVIEW')))`;

/** Every handler. Each runs nightly, batched, indexed where the table has an age index, and skips legal holds. */
export const TARGETS: readonly PurgeTarget[] = [
  { id: "auth.sessions", ruleId: "auth_credentials", table: "sessions", action: "delete", pk: "id", age: "GREATEST(t.expires_at, COALESCE(t.revoked_at, t.expires_at))", holdUser: "t.user_id" },
  { id: "auth.session_families", ruleId: "auth_credentials", table: "session_families", action: "delete", pk: "id", age: "GREATEST(t.created_at, COALESCE(t.revoked_at, t.created_at))", where: "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.family_id = t.id)", holdUser: "t.user_id" },
  { id: "devices.stale", ruleId: "device_records", table: "devices", action: "delete", pk: "id", age: "t.last_seen", where: "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = t.id) AND NOT EXISTS (SELECT 1 FROM session_families f WHERE f.device_id = t.id)", holdUser: "t.user_id" },
  { id: "carts.idle", ruleId: "browsing_state", table: "carts", action: "delete", pk: "id", age: "t.updated_at", holdUser: "t.user_id" },
  { id: "outbox.published", ruleId: "technical_dedup", table: "outbox_events", action: "delete", pk: "id", age: "t.published_at", where: "t.published_at IS NOT NULL" },
  { id: "inbox.processed", ruleId: "technical_dedup", table: "inbox_processed", action: "delete", pk: "ctid", age: "t.processed_at" },
  { id: "idempotency.keys", ruleId: "technical_dedup", table: "idempotency_keys", action: "delete", pk: "ctid", age: "t.created_at", where: "t.expires_at < now()" },
  { id: "reservations.resolved", ruleId: "stock_reservation_records", table: "reservations", action: "delete", pk: "id", age: "t.resolved_at", where: RESERVATION_DONE, holdUser: "t.user_id", dependents: [{ table: "reservation_lines", fk: "reservation_id" }] },
  { id: "inventory_units.closed", ruleId: "stock_unit_rows", table: "inventory_units", action: "delete", pk: "ctid", age: "t.state_changed_at", where: "t.state IN ('CLAIMED','WRITTEN_OFF')" },
  { id: "catalog_imports.finished", ruleId: "catalog_import_records", table: "catalog_imports", action: "delete", pk: "id", age: "t.updated_at", where: "t.status IN ('completed','failed','dry_run_complete')", holdUser: "t.actor_id", dependents: [{ table: "catalog_import_errors", fk: "import_id" }, { table: "catalog_import_products", fk: "import_id" }] },
  { id: "notification_log.sent", ruleId: "notification_log", table: "notification_log", action: "delete", pk: "id", age: "t.sent_at", holdUser: "t.user_id" },
  { id: "return_evidence.closed", ruleId: "returns_evidence", table: "return_evidence", action: "delete", pk: "id", age: "t.uploaded_at", where: RETURN_CLOSED, holdUser: "(SELECT r.user_id FROM returns r WHERE r.id = t.return_id)", blobColumn: "upload_id" },
  { id: "gift_card_attempts.old", ruleId: "fraud_signals", table: "gift_card_attempts", action: "delete", pk: "id", age: "t.at", holdUser: "t.account_id" },
  { id: "outfits.old", ruleId: "personalization_data", table: "outfits", action: "delete", pk: "id", age: "t.created_at", holdUser: "t.user_id" },
  { id: "size_profiles.deleted", ruleId: "measurements", table: "size_profiles", action: "delete", pk: "id", age: "t.deleted_at", where: "t.deleted_at IS NOT NULL", holdUser: "t.user_id", grace: { value: 30, unit: "days" } },
  { id: "gift_cards.recipient_contact", ruleId: "gift_recipient_contact", table: "gift_cards", action: "nullify", pk: "id", age: "COALESCE(t.delivered_at, t.updated_at)", where: "t.status IN ('DELIVERED','REDEEMED','EXPIRED','VOIDED','CANCELLED') AND (t.recipient_contact IS NOT NULL OR t.message IS NOT NULL)", holdUser: "t.purchaser_id", nullify: ["recipient_contact", "message"] },
];

const owned = (owner: string, reason: string): Exemption => ({ kind: "owned_elsewhere", owner, reason });
const law = (reason: string): Exemption => ({ kind: "retained_by_law", reason });
const archive = (reason: string): Exemption => ({ kind: "append_only_archival", reason });
const flow = (reason: string): Exemption => ({ kind: "erasure_flow", reason });
const pending = (reason: string): Exemption => ({ kind: "pending_tables", reason });

const ids = (rule: string): readonly string[] => TARGETS.filter((t) => t.ruleId === rule).map((t) => t.id);

/** One entry per retention rule that purges something. A rule left out fails the coverage test. */
export const DISPOSITIONS: readonly RuleDisposition[] = [
  { ruleId: "account_active", targets: [], rest: owned("privacy.process-deletions", "Account erasure runs through the 14-day deletion request flow (PROCESS_DELETIONS), not by age.") },
  { ruleId: "orders_tax_records", targets: [], rest: law("Orders, ledger, invoices and ETA documents are tax records kept 7 years (spec B1, VERIFY). journal_entries, postings and price_events are append-only and immutable by trigger; they are archived or partition-dropped by the ledger archival design, never DELETEd by this job. Pseudonymisation after account erasure belongs to the erasure flow.") },
  { ruleId: "kyc_records", targets: [], rest: law("Seller KYC is kept for the contract plus 5 years. seller_kyc_records and payout_instruments are not migrated yet; kyc_suspension_reviews is legal evidence. A KYC purge handler lands with the KYC tables (inventory rows are pending).") },
  { ruleId: "analytics_events", targets: [], rest: owned("history.purge-expired-events", "user_events is purged by the history worker (25 months). The remaining tables are aggregates or not personal.") },
  { ruleId: "measurements", targets: ids("measurements") },
  { ruleId: "support_chats", targets: [], rest: pending("support_tickets and support_messages are not migrated yet; the handler is added with the support desk migration.") },
  { ruleId: "raw_webhooks_financial", targets: [], rest: archive("payment_events_raw has a DELETE-blocking trigger (financial evidence, 7 years) and the other tables are settlement and checkout evidence; deletion after 7 years needs an owner-approved migration that relaxes the guard (VERIFY).") },
  { ruleId: "seller_access_window", targets: [], rest: pending("Access ends by revoking grants, not by deleting rows; seller_delivery_access_grants is not migrated yet.") },
  { ruleId: "underage_block", targets: [], rest: pending("age_block_devices is not migrated yet.") },
  { ruleId: "audit_log", targets: [], rest: archive("audit_log is append-only and hash-chained; rows leave only by monthly partition detach after export to WORM storage, never by DELETE. Chain checkpoints must survive the detach.") },
  { ruleId: "consent_evidence", targets: [], rest: archive("consent_records is immutable by trigger and proves lawful basis; 7-year expiry is by archival, not DELETE.") },
  { ruleId: "auth_credentials", targets: ids("auth_credentials") },
  { ruleId: "device_records", targets: ids("device_records") },
  { ruleId: "browsing_state", targets: ids("browsing_state"), rest: flow("Wishlists, saved searches and favourites are user-managed and erased with the account; only abandoned carts are purged by age (90 days idle).") },
  { ruleId: "search_queries", targets: [], rest: pending("search_queries is not migrated yet (PII-free log).") },
  { ruleId: "delivery_records", targets: [], rest: law("Shipments, courier events and COD remittances support tax and dispute evidence and are treated as financial records (24 months proposed, floor applies); hub tables follow them. Handler deferred until the delivery archival decision.") },
  { ruleId: "returns_evidence", targets: ids("returns_evidence"), rest: law("returns, return_disputes and resale_listings are order-linked legal records governed by orders_tax_records; only evidence photos are purged.") },
  { ruleId: "user_content", targets: [], rest: flow("Reviews, Q and A are pseudonymised or anonymised by the erasure flow on request; wardrobe_items is not migrated.") },
  { ruleId: "live_chat", targets: [], rest: pending("live_chat_messages is not migrated yet.") },
  { ruleId: "personalization_data", targets: ids("personalization_data"), rest: flow("Style vectors, features, fit feedback and recently-viewed are removed on consent withdrawal or history clear (history module); only outfits are purged by age.") },
  { ruleId: "budget_data", targets: [], rest: flow("Budget data is deleted on budget_insights consent withdrawal or account erasure; there is no age-based expiry.") },
  { ruleId: "fraud_signals", targets: ids("fraud_signals"), rest: pending("risk_assessments, device_ip_graph_edges and cod_refusal_history are not migrated yet.") },
  { ruleId: "notification_log", targets: ids("notification_log"), rest: flow("notification_requests, inbox_messages and counters are pseudonymised by the erasure flow; the per-message log is purged by age.") },
  { ruleId: "affiliate_attribution", targets: [], rest: pending("affiliate_clicks and creator_accounts are not migrated yet; referral_codes and referrals follow the erasure flow.") },
  { ruleId: "gift_recipient_contact", targets: ids("gift_recipient_contact") },
  { ruleId: "request_logs", targets: [], rest: pending("request_logs is not migrated yet (edge logs are shipped to the log pipeline with its own TTL).") },
  { ruleId: "dsar_records", targets: [], rest: law("DSAR, breach and transfer registers are regulator evidence (5 years, VERIFY); dsar_requests is retain_legal. Handler deferred until the 5-year horizon is reachable.") },
  { ruleId: "dsar_export_artifact", targets: [], rest: owned("privacy.expire-exports", "Export objects are removed after 7 days by the privacy expire-exports job.") },
  { ruleId: "staff_access", targets: [], rest: pending("staff_accounts is not migrated yet.") },
  { ruleId: "technical_dedup", targets: ids("technical_dedup"), rest: law("courier_awb_jobs is retain_legal and saga_instances has no fixed terminal status set yet; both stay until that is defined (gap tracked in docs/specs/retention.md).") },
  { ruleId: "stock_reservation_records", targets: ids("stock_reservation_records"), rest: flow("queue_tickets, admission_tokens and drop_purchases are pseudonymised by the erasure flow; age-based purge for them is a documented gap.") },
  { ruleId: "stock_unit_rows", targets: ids("stock_unit_rows") },
  { ruleId: "stock_movement_evidence", targets: [], rest: law("Adjustments and oversell events are tax and dispute evidence for 7 years; nothing is old enough to purge before 2033 and the guard keeps it so.") },
  { ruleId: "catalog_import_records", targets: ids("catalog_import_records") },
];
