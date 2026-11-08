-- audit_log: append-only, hash-chained (docs/data-model.md, module 2). Phase 0.
-- Partitioned monthly by UUIDv7 range; partitions are created by the partition job.
CREATE TABLE audit_log (
  id          uuid        NOT NULL,
  market_id   text        NOT NULL REFERENCES markets (id),
  actor_type  text        NOT NULL CHECK (actor_type IN ('user', 'staff', 'store_member', 'system')),
  actor_id    uuid,
  action      text        NOT NULL,
  target_type text        NOT NULL,
  target_id   text        NOT NULL,
  diff        jsonb,
  reason_code text,
  ip_hmac     bytea,
  device_id   uuid,
  request_id  text,
  prev_hash   bytea       NOT NULL,
  row_hash    bytea       NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (id)
) PARTITION BY RANGE (id);

CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, id);
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, id);

CREATE FUNCTION audit_log_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_block_mutation();

REVOKE ALL ON audit_log FROM PUBLIC;
-- Runtime role per infra/local/postgres/init/001-roles.sql. When additional runtime roles
-- are created, they get the same grants (INSERT, SELECT only; no UPDATE/DELETE/TRUNCATE).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM outlet_app;
GRANT INSERT, SELECT ON audit_log TO outlet_app;
