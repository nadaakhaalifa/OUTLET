-- migration: 0025_privacy_requests
-- phase: expand
--
-- Privacy Center requests and the breach register (spec section 2, B1, docs/specs/privacy-center.md).
-- Expand only: two new tables, nothing existing changes. consent_records is already append-only (0006).
--
--   * dsar_requests holds both export and deletion requests (kind). The state names are the ones in
--     packages/domain/src/privacy (export: requested, collecting, ready, expired, failed;
--     deletion: cooling, on_hold, cancelled, erasing, completed).
--   * The export ZIP is referenced by object key only. Signed URLs (24 h) are produced on demand and
--     never stored.
--   * At most one open export and one open deletion per user (partial unique indexes), which makes
--     repeated POSTs idempotent at the data layer as well as at the HTTP layer.
--   * version is the optimistic concurrency counter; updated_at is written by the application from the
--     injected clock (no touch trigger), so state transitions are deterministic under test.
--   * blockers stores only the blocker kind and count, never order or return identifiers.
--   * breach_register summary must not contain personal data. Legal clocks (4 h triage, 72 h PDPC,
--     3 days subjects) are computed in the application from detected_at and the notified_at columns.

CREATE TABLE dsar_requests (
  id                      uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users (id),
  kind                    text NOT NULL CHECK (kind IN ('export', 'delete')),
  status                  text NOT NULL,
  locale                  text NOT NULL DEFAULT 'ar' CHECK (locale IN ('ar', 'en')),
  requested_at            timestamptz NOT NULL,
  due_at                  timestamptz NOT NULL,
  ready_target_at         timestamptz,
  cooling_ends_at         timestamptz,
  forfeited_credit_amount bigint NOT NULL DEFAULT 0 CHECK (forfeited_credit_amount >= 0),
  blockers                jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts                integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failure_code            text CHECK (failure_code IS NULL OR char_length(failure_code) <= 64),
  completed_at            timestamptz,
  cancelled_at            timestamptz,
  export_object_ref       text CHECK (export_object_ref IS NULL OR char_length(export_object_ref) BETWEEN 1 AND 300),
  artifact_expires_at     timestamptz,
  version                 integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dsar_requests_status_chk CHECK (
    (kind = 'export' AND status IN ('requested', 'collecting', 'ready', 'expired', 'failed'))
    OR (kind = 'delete' AND status IN ('cooling', 'on_hold', 'cancelled', 'erasing', 'completed'))),
  CONSTRAINT dsar_requests_shape_chk CHECK (
    (kind = 'export' AND ready_target_at IS NOT NULL AND cooling_ends_at IS NULL)
    OR (kind = 'delete' AND cooling_ends_at IS NOT NULL AND ready_target_at IS NULL)),
  CONSTRAINT dsar_requests_ready_artifact_chk CHECK (
    NOT (kind = 'export' AND status = 'ready')
    OR (export_object_ref IS NOT NULL AND artifact_expires_at IS NOT NULL)),
  CONSTRAINT dsar_requests_due_chk CHECK (due_at >= requested_at)
);

CREATE UNIQUE INDEX dsar_requests_open_export_uq ON dsar_requests (user_id)
  WHERE kind = 'export' AND status IN ('requested', 'collecting', 'ready');
CREATE UNIQUE INDEX dsar_requests_open_delete_uq ON dsar_requests (user_id)
  WHERE kind = 'delete' AND status IN ('cooling', 'on_hold', 'erasing');
CREATE INDEX dsar_requests_user_idx ON dsar_requests (user_id, requested_at DESC, id DESC);
CREATE INDEX dsar_requests_queue_idx ON dsar_requests (kind, status, due_at);

CREATE TABLE breach_register (
  id                     uuid PRIMARY KEY,
  detected_at            timestamptz NOT NULL,
  severity               text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  summary                text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 2000),
  affected_count         integer NOT NULL CHECK (affected_count >= 0),
  status                 text NOT NULL CHECK (status IN ('detected', 'triaged', 'pdpc_notified', 'subjects_notified', 'closed')),
  triaged_at             timestamptz,
  dpo_decision           text CHECK (dpo_decision IS NULL OR dpo_decision IN ('notify', 'no_notification_required')),
  pdpc_notified_at       timestamptz,
  subjects_notified_at   timestamptz,
  closed_at              timestamptz,
  version                integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT breach_register_decision_chk CHECK (
    (status = 'detected' AND dpo_decision IS NULL) OR (status <> 'detected' AND dpo_decision IS NOT NULL)),
  CONSTRAINT breach_register_notice_chk CHECK (
    (pdpc_notified_at IS NULL OR dpo_decision = 'notify')
    AND (subjects_notified_at IS NULL OR pdpc_notified_at IS NOT NULL))
);

CREATE INDEX breach_register_open_idx ON breach_register (detected_at) WHERE status <> 'closed';

-- Row level security ------------------------------------------------------------------------
-- dsar_requests: the subject sees and creates their own; the DPO reads the whole queue; the
-- workers (system) advance state. Nothing is ever deleted (evidence, retention dsar_records).
ALTER TABLE dsar_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON dsar_requests TO app_user;
CREATE POLICY dsar_requests_select ON dsar_requests FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('dpo', 'system'));
CREATE POLICY dsar_requests_insert ON dsar_requests FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY dsar_requests_update ON dsar_requests FOR UPDATE
  USING (user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');

-- breach_register: DPO and system only. A shopper never sees it, not even through a join.
ALTER TABLE breach_register ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON breach_register TO app_user;
CREATE POLICY breach_register_select ON breach_register FOR SELECT
  USING (app_role() IN ('dpo', 'system'));
CREATE POLICY breach_register_insert ON breach_register FOR INSERT
  WITH CHECK (app_role() IN ('dpo', 'system'));
CREATE POLICY breach_register_update ON breach_register FOR UPDATE
  USING (app_role() IN ('dpo', 'system'))
  WITH CHECK (app_role() IN ('dpo', 'system'));
