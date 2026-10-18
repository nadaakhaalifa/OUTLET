import type { RetentionPeriod } from "./bridge";

/**
 * Runtime copy of the retention rules in docs/privacy/data_inventory.yaml (the source of truth).
 * retention.policy.test.ts fails when this drifts from the inventory.
 * The failure message lists the differing rules; update the matching line here.
 */
export interface RuleParams {
  readonly period: RetentionPeriod | null;
  readonly after: string;
  readonly purgeJob: string;
  readonly purgeMetric: string;
}

export const RULE_PARAMS: Readonly<Record<string, RuleParams>> = {
  account_active: { period: null, after: "erase_or_pseudonymize", purgeJob: "purge_deleted_accounts", purgeMetric: "privacy_accounts_purged_total" },
  affiliate_attribution: { period: { value: 13, unit: "months" }, after: "delete", purgeJob: "purge_affiliate_clicks", purgeMetric: "privacy_affiliate_clicks_purged_total" },
  analytics_events: { period: { value: 25, unit: "months" }, after: "aggregate", purgeJob: "aggregate_analytics_events", purgeMetric: "privacy_analytics_events_aggregated_total" },
  audit_log: { period: { value: 7, unit: "years" }, after: "delete", purgeJob: "purge_audit_log_partitions", purgeMetric: "privacy_audit_partitions_purged_total" },
  auth_credentials: { period: { value: 30, unit: "days" }, after: "delete", purgeJob: "purge_expired_sessions", purgeMetric: "privacy_sessions_purged_total" },
  browsing_state: { period: { value: 90, unit: "days" }, after: "delete", purgeJob: "purge_idle_carts", purgeMetric: "privacy_idle_carts_purged_total" },
  budget_data: { period: null, after: "delete", purgeJob: "purge_budget_data", purgeMetric: "privacy_budget_data_purged_total" },
  catalog_content: { period: null, after: "none", purgeJob: "archive_delisted_catalog", purgeMetric: "catalog_archived_total" },
  catalog_import_records: { period: { value: 90, unit: "days" }, after: "delete", purgeJob: "purge_catalog_import_records", purgeMetric: "catalog_import_records_purged_total" },
  consent_evidence: { period: { value: 7, unit: "years" }, after: "delete", purgeJob: "purge_consent_records", purgeMetric: "privacy_consent_records_purged_total" },
  delivery_records: { period: { value: 24, unit: "months" }, after: "pseudonymize", purgeJob: "purge_delivery_records", purgeMetric: "privacy_delivery_records_purged_total" },
  device_records: { period: { value: 13, unit: "months" }, after: "delete", purgeJob: "purge_stale_devices", purgeMetric: "privacy_devices_purged_total" },
  dsar_export_artifact: { period: { value: 7, unit: "days" }, after: "delete", purgeJob: "purge_dsar_exports", purgeMetric: "privacy_dsar_exports_purged_total" },
  dsar_records: { period: { value: 5, unit: "years" }, after: "delete", purgeJob: "purge_dsar_records", purgeMetric: "privacy_dsar_records_purged_total" },
  ledger_integrity_samples: { period: { value: 25, unit: "months" }, after: "delete", purgeJob: "purge_ledger_integrity_samples", purgeMetric: "privacy_ledger_integrity_samples_purged_total" },
  fraud_signals: { period: { value: 24, unit: "months" }, after: "delete", purgeJob: "purge_fraud_signals", purgeMetric: "privacy_fraud_signals_purged_total" },
  gift_recipient_contact: { period: { value: 30, unit: "days" }, after: "delete", purgeJob: "purge_gift_recipient_contacts", purgeMetric: "privacy_gift_contacts_purged_total" },
  kyc_records: { period: { value: 5, unit: "years" }, after: "delete", purgeJob: "purge_expired_kyc", purgeMetric: "privacy_kyc_purged_total" },
  live_chat: { period: { value: 30, unit: "days" }, after: "delete", purgeJob: "purge_live_chat", purgeMetric: "privacy_live_chat_purged_total" },
  measurements: { period: null, after: "delete", purgeJob: "purge_deleted_measurements", purgeMetric: "privacy_measurements_purged_total" },
  notification_log: { period: { value: 12, unit: "months" }, after: "delete", purgeJob: "purge_notification_log", purgeMetric: "privacy_notification_log_purged_total" },
  on_device_only: { period: null, after: "none", purgeJob: "device_local_cleanup", purgeMetric: "device_local_cleanup_total" },
  orders_tax_records: { period: { value: 7, unit: "years" }, after: "pseudonymize", purgeJob: "purge_expired_tax_records", purgeMetric: "privacy_tax_records_purged_total" },
  personalization_data: { period: { value: 24, unit: "months" }, after: "delete", purgeJob: "purge_personalization_data", purgeMetric: "privacy_personalization_purged_total" },
  raw_webhooks_financial: { period: { value: 7, unit: "years" }, after: "delete", purgeJob: "purge_raw_webhooks", purgeMetric: "privacy_raw_webhooks_purged_total" },
  request_logs: { period: { value: 30, unit: "days" }, after: "delete", purgeJob: "purge_request_logs", purgeMetric: "privacy_request_logs_purged_total" },
  returns_evidence: { period: { value: 12, unit: "months" }, after: "delete", purgeJob: "purge_return_evidence", purgeMetric: "privacy_return_evidence_purged_total" },
  search_queries: { period: { value: 13, unit: "months" }, after: "aggregate", purgeJob: "aggregate_search_queries", purgeMetric: "privacy_search_queries_aggregated_total" },
  seller_access_window: { period: { value: 30, unit: "days" }, after: "revoke_access", purgeJob: "revoke_seller_delivery_access", purgeMetric: "privacy_seller_access_revoked_total" },
  staff_access: { period: { value: 12, unit: "months" }, after: "delete", purgeJob: "purge_departed_staff", purgeMetric: "privacy_staff_records_purged_total" },
  stock_movement_evidence: { period: { value: 7, unit: "years" }, after: "delete", purgeJob: "purge_stock_movements", purgeMetric: "inventory_movements_purged_total" },
  stock_reservation_records: { period: { value: 90, unit: "days" }, after: "delete", purgeJob: "purge_resolved_reservations", purgeMetric: "inventory_reservations_purged_total" },
  stock_unit_rows: { period: { value: 13, unit: "months" }, after: "delete", purgeJob: "purge_claimed_units", purgeMetric: "inventory_units_purged_total" },
  support_chats: { period: { value: 2, unit: "years" }, after: "delete", purgeJob: "purge_support_chats", purgeMetric: "privacy_support_chats_purged_total" },
  technical_dedup: { period: { value: 30, unit: "days" }, after: "delete", purgeJob: "purge_technical_dedup", purgeMetric: "privacy_technical_dedup_purged_total" },
  visual_search_transient: { period: { value: 48, unit: "hours" }, after: "delete", purgeJob: "purge_visual_search_transient", purgeMetric: "visual_search_purged_total" },
  underage_block: { period: { value: 30, unit: "days" }, after: "delete", purgeJob: "purge_age_blocks", purgeMetric: "privacy_age_blocks_purged_total" },
  user_content: { period: null, after: "anonymize", purgeJob: "purge_user_content", purgeMetric: "privacy_user_content_purged_total" },
};
