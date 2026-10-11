-- migration: 0022_fulfillment
-- phase: expand
--
-- Courier fulfillment (spec 21, docs/specs/fulfillment.md, docs/data-model/fulfillment.md).
--
-- What this adds
--   tables  shipments, shipment_events, courier_events_raw, courier_awb_jobs,
--           cod_remittances, cod_remittance_lines
--
-- Scope limits (docs/specs/fulfillment.md)
--   * COD remittances are RECORDS. Nothing here posts to the ledger (cod_clearing is untouched);
--     money execution waits for the owner's F-1 money-design checkpoint.
--   * No courier reference tables (couriers, coverage, service levels, transit stats), no
--     delivery_attempts / proofs_of_delivery / shipment_carbon: later tasks.
--
-- Deliberate deviations from docs/data-model/fulfillment.md
--   * seller_order_ids is a one-element array plus a scalar seller_order_id: the junction table
--     is only needed for Phase 2 hub consolidation. A CHECK keeps the two in step.
--   * shipment_events and courier_events_raw are not partitioned yet (same deferral as the
--     outbox, 0004). Partitioning is a later expand migration.
--   * courier_event_dedup is folded into the unique index on courier_events_raw.
--   * signature_ok is not stored: unverified deliveries are rejected before persistence.
--   * sellers and orders tables do not exist yet: store_id, seller_order_id, are logical references.
--
-- RLS classes (docs/security): shipments and shipment_events are class B (tenant: store members
-- read through app_store_ids(); writes are the API's system role after the policy guard);
-- courier_events_raw and courier_awb_jobs are class C (system and ops only); cod_* are class D
-- (finance, ops, super_admin, system).

CREATE TABLE shipments (
  id                uuid PRIMARY KEY,
  store_id          uuid NOT NULL,                        -- tenancy (logical FK to stores)
  seller_order_id   uuid NOT NULL,                        -- logical FK to orders
  seller_order_ids  uuid[] NOT NULL,                      -- spec shape; one element in Phase 1
  courier_code      text NOT NULL CHECK (courier_code ~ '^[a-z0-9_-]{2,32}$'),
  awb               text CHECK (awb IS NULL OR length(awb) BETWEEN 3 AND 64),
  status            text NOT NULL DEFAULT 'LABEL_PENDING' CHECK (status IN
                      ('LABEL_PENDING', 'LABEL_CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
                       'DELIVERY_ATTEMPT_FAILED', 'DELIVERED', 'COD_REMITTED', 'RECONCILED',
                       'RTO_INITIATED', 'RETURNED_TO_SELLER', 'CANCELLED', 'LOST')),
  attempts_made     integer NOT NULL DEFAULT 0 CHECK (attempts_made BETWEEN 0 AND 3),
  cod_amount        bigint CHECK (cod_amount IS NULL OR cod_amount > 0),
  currency          char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  cod_status        text NOT NULL DEFAULT 'NONE' CHECK (cod_status IN
                      ('NONE', 'PENDING', 'COLLECTED', 'REMITTED', 'MISMATCH')),
  label_status      text NOT NULL DEFAULT 'PENDING' CHECK (label_status IN ('PENDING', 'READY', 'FAILED')),
  parcel_weight_g   integer NOT NULL CHECK (parcel_weight_g > 0),
  pieces            integer NOT NULL DEFAULT 1 CHECK (pieces > 0),
  picked_up_at      timestamptz,
  delivered_at      timestamptz,
  version           integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_one_order_chk CHECK (cardinality(seller_order_ids) = 1 AND seller_order_ids[1] = seller_order_id),
  CONSTRAINT shipments_cod_chk CHECK ((cod_amount IS NULL) = (cod_status = 'NONE')),
  CONSTRAINT shipments_delivered_chk CHECK (
    delivered_at IS NOT NULL OR status NOT IN ('DELIVERED', 'COD_REMITTED', 'RECONCILED'))
);

CREATE UNIQUE INDEX shipments_courier_awb_uq ON shipments (courier_code, awb);
-- One live shipment per seller order. A cancelled, lost or returned shipment may be re-shipped.
CREATE UNIQUE INDEX shipments_seller_order_live_uq ON shipments (seller_order_id)
  WHERE status NOT IN ('CANCELLED', 'LOST', 'RETURNED_TO_SELLER');
CREATE INDEX shipments_store_status_idx ON shipments (store_id, status, created_at DESC);
CREATE INDEX shipments_cod_open_idx ON shipments (cod_status) WHERE cod_status IN ('PENDING', 'MISMATCH');

CREATE TRIGGER shipments_touch_updated_at_trg
  BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE shipment_events (
  id                uuid PRIMARY KEY,
  seq               bigint GENERATED ALWAYS AS IDENTITY,   -- recording order, tie-break for equal occurred_at
  shipment_id       uuid NOT NULL REFERENCES shipments (id),
  courier_event_id  text NOT NULL CHECK (length(courier_event_id) BETWEEN 1 AND 128),
  kind             text NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
  outcome           text NOT NULL CHECK (outcome IN ('APPLIED', 'IGNORED_STALE', 'IGNORED_INVALID')),
  from_status       text NOT NULL,
  to_status         text NOT NULL,
  reason_code       text CHECK (reason_code IS NULL OR length(reason_code) <= 64),
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL,
  CONSTRAINT shipment_events_dedup_uq UNIQUE (shipment_id, courier_event_id)
);
CREATE INDEX shipment_events_timeline_idx ON shipment_events (shipment_id, occurred_at, seq);

CREATE TRIGGER shipment_events_append_only_trg
  BEFORE UPDATE OR DELETE ON shipment_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE courier_events_raw (
  id                uuid PRIMARY KEY,
  courier_code      text NOT NULL CHECK (courier_code ~ '^[a-z0-9_-]{2,32}$'),
  courier_event_id  text NOT NULL CHECK (length(courier_event_id) BETWEEN 1 AND 128),
  awb               text,
  body              text NOT NULL CHECK (length(body) <= 262144),   -- verbatim, 256 KiB cap
  processing_status text NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN
                      ('RECEIVED', 'PROCESSED', 'UNMATCHED', 'IGNORED_UNKNOWN_STATUS')),
  received_at       timestamptz NOT NULL,
  processed_at      timestamptz,
  CONSTRAINT courier_events_raw_dedup_uq UNIQUE (courier_code, courier_event_id)
);
CREATE INDEX courier_events_raw_pending_idx ON courier_events_raw (processing_status, received_at)
  WHERE processing_status IN ('RECEIVED', 'UNMATCHED');
CREATE INDEX courier_events_raw_awb_idx ON courier_events_raw (courier_code, awb) WHERE awb IS NOT NULL;

CREATE TABLE courier_awb_jobs (
  shipment_id       uuid PRIMARY KEY REFERENCES shipments (id),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE', 'DEAD')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz NOT NULL,
  last_error_code   text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX courier_awb_jobs_due_idx ON courier_awb_jobs (next_attempt_at) WHERE status = 'PENDING';

CREATE TRIGGER courier_awb_jobs_touch_updated_at_trg
  BEFORE UPDATE ON courier_awb_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE cod_remittances (
  id                uuid PRIMARY KEY,
  courier_code      text NOT NULL CHECK (courier_code ~ '^[a-z0-9_-]{2,32}$'),
  courier_ref       text NOT NULL CHECK (length(courier_ref) BETWEEN 1 AND 128),
  remittance_date   date NOT NULL,
  total_amount      bigint NOT NULL CHECK (total_amount >= 0),
  currency          char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  status            text NOT NULL CHECK (status IN ('RECEIVED', 'MATCHED', 'PARTIALLY_MATCHED', 'MISMATCH')),
  received_at       timestamptz NOT NULL,
  CONSTRAINT cod_remittances_ref_uq UNIQUE (courier_code, courier_ref)
);
CREATE INDEX cod_remittances_status_idx ON cod_remittances (status, remittance_date);

CREATE TABLE cod_remittance_lines (
  remittance_id     uuid NOT NULL REFERENCES cod_remittances (id),
  awb               text NOT NULL CHECK (length(awb) BETWEEN 3 AND 64),
  shipment_id       uuid REFERENCES shipments (id),
  collected_amount  bigint NOT NULL CHECK (collected_amount >= 0),
  fee_amount        bigint NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  match_status      text NOT NULL CHECK (match_status IN ('MATCHED', 'AMOUNT_DIFF', 'UNKNOWN_AWB', 'NOT_COD')),
  PRIMARY KEY (remittance_id, awb)
);
CREATE INDEX cod_remittance_lines_shipment_idx ON cod_remittance_lines (shipment_id) WHERE shipment_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------

ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON shipments TO app_user;
CREATE POLICY shipments_select ON shipments FOR SELECT
  USING (store_id::text = ANY (app_store_ids())
         OR app_role() IN ('ops', 'support', 'finance', 'super_admin', 'system'));
CREATE POLICY shipments_insert ON shipments FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY shipments_update ON shipments FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE shipment_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON shipment_events TO app_user;
CREATE POLICY shipment_events_select ON shipment_events FOR SELECT
  USING (app_role() IN ('ops', 'support', 'finance', 'super_admin', 'system')
         OR EXISTS (SELECT 1 FROM shipments s
                    WHERE s.id = shipment_events.shipment_id AND s.store_id::text = ANY (app_store_ids())));
CREATE POLICY shipment_events_insert ON shipment_events FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE courier_events_raw ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON courier_events_raw TO app_user;
CREATE POLICY courier_events_raw_select ON courier_events_raw FOR SELECT
  USING (app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY courier_events_raw_insert ON courier_events_raw FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY courier_events_raw_update ON courier_events_raw FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE courier_awb_jobs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON courier_awb_jobs TO app_user;
CREATE POLICY courier_awb_jobs_select ON courier_awb_jobs FOR SELECT
  USING (app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY courier_awb_jobs_insert ON courier_awb_jobs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY courier_awb_jobs_update ON courier_awb_jobs FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE cod_remittances ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON cod_remittances TO app_user;
CREATE POLICY cod_remittances_select ON cod_remittances FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY cod_remittances_insert ON cod_remittances FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE cod_remittance_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON cod_remittance_lines TO app_user;
CREATE POLICY cod_remittance_lines_select ON cod_remittance_lines FOR SELECT
  USING (app_role() IN ('finance', 'ops', 'super_admin', 'system'));
CREATE POLICY cod_remittance_lines_insert ON cod_remittance_lines FOR INSERT WITH CHECK (app_role() = 'system');
