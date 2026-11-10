-- migration: 0025_addresses_shipments
-- phase: expand (new tables only)
-- Source: master prompt 7 (structured Egyptian address), 21 (shipments, tracking, RTO), B1 (delivery data to sellers only as needed);
--         docs/data-model.md addresses / delivery_snapshots / shipments / courier_events_raw; ADR-0011.
--
-- Deviations from the ERD (reported):
--   * addresses / delivery_snapshots keep P3 fields as *_ct (field envelope, per master prompt T5); the document carries street, building,
--     floor, apartment, landmark. Plain, queryable columns: governorate / city / district area ids (P2), cod_eligible (derived flag), label.
--   * delivery_snapshots is per seller order (PK seller_order_id), not per order group, so each store sees only its own parcel's recipient.
--     The seller branch of the policy ends at seller_access_until (set at delivery / RTO to +30 days, B1); the owning shopper always reads.
--   * shipments: courier text + service_level instead of courier_service_id (courier_services not built); seller_order_ids uuid[] instead of the
--     shipment_seller_orders join (Phase 1 is one parcel per order; the array is the hub-consolidation hook); label_object_key instead of
--     label_media_id; last_event_at / stale_notified_at for the 48 h tracking-gap poller.
--   * courier_events_raw: unpartitioned in Phase 1; UNIQUE (courier_code, courier_event_id) is the dedup key.
-- Review fixes (chief-reviewer REJECT):
--   * C2 delivery_snapshots keeps TWO phones: phone_masked_ct (seller display, readable by outlet_app) and phone_ct (the real number,
--     column-granted ONLY to outlet_worker and decrypted only inside the courier adapter call under job shipping.tracking).
--   * C3 seller_access_until is set at insert (created_at + 60 days) and shortened to terminal event + 30 days; the ciphertext columns are
--     nullable because a retention job nulls them and stamps pseudonymised_at once the window has passed.
--   * C5 courier_events_raw: a rejected (bad signature) webhook stores only body_sha256 + body_bytes, never the body (body_ct NULL).
--   * C6 AAD CONTRACT: every *_ct column is sealed with aad = '<table>.<column>:<row id>' (addresses: id; delivery_snapshots: seller_order_id;
--     courier_events_raw: id) so a ciphertext copied to another row fails to decrypt. The key/AAD scheme is part of the column contract.
--   * C8 only outbound shipments may carry COD.
-- RLS: addresses user-owned; delivery_snapshots and shipments "both" (store branch + owning shopper, same shape as seller_orders);
--      courier_events_raw has no tenant column and is reachable only by outlet_worker in job shipping.tracking.

CREATE TABLE addresses (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id),
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  country_code     char(2) NOT NULL DEFAULT 'EG',
  label            text CHECK (label IS NULL OR length(label) <= 40),
  governorate_area_id uuid NOT NULL REFERENCES geo_areas (id),
  city_area_id     uuid REFERENCES geo_areas (id),
  district_area_id uuid REFERENCES geo_areas (id),
  recipient_name_ct bytea NOT NULL,
  phone_ct         bytea NOT NULL,
  address_ct       bytea NOT NULL,
  pin_ct           bytea,
  cod_eligible     boolean NOT NULL DEFAULT false,
  is_default       boolean NOT NULL DEFAULT false,
  validated_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX addresses_user_idx ON addresses (user_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX addresses_one_default_idx ON addresses (user_id) WHERE is_default AND deleted_at IS NULL;
SELECT app.enable_user_rls('addresses');
REVOKE DELETE, TRUNCATE ON addresses FROM outlet_app;

CREATE TABLE delivery_snapshots (
  seller_order_id     uuid PRIMARY KEY,
  order_group_id      uuid NOT NULL,
  store_id            uuid NOT NULL REFERENCES stores (id),
  user_id             uuid NOT NULL REFERENCES users (id),
  market_id           text NOT NULL CHECK (length(market_id) > 0),
  country_code        char(2) NOT NULL DEFAULT 'EG',
  geo_area_id         uuid NOT NULL REFERENCES geo_areas (id),
  recipient_name_ct   bytea,
  phone_ct            bytea,
  phone_masked_ct     bytea,
  address_ct          bytea,
  pin_ct              bytea,
  seller_access_until timestamptz,
  pseudonymised_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_snapshots_user_idx ON delivery_snapshots (user_id);
ALTER TABLE delivery_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY delivery_snapshots_store_isolation ON delivery_snapshots
  USING (market_id = app.current_market_id() AND ((store_id = app.current_store_id() AND (seller_access_until IS NULL OR seller_access_until > now()))
         OR (app.ctx() IN ('user', 'worker') AND user_id = app.current_user_id())))
  WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id()
         OR (app.ctx() IN ('user', 'worker') AND user_id = app.current_user_id())));
CREATE INDEX delivery_snapshots_purge_idx ON delivery_snapshots (seller_access_until) WHERE pseudonymised_at IS NULL;
REVOKE UPDATE, DELETE, TRUNCATE ON delivery_snapshots FROM outlet_app;
-- C2: outlet_app (shopper insert at checkout, seller read) can never select the real phone.
REVOKE SELECT ON delivery_snapshots FROM outlet_app;
GRANT SELECT (seller_order_id, order_group_id, store_id, user_id, market_id, country_code, geo_area_id, recipient_name_ct, phone_masked_ct, address_ct, pin_ct, seller_access_until, pseudonymised_at, created_at)
  ON delivery_snapshots TO outlet_app;

CREATE TABLE shipments (
  id                uuid PRIMARY KEY,
  market_id         text NOT NULL CHECK (length(market_id) > 0),
  store_id          uuid NOT NULL REFERENCES stores (id),
  user_id           uuid NOT NULL REFERENCES users (id),
  seller_order_ids  uuid[] NOT NULL CHECK (cardinality(seller_order_ids) >= 1),
  direction         text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'return')),
  courier           text NOT NULL CHECK (length(courier) > 0),
  service_level     text NOT NULL CHECK (length(service_level) > 0),
  awb               text,
  status            text NOT NULL DEFAULT 'LABEL_PENDING' CHECK (status IN ('LABEL_PENDING','LABEL_READY','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','RTO','RETURNED_TO_SELLER','CANCELLED')),
  declared_weight_g int NOT NULL CHECK (declared_weight_g > 0),
  cod_amount_minor  bigint NOT NULL DEFAULT 0 CHECK (cod_amount_minor >= 0),
  currency          char(3) NOT NULL DEFAULT 'EGP',
  label_object_key  text,
  attempts          smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  delivered_at      timestamptz,
  last_event_at     timestamptz,
  stale_notified_at timestamptz,
  idempotency_key   text NOT NULL UNIQUE,
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_cod_outbound_only CHECK (direction = 'outbound' OR cod_amount_minor = 0)
);
CREATE UNIQUE INDEX shipments_awb_idx ON shipments (courier, awb) WHERE awb IS NOT NULL;
CREATE INDEX shipments_store_idx ON shipments (store_id, status, created_at DESC, id DESC);
CREATE INDEX shipments_user_idx ON shipments (user_id, created_at DESC, id DESC);
CREATE INDEX shipments_stale_idx ON shipments (last_event_at) WHERE status IN ('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY');
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY shipments_store_isolation ON shipments
  USING (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR (app.ctx() IN ('user', 'worker') AND user_id = app.current_user_id())))
  WITH CHECK (market_id = app.current_market_id() AND (store_id = app.current_store_id() OR (app.ctx() IN ('user', 'worker') AND user_id = app.current_user_id())));
REVOKE DELETE, TRUNCATE ON shipments FROM outlet_app;
REVOKE UPDATE ON shipments FROM outlet_app;
GRANT UPDATE (awb, status, label_object_key, version, updated_at) ON shipments TO outlet_app;

CREATE TABLE courier_events_raw (
  id               uuid PRIMARY KEY,
  market_id        text NOT NULL CHECK (length(market_id) > 0),
  courier_code     text NOT NULL,
  courier_event_id text NOT NULL,
  signature_ok     boolean NOT NULL,
  body_ct          bytea,
  body_sha256      text,
  body_bytes       int,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'rejected', 'failed')),
  failure_reason   text,
  shipment_id      uuid,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  UNIQUE (courier_code, courier_event_id),
  CONSTRAINT courier_events_raw_body_shape CHECK ((processing_status = 'rejected' AND body_ct IS NULL AND body_sha256 IS NOT NULL AND body_bytes IS NOT NULL) OR (processing_status <> 'rejected' AND body_ct IS NOT NULL))
);
CREATE INDEX courier_events_raw_failed_idx ON courier_events_raw (processing_status, id) WHERE processing_status = 'failed';
ALTER TABLE courier_events_raw ENABLE ROW LEVEL SECURITY;
ALTER TABLE courier_events_raw FORCE ROW LEVEL SECURITY;
REVOKE ALL ON courier_events_raw FROM outlet_app;
CREATE POLICY courier_events_raw__worker_shipping_tracking ON courier_events_raw FOR ALL TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id());

-- Worker job shipping.tracking.
REVOKE ALL ON courier_events_raw, shipments, delivery_snapshots FROM outlet_worker;
GRANT SELECT, INSERT ON courier_events_raw TO outlet_worker;
GRANT UPDATE (processing_status, failure_reason, shipment_id, processed_at) ON courier_events_raw TO outlet_worker;
GRANT SELECT ON shipments, delivery_snapshots TO outlet_worker;
GRANT UPDATE (status, attempts, delivered_at, last_event_at, stale_notified_at, version, updated_at) ON shipments TO outlet_worker;
GRANT UPDATE (seller_access_until, recipient_name_ct, phone_ct, phone_masked_ct, address_ct, pin_ct, pseudonymised_at) ON delivery_snapshots TO outlet_worker;
CREATE POLICY shipments__worker_shipping_tracking_select ON shipments FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id());
CREATE POLICY shipments__worker_shipping_tracking_update ON shipments FOR UPDATE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id());
CREATE POLICY delivery_snapshots__worker_shipping_tracking_select ON delivery_snapshots FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id());
CREATE POLICY delivery_snapshots__worker_shipping_tracking_update ON delivery_snapshots FOR UPDATE TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id())
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_shipping_tracking ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'shipping.tracking' AND market_id = app.current_market_id());
-- The rejected-order inventory consumer (checkout RejectedOrderInventoryRelease) runs in the same job context narrowed to the order owner: it reads the
-- owner's order rows and the reservation through the existing user branches, so it needs no further policy. The consumer of its
-- inventory.release_required event (@outlet/inventory ReleaseRequiredConsumer) runs as outlet_app in the event's STORE context, like
-- ReservationService, so inventory needs no worker policy (the ADR-0011 tenant audit for inventory stays empty).
