-- migration: 0005_audit_log
-- phase: expand
--
-- Append-only, hash-chained audit log (spec 9, T5, docs/data-model/platform.md).
--   hash = SHA-256(prev_hash || canonical(row))
-- One chain per chain_id (the application chooses tenant + month), so there is
-- no global writer. seq and hashes are assigned by a BEFORE INSERT trigger under
-- a per-chain advisory lock; callers cannot choose them.
-- Tamper evidence, not tamper PROOF: a superuser can rewrite a whole chain.
-- audit_chain_checkpoints plus WORM shipping (outside the database) cover that.
-- Truncating the TAIL of a chain is only detectable against a checkpoint.
-- diff_redacted must be PII-redacted by the caller; the database cannot do it.

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  chain_id      text NOT NULL CHECK (length(chain_id) > 0),
  seq           bigint NOT NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'staff', 'service', 'system')),
  actor_id      uuid,
  action        text NOT NULL CHECK (length(action) > 0),
  target_type   text,
  target_id     uuid,
  diff_redacted jsonb,
  ip_hash       text,             -- HMAC, P2
  device_id     uuid,
  request_id    text,
  reason_code   text,
  prev_hash     bytea NOT NULL,
  hash          bytea NOT NULL,
  CONSTRAINT audit_log_chain_seq_uq UNIQUE (chain_id, seq),
  CONSTRAINT audit_log_hash_len_chk CHECK (length(hash) = 32 AND length(prev_hash) = 32)
);

CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id, occurred_at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, occurred_at);

-- Canonical serialisation: a JSON array with a fixed field order. jsonb text
-- output is deterministic (sorted keys), so the same row always hashes the same.
CREATE FUNCTION audit_log_canonical(
  p_chain_id text, p_seq bigint, p_occurred_at timestamptz, p_actor_type text, p_actor_id uuid,
  p_action text, p_target_type text, p_target_id uuid, p_diff jsonb, p_ip_hash text,
  p_device_id uuid, p_request_id text, p_reason_code text
) RETURNS bytea
LANGUAGE sql IMMUTABLE
AS $$
  SELECT convert_to(
    jsonb_build_array(
      p_chain_id, p_seq,
      to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      p_actor_type, p_actor_id, p_action, p_target_type, p_target_id, p_diff,
      p_ip_hash, p_device_id, p_request_id, p_reason_code
    )::text,
    'UTF8')
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  last_seq bigint;
  last_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log:' || NEW.chain_id, 0));

  SELECT a.seq, a.hash INTO last_seq, last_hash
  FROM audit_log a
  WHERE a.chain_id = NEW.chain_id
  ORDER BY a.seq DESC
  LIMIT 1;

  IF last_seq IS NULL THEN
    NEW.seq := 1;
    NEW.prev_hash := decode(repeat('00', 32), 'hex');
  ELSE
    NEW.seq := last_seq + 1;
    NEW.prev_hash := last_hash;
  END IF;

  NEW.hash := sha256(
    NEW.prev_hash || audit_log_canonical(
      NEW.chain_id, NEW.seq, NEW.occurred_at, NEW.actor_type, NEW.actor_id, NEW.action,
      NEW.target_type, NEW.target_id, NEW.diff_redacted, NEW.ip_hash, NEW.device_id,
      NEW.request_id, NEW.reason_code));
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_log_chain_trg
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE TRIGGER audit_log_immutable_trg
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate_trg
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Signed (by the application / KMS) heads of each chain. History is kept.
CREATE TABLE audit_chain_checkpoints (
  chain_id   text NOT NULL,
  last_seq   bigint NOT NULL CHECK (last_seq >= 1),
  last_hash  bytea NOT NULL CHECK (length(last_hash) = 32),
  signed_at  timestamptz,
  signature  bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, last_seq)
);

CREATE TRIGGER audit_chain_checkpoints_immutable_trg
  BEFORE UPDATE OR DELETE ON audit_chain_checkpoints
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Records the current head of a chain. Returns the checkpoint seq (NULL if empty).
CREATE FUNCTION audit_chain_checkpoint(p_chain_id text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
DECLARE
  head_seq bigint;
  head_hash bytea;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('audit_log:' || p_chain_id, 0));
  SELECT a.seq, a.hash INTO head_seq, head_hash
  FROM audit_log a WHERE a.chain_id = p_chain_id ORDER BY a.seq DESC LIMIT 1;
  IF head_seq IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit_chain_checkpoints (chain_id, last_seq, last_hash)
  VALUES (p_chain_id, head_seq, head_hash)
  ON CONFLICT (chain_id, last_seq) DO NOTHING;
  RETURN head_seq;
END
$$;

-- Verification. Returns one row per problem; an empty result means the chain
-- (and every checkpoint) verifies. p_chain_id NULL verifies every chain.
CREATE FUNCTION audit_log_verify(p_chain_id text DEFAULT NULL)
RETURNS TABLE (chain_id text, seq bigint, problem text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog
AS $$
  WITH rows AS (
    SELECT a.*,
           lag(a.seq) OVER w AS prev_seq,
           lag(a.hash) OVER w AS prev_row_hash
    FROM audit_log a
    WHERE p_chain_id IS NULL OR a.chain_id = p_chain_id
    WINDOW w AS (PARTITION BY a.chain_id ORDER BY a.seq)
  ),
  row_problems AS (
    SELECT r.chain_id, r.seq,
      CASE
        WHEN r.prev_seq IS NULL AND r.seq <> 1 THEN 'chain does not start at seq 1 (rows removed from the head)'
        WHEN r.prev_seq IS NOT NULL AND r.seq <> r.prev_seq + 1 THEN 'gap in seq (rows removed)'
        WHEN r.prev_seq IS NULL AND r.prev_hash <> decode(repeat('00', 32), 'hex') THEN 'bad genesis prev_hash'
        WHEN r.prev_seq IS NOT NULL AND r.prev_hash <> r.prev_row_hash THEN 'prev_hash does not match previous row hash'
        WHEN r.hash <> sha256(r.prev_hash || audit_log_canonical(
              r.chain_id, r.seq, r.occurred_at, r.actor_type, r.actor_id, r.action, r.target_type,
              r.target_id, r.diff_redacted, r.ip_hash, r.device_id, r.request_id, r.reason_code))
          THEN 'row content does not match its hash (row modified)'
      END AS problem
    FROM rows r
  ),
  checkpoint_problems AS (
    SELECT c.chain_id, c.last_seq AS seq,
      CASE
        WHEN a.hash IS NULL THEN 'checkpoint refers to a row that no longer exists (tail truncated)'
        WHEN a.hash <> c.last_hash THEN 'row hash differs from checkpoint'
      END AS problem
    FROM audit_chain_checkpoints c
    LEFT JOIN audit_log a ON a.chain_id = c.chain_id AND a.seq = c.last_seq
    WHERE p_chain_id IS NULL OR c.chain_id = p_chain_id
  )
  SELECT p.chain_id, p.seq, p.problem FROM row_problems p WHERE p.problem IS NOT NULL
  UNION ALL
  SELECT p.chain_id, p.seq, p.problem FROM checkpoint_problems p WHERE p.problem IS NOT NULL
  ORDER BY 1, 2
$$;
