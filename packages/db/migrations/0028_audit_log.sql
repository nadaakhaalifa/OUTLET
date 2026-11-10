-- migration: 0028_audit_log
-- phase: expand (new tables only)
-- Source: master prompt A2.9 (append-only hash-chained audit_log), B1 (breach register, 72 h / 3 d), 23 (PII views logged with a reason code),
--         ADR-0011. Replaces the never-promoted packages/audit-log/migrations/0001 draft.
-- Deviations (reported): not partitioned yet (monthly RANGE deferred like 0008/0012: expand migration before ~5M rows);
--   hashes are lowercase hex text (same as the TS AuditChain), actor/target/device ids are text (the chain accepts any non-empty id);
--   breach_records has NO RLS (market column only, no store/user key, no personal data by design); authorization is
--   @outlet/policy (breach.manage / privacy.breach.open) and every query pins market_id.
-- Access. There is no admin DB context (ADR-0011): admins run as outlet_app. outlet_app may only INSERT into the two log tables (named
-- exception policies *__app_insert, market pinned); it has NO SELECT. Reads (head of chain, list, verify batches) go through SECURITY DEFINER
-- functions that pin app.current_market_id(); who may call them is decided in the service layer (audit.read / privacy.export policy).
-- Append-only: UPDATE/DELETE/TRUNCATE revoked AND triggers ENABLE ALWAYS (fire even under session_replication_role = replica).

CREATE TABLE audit_log (
  id          uuid          PRIMARY KEY,
  market_id   text          NOT NULL CHECK (length(market_id) > 0),
  seq         bigint        NOT NULL CHECK (seq >= 1),
  actor_type  text          NOT NULL CHECK (actor_type IN ('user', 'staff', 'store_member', 'system')),
  actor_id    text,
  action      text          NOT NULL CHECK (length(action) > 0),
  target_type text          NOT NULL CHECK (length(target_type) > 0),
  target_id   text          NOT NULL CHECK (length(target_id) > 0),
  diff        jsonb,
  ip_hash     text          CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  device_id   text,
  request_id  text,
  occurred_at timestamptz(3) NOT NULL,
  prev_hash   text          NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash        text          NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (market_id, seq)
);
CREATE INDEX audit_log_target_idx ON audit_log (market_id, target_type, target_id, seq);
CREATE INDEX audit_log_actor_idx ON audit_log (market_id, actor_id, seq);

CREATE TABLE pii_access_log (
  id          uuid          PRIMARY KEY,
  market_id   text          NOT NULL CHECK (length(market_id) > 0),
  actor_id    text          NOT NULL CHECK (length(actor_id) > 0),
  target_type text          NOT NULL CHECK (length(target_type) > 0),
  target_id   text          NOT NULL CHECK (length(target_id) > 0),
  action      text          NOT NULL CHECK (length(action) > 0),
  reason_code text          NOT NULL CHECK (length(reason_code) > 0),
  request_id  text,
  occurred_at timestamptz(3) NOT NULL
);
CREATE INDEX pii_access_log_target_idx ON pii_access_log (market_id, target_type, target_id, occurred_at);
CREATE INDEX pii_access_log_actor_idx ON pii_access_log (market_id, actor_id, occurred_at);

CREATE FUNCTION log_block_mutation() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER pii_access_log_no_update_delete BEFORE UPDATE OR DELETE ON pii_access_log FOR EACH ROW EXECUTE FUNCTION log_block_mutation();
CREATE TRIGGER pii_access_log_no_truncate BEFORE TRUNCATE ON pii_access_log FOR EACH STATEMENT EXECUTE FUNCTION log_block_mutation();
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_update_delete;
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;
ALTER TABLE pii_access_log ENABLE ALWAYS TRIGGER pii_access_log_no_update_delete;
ALTER TABLE pii_access_log ENABLE ALWAYS TRIGGER pii_access_log_no_truncate;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE pii_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii_access_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log__app_insert ON audit_log FOR INSERT TO outlet_app WITH CHECK (market_id = app.current_market_id());
CREATE POLICY pii_access_log__app_insert ON pii_access_log FOR INSERT TO outlet_app WITH CHECK (market_id = app.current_market_id());

REVOKE ALL ON audit_log, pii_access_log FROM PUBLIC, outlet_app, outlet_auth, outlet_worker;
GRANT INSERT ON audit_log, pii_access_log TO outlet_app;

-- Chain head of the caller's market (one row or none). The writer holds pg_advisory_xact_lock for the market first.
CREATE FUNCTION audit_log_head() RETURNS TABLE (seq bigint, hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$ SELECT a.seq, a.hash FROM audit_log a WHERE a.market_id = app.current_market_id() ORDER BY a.seq DESC LIMIT 1 $$;

-- Keyset page. p_desc = true: newest first, rows with seq < p_cursor; false: oldest first, rows with seq > p_cursor (verify batches).
CREATE FUNCTION audit_log_page(
  p_cursor bigint, p_limit int, p_desc boolean,
  p_actor_id text, p_target_type text, p_target_id text, p_action text
) RETURNS SETOF audit_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT * FROM (
    SELECT a.* FROM audit_log a
     WHERE a.market_id = app.current_market_id()
       AND (p_cursor IS NULL OR (p_desc AND a.seq < p_cursor) OR (NOT p_desc AND a.seq > p_cursor))
       AND (p_actor_id IS NULL OR a.actor_id = p_actor_id)
       AND (p_target_type IS NULL OR a.target_type = p_target_type)
       AND (p_target_id IS NULL OR a.target_id = p_target_id)
       AND (p_action IS NULL OR a.action = p_action)
     ORDER BY CASE WHEN p_desc THEN a.seq END DESC, CASE WHEN NOT p_desc THEN a.seq END ASC
     LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  ) s
$$;

CREATE FUNCTION pii_access_log_page(p_cursor timestamptz, p_cursor_id uuid, p_limit int, p_actor_id text, p_target_type text, p_target_id text)
RETURNS SETOF pii_access_log
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS
$$
  SELECT p.* FROM pii_access_log p
   WHERE p.market_id = app.current_market_id()
     AND (p_cursor IS NULL OR (p.occurred_at, p.id) < (p_cursor, p_cursor_id))
     AND (p_actor_id IS NULL OR p.actor_id = p_actor_id)
     AND (p_target_type IS NULL OR p.target_type = p_target_type)
     AND (p_target_id IS NULL OR p.target_id = p_target_id)
   ORDER BY p.occurred_at DESC, p.id DESC
   LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION audit_log_head(), audit_log_page(bigint, int, boolean, text, text, text, text),
  pii_access_log_page(timestamptz, uuid, int, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_log_head(), audit_log_page(bigint, int, boolean, text, text, text, text),
  pii_access_log_page(timestamptz, uuid, int, text, text, text) TO outlet_app;

-- Breach register (PDPL B1: PDPC notice within 72 h of detection, data subjects within 3 days of the PDPC notice). No personal data in summary.
CREATE TABLE breach_records (
  id                   uuid        PRIMARY KEY,
  market_id            text        NOT NULL CHECK (length(market_id) > 0),
  opened_by            text        NOT NULL CHECK (length(opened_by) > 0),
  detected_at          timestamptz NOT NULL,
  opened_at            timestamptz NOT NULL,
  severity             text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status               text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'TRIAGED', 'PDPC_NOTIFIED', 'SUBJECTS_NOTIFIED', 'CLOSED')),
  summary              text        NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  data_categories      text[]      NOT NULL DEFAULT '{}',
  subjects_estimate    integer     CHECK (subjects_estimate IS NULL OR subjects_estimate >= 0),
  pdpc_deadline_at     timestamptz NOT NULL,
  pdpc_notified_at     timestamptz,
  subjects_deadline_at timestamptz,
  subjects_notified_at timestamptz,
  closed_at            timestamptz,
  postmortem_ref       text,
  updated_at           timestamptz NOT NULL,
  CHECK (pdpc_deadline_at > detected_at),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE INDEX breach_records_open_idx ON breach_records (market_id, pdpc_deadline_at) WHERE status <> 'CLOSED';

REVOKE ALL ON breach_records FROM PUBLIC, outlet_app, outlet_auth, outlet_worker;
GRANT SELECT, INSERT ON breach_records TO outlet_app;
GRANT UPDATE (severity, status, summary, data_categories, subjects_estimate, pdpc_notified_at, subjects_deadline_at, subjects_notified_at,
              closed_at, postmortem_ref, updated_at) ON breach_records TO outlet_app;
