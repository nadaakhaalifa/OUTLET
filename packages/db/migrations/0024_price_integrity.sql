-- migration: 0024_price_integrity
-- phase: expand
--
-- Price Integrity v1 (spec section 9, docs/specs/price-integrity.md): the internal price ledger and
-- the artefacts computed from it.
--   price_events               : immutable change points of a SKU price (append-only, ordered per SKU).
--   price_claims               : immutable scored claim snapshots (VRP, evidence ids) for audit
--                                (Consumer Protection Agency inquiries) and order-line snapshots.
--   price_enforcement_actions  : automatic enforcement ladder outcomes (spec 9.5). Open findings are
--                                resolved in place; nothing else may change.
-- sku_id and store_id are LOGICAL references (catalog and stores tables are owned elsewhere).
-- Money is BIGINT piastres. There is deliberately no seller-typed "was price" column anywhere (9.1).
-- PII: actor_id is a staff user id (P2); everything else is P0/P1.

CREATE TABLE price_events (
  id              uuid PRIMARY KEY,
  sku_id          uuid NOT NULL,
  store_id        uuid NOT NULL,
  price_amount    bigint NOT NULL CHECK (price_amount > 0),
  currency        text NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  valid_from      timestamptz NOT NULL,
  source          text NOT NULL CHECK (source IN ('seller', 'import', 'channel_sync', 'admin', 'system')),
  actor_id        uuid,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sku_id, idempotency_key)
);

CREATE INDEX price_events_sku_time_idx ON price_events (sku_id, valid_from, id);
CREATE INDEX price_events_store_idx ON price_events (store_id, sku_id);

-- A SKU belongs to exactly one store, and history is strictly ordered: an event may not be
-- inserted before one that already exists (a back-dated event would rewrite history).
CREATE FUNCTION price_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_from  timestamptz;
  latest_store uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('price_events:' || NEW.sku_id::text, 0));
  SELECT valid_from, store_id INTO latest_from, latest_store
    FROM price_events WHERE sku_id = NEW.sku_id ORDER BY valid_from DESC, id DESC LIMIT 1;
  IF FOUND THEN
    IF latest_store <> NEW.store_id THEN
      RAISE EXCEPTION 'sku % belongs to another store', NEW.sku_id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.valid_from < latest_from THEN
      RAISE EXCEPTION 'price event for sku % is older than the latest event', NEW.sku_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_events_guard_trg BEFORE INSERT ON price_events
  FOR EACH ROW EXECUTE FUNCTION price_events_guard();
CREATE TRIGGER price_events_no_mutation_trg BEFORE UPDATE OR DELETE ON price_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER price_events_no_truncate_trg BEFORE TRUNCATE ON price_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE price_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON price_events TO app_user;
-- Price history is public product information; any authenticated role may read it.
CREATE POLICY price_events_select ON price_events FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY price_events_insert ON price_events FOR INSERT
  WITH CHECK ((app_role() = 'seller' AND store_id::text = ANY (app_store_ids())) OR app_role() = 'system');

-- ------------------------------------------------------------------------------------------------

CREATE TABLE price_claims (
  id            uuid PRIMARY KEY,
  sku_id        uuid NOT NULL,
  store_id      uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('verified_discount', 'lowest_30d', 'launch_price', 'none')),
  price_amount  bigint NOT NULL CHECK (price_amount > 0),
  vrp_amount    bigint CHECK (vrp_amount IS NULL OR vrp_amount > 0),
  discount_pct  integer CHECK (discount_pct IS NULL OR discount_pct BETWEEN 5 AND 100),
  evidence_ids  text[] NOT NULL DEFAULT '{}',
  reason        text,
  computed_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A percentage exists only with a verified reference above the price, and vice versa (9.1).
  CONSTRAINT price_claims_claim_shape CHECK (
    (status = 'verified_discount') =
      (vrp_amount IS NOT NULL AND discount_pct IS NOT NULL AND vrp_amount > price_amount AND cardinality(evidence_ids) > 0)
    AND (status = 'verified_discount' OR (vrp_amount IS NULL AND discount_pct IS NULL))
  )
);

CREATE INDEX price_claims_sku_time_idx ON price_claims (sku_id, computed_at DESC);
CREATE INDEX price_claims_store_time_idx ON price_claims (store_id, computed_at DESC);

CREATE TRIGGER price_claims_no_mutation_trg BEFORE UPDATE OR DELETE ON price_claims
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER price_claims_no_truncate_trg BEFORE TRUNCATE ON price_claims
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE price_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON price_claims TO app_user;
CREATE POLICY price_claims_select ON price_claims FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY price_claims_insert ON price_claims FOR INSERT WITH CHECK (app_role() = 'system');

-- ------------------------------------------------------------------------------------------------

CREATE TABLE price_enforcement_actions (
  id                   uuid PRIMARY KEY,
  store_id             uuid NOT NULL,
  sku_id               uuid,
  kind                 text NOT NULL CHECK (kind IN
    ('insufficient_evidence', 'claim_exceeds_vrp', 'pre_drop_inflation', 'cross_channel_cheaper', 'severe_or_repeat')),
  actions              jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array'),
  violations_in_window integer NOT NULL CHECK (violations_in_window >= 0),
  -- Idempotency: the same finding is never recorded twice.
  dedupe_key           text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  opened_at            timestamptz NOT NULL,
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX price_enforcement_store_time_idx ON price_enforcement_actions (store_id, opened_at DESC);
-- One open cross-channel finding per SKU.
CREATE UNIQUE INDEX price_enforcement_open_finding_idx ON price_enforcement_actions (sku_id, kind)
  WHERE resolved_at IS NULL AND sku_id IS NOT NULL AND kind = 'cross_channel_cheaper';

CREATE FUNCTION price_enforcement_only_resolve() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on price_enforcement_actions is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.resolved_at IS NOT NULL
     OR (NEW.id, NEW.store_id, NEW.sku_id, NEW.kind, NEW.actions, NEW.violations_in_window, NEW.dedupe_key, NEW.opened_at, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.store_id, OLD.sku_id, OLD.kind, OLD.actions, OLD.violations_in_window, OLD.dedupe_key, OLD.opened_at, OLD.created_at) THEN
    RAISE EXCEPTION 'price_enforcement_actions rows may only be resolved once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER price_enforcement_guard_trg BEFORE UPDATE OR DELETE ON price_enforcement_actions
  FOR EACH ROW EXECUTE FUNCTION price_enforcement_only_resolve();
CREATE TRIGGER price_enforcement_no_truncate_trg BEFORE TRUNCATE ON price_enforcement_actions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

ALTER TABLE price_enforcement_actions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON price_enforcement_actions TO app_user;
CREATE POLICY price_enforcement_select ON price_enforcement_actions FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY price_enforcement_insert ON price_enforcement_actions FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY price_enforcement_update ON price_enforcement_actions FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
