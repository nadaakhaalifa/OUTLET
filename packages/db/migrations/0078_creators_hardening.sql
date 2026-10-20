-- migration: 0078_creators_hardening
-- phase: expand
--
-- Phase 3 money review, part A (creators and affiliates). Additive only:
--   * attributions: a HELD status plus hold_reason (A-3, fail closed when the fraud gate cannot run).
--     The status check is widened, never narrowed, so running code keeps working.
--   * attributions.void_reason also allows referral_stacking (A-4).
--   * affiliate_clicks: a (link_id, ts) index for the per-link hourly cap (A-1).
--   * creators_maintain_click_partitions(): creates upcoming monthly partitions and enforces the
--     13 month retention. SECURITY DEFINER so the runtime role keeps SELECT and INSERT only and
--     never gets DDL or DELETE on the table (A-9).
--   * creator_accounts: the accepted terms version must exist in creator_terms (A-7). A trigger
--     rather than a foreign key because creator_terms is keyed by (version, locale).
--   * commission_postings and commissions: guard triggers that make the immutability claims of
--     0076 true at the database level (A-8).

-- A-3 ----------------------------------------------------------------------------------------------
-- lint-allow: drop-constraint-or-index replaced in the same migration by a strictly wider CHECK (adds HELD)
ALTER TABLE attributions DROP CONSTRAINT IF EXISTS attributions_status_check;
ALTER TABLE attributions ADD CONSTRAINT attributions_status_check
  CHECK (status IN ('ACTIVE', 'VOIDED', 'HELD'));
ALTER TABLE attributions ADD COLUMN hold_reason text
  CHECK (hold_reason IS NULL OR hold_reason IN ('identity_unavailable'));
ALTER TABLE attributions ADD CONSTRAINT attributions_hold_shape
  CHECK ((status = 'HELD') = (hold_reason IS NOT NULL));
CREATE INDEX attributions_held_idx ON attributions (created_at) WHERE status = 'HELD';

-- A-4 (owner decision recorded in ADR-0037 notes): an order that carries a referral reward earns no
-- creator commission, so the void reason list gains referral_stacking (widened, never narrowed).
-- lint-allow: drop-constraint-or-index replaced in the same migration by a strictly wider CHECK (adds referral_stacking)
ALTER TABLE attributions DROP CONSTRAINT IF EXISTS attributions_void_reason_check;
ALTER TABLE attributions ADD CONSTRAINT attributions_void_reason_check CHECK (void_reason IS NULL OR void_reason IN
  ('self_purchase', 'same_device', 'shared_payment', 'shared_address', 'cluster', 'creator_ineligible', 'referral_stacking'));

-- A-1 ----------------------------------------------------------------------------------------------
CREATE INDEX affiliate_clicks_link_idx ON affiliate_clicks (link_id, ts);

-- A-9 ----------------------------------------------------------------------------------------------
CREATE FUNCTION creators_maintain_click_partitions(p_now timestamptz, p_ahead integer, p_retain integer)
RETURNS TABLE (created integer, dropped integer, deleted_rows bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month   date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
  v_cutoff  timestamptz := p_now - make_interval(months => p_retain);
  v_name    text;
  v_from    date;
  r         record;
  v_deleted bigint;
BEGIN
  IF p_ahead < 0 OR p_ahead > 12 OR p_retain < 1 OR p_retain > 120 THEN
    RAISE EXCEPTION 'invalid partition maintenance arguments';
  END IF;
  created := 0;
  dropped := 0;
  FOR i IN 0..p_ahead LOOP
    v_from := (v_month + make_interval(months => i))::date;
    v_name := format('affiliate_clicks_%s', to_char(v_from, 'YYYY_MM'));
    IF to_regclass(format('public.%I', v_name)) IS NULL THEN
      BEGIN
        EXECUTE format(
          'CREATE TABLE public.%I PARTITION OF public.affiliate_clicks FOR VALUES FROM (%L) TO (%L)',
          v_name, v_from::timestamptz, (v_from + interval '1 month')::timestamptz);
        created := created + 1;
      EXCEPTION WHEN check_violation OR invalid_object_definition THEN
        -- Rows for this month already landed in the DEFAULT partition: report, do not fail the job.
        RAISE NOTICE 'partition % not created: default partition holds rows in range', v_name;
      END;
    END IF;
  END LOOP;
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'affiliate_clicks' AND c.relname ~ '^affiliate_clicks_[0-9]{4}_[0-9]{2}$'
  LOOP
    v_from := to_date(substr(r.relname, length('affiliate_clicks_') + 1), 'YYYY_MM');
    IF (v_from + interval '1 month')::timestamptz <= v_cutoff THEN
      EXECUTE format('DROP TABLE public.%I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  DELETE FROM affiliate_clicks WHERE ts < v_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  deleted_rows := v_deleted;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION creators_maintain_click_partitions(timestamptz, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creators_maintain_click_partitions(timestamptz, integer, integer) TO app_user;

-- A-7 ----------------------------------------------------------------------------------------------
CREATE FUNCTION creator_accounts_terms_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM creator_terms WHERE version = NEW.terms_version) THEN
    RAISE EXCEPTION 'creator terms version % has no stored text', NEW.terms_version
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER creator_accounts_terms_guard_trg
  BEFORE INSERT ON creator_accounts
  FOR EACH ROW EXECUTE FUNCTION creator_accounts_terms_guard();

-- A-8 ----------------------------------------------------------------------------------------------
CREATE FUNCTION commission_postings_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'commission_postings rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.commission_id IS DISTINCT FROM OLD.commission_id OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'commission_postings: only posted_at may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.posted_at IS NOT NULL AND NEW.posted_at IS DISTINCT FROM OLD.posted_at THEN
    RAISE EXCEPTION 'commission_postings: posted_at is write-once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER commission_postings_guard_trg
  BEFORE UPDATE OR DELETE ON commission_postings
  FOR EACH ROW EXECUTE FUNCTION commission_postings_guard();

CREATE FUNCTION commissions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.creator_id IS DISTINCT FROM OLD.creator_id OR NEW.order_group_id IS DISTINCT FROM OLD.order_group_id
     OR NEW.order_line_id IS DISTINCT FROM OLD.order_line_id OR NEW.base IS DISTINCT FROM OLD.base
     OR NEW.rate_bps IS DISTINCT FROM OLD.rate_bps OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'commissions: identity, base and rate are immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.clawed_back < OLD.clawed_back OR NEW.refunded_base < OLD.refunded_base THEN
    RAISE EXCEPTION 'commissions: clawed_back and refunded_base only grow' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount IS DISTINCT FROM OLD.amount AND OLD.state <> 'ACCRUING' THEN
    RAISE EXCEPTION 'commissions: amount changes only while held' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'ACCRUING' AND NEW.state IN ('ACCRUED', 'VOIDED'))
    OR (OLD.state = 'ACCRUED' AND NEW.state IN ('PAID', 'CLAWED_BACK'))
    OR (OLD.state = 'PAID' AND NEW.state = 'CLAWED_BACK')) THEN
    RAISE EXCEPTION 'commissions: illegal transition % to %', OLD.state, NEW.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER commissions_guard_trg
  BEFORE UPDATE ON commissions
  FOR EACH ROW EXECUTE FUNCTION commissions_guard();
