-- migration: 0044_hub_resale
-- phase: expand
--
-- Hub consolidation (cross-dock) and the returns-resale lane (docs/specs/phase2/09-aramex-hub-resale.md).
-- Expand only: new tables, nothing existing changes.
--
--   * One delivery fee per OrderGroup (hub_order_groups.delivery_fee_piastres, bigint piastres).
--     A consolidated parcel stores the fee the shopper was charged for it; parcels of one group
--     never sum above the group fee (enforced by the application, checked by the contract suite).
--   * hub_legs holds the AT_HUB_EXPECTED -> RECEIVED -> CONSOLIDATED -> DISPATCHED machine per
--     seller order. hub_receipts is append only (scan facts) and unique per seller order.
--   * resale_listings: UNIQUE (unit_ref) means a physical unit has at most one listing ever, so a
--     second return of a resold unit cannot be relisted. No column holds a reference price or a
--     percent off: a resale never claims a discount against the original VRP.
--   * Row level security: shoppers read their own order groups; hub and seller reads run as
--     app.role = 'system' (the policy guard authorizes hub operators by hub and sellers by store);
--     LISTED resale items are world readable.

CREATE TABLE hubs (
  id           uuid PRIMARY KEY,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  governorate  text NOT NULL CHECK (char_length(governorate) BETWEEN 1 AND 40),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hub_order_groups (
  order_group_id         uuid PRIMARY KEY,
  user_id                uuid NOT NULL REFERENCES users (id),
  hub_id                 uuid NOT NULL REFERENCES hubs (id),
  delivery_fee_piastres  bigint NOT NULL CHECK (delivery_fee_piastres >= 0),
  ship_together          boolean NOT NULL DEFAULT true,
  paid_at                timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hub_order_groups_user_idx ON hub_order_groups (user_id, created_at DESC);

CREATE TABLE consolidated_shipments (
  id                      uuid PRIMARY KEY,
  order_group_id          uuid NOT NULL REFERENCES hub_order_groups (order_group_id),
  hub_id                  uuid NOT NULL REFERENCES hubs (id),
  seller_order_ids        uuid[] NOT NULL CHECK (cardinality(seller_order_ids) >= 1),
  status                  text NOT NULL CHECK (status IN ('READY', 'DISPATCHED')),
  awb                     text CHECK (awb IS NULL OR char_length(awb) BETWEEN 3 AND 64),
  courier_code            text CHECK (courier_code IS NULL OR char_length(courier_code) BETWEEN 1 AND 32),
  shopper_fee_piastres    bigint NOT NULL CHECK (shopper_fee_piastres >= 0),
  gco2e_estimate          bigint CHECK (gco2e_estimate IS NULL OR gco2e_estimate >= 0),
  co2e_factors_version    text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  dispatched_at           timestamptz,
  CONSTRAINT consolidated_dispatched_has_awb CHECK (status <> 'DISPATCHED' OR (awb IS NOT NULL AND dispatched_at IS NOT NULL))
);

CREATE INDEX consolidated_shipments_group_idx ON consolidated_shipments (order_group_id);
CREATE UNIQUE INDEX consolidated_shipments_awb_uq ON consolidated_shipments (courier_code, awb) WHERE awb IS NOT NULL;

CREATE TABLE hub_legs (
  seller_order_id   uuid PRIMARY KEY,
  order_group_id    uuid NOT NULL REFERENCES hub_order_groups (order_group_id),
  hub_id            uuid NOT NULL REFERENCES hubs (id),
  store_id          uuid NOT NULL,
  state             text NOT NULL CHECK (state IN
                      ('AT_HUB_EXPECTED', 'RECEIVED', 'CONSOLIDATED', 'DISPATCHED', 'CANCELLED', 'EXCEPTION')),
  line_ids          uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  subtotal_piastres bigint NOT NULL CHECK (subtotal_piastres >= 0),
  handoff_due_at    timestamptz NOT NULL,
  consolidation_id  uuid REFERENCES consolidated_shipments (id),
  version           integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hub_legs_assigned_has_parcel CHECK (state NOT IN ('CONSOLIDATED', 'DISPATCHED') OR consolidation_id IS NOT NULL)
);

CREATE INDEX hub_legs_group_idx ON hub_legs (order_group_id);
CREATE INDEX hub_legs_hub_state_idx ON hub_legs (hub_id, state);

CREATE TABLE hub_receipts (
  id               uuid PRIMARY KEY,
  seller_order_id  uuid NOT NULL REFERENCES hub_legs (seller_order_id),
  hub_id           uuid NOT NULL REFERENCES hubs (id),
  operator_id      uuid NOT NULL REFERENCES users (id),
  condition        text NOT NULL CHECK (condition IN ('ok', 'damaged')),
  scanned_at       timestamptz NOT NULL,
  CONSTRAINT hub_receipts_seller_order_uq UNIQUE (seller_order_id)
);

CREATE TABLE resale_listings (
  id                uuid PRIMARY KEY,
  return_id         uuid NOT NULL,
  unit_ref          uuid NOT NULL,
  store_id          uuid NOT NULL,
  source_sku_id     uuid NOT NULL,
  resale_sku_id     uuid NOT NULL,
  condition         text NOT NULL DEFAULT 'open_box_returned' CHECK (condition = 'open_box_returned'),
  grade             text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  photo_ids         text[] NOT NULL CHECK (cardinality(photo_ids) BETWEEN 1 AND 10),
  defect_note       text CHECK (defect_note IS NULL OR char_length(defect_note) BETWEEN 1 AND 500),
  price_piastres    bigint NOT NULL CHECK (price_piastres > 0),
  ownership         text NOT NULL CHECK (ownership IN ('seller', 'platform_rtv')),
  status            text NOT NULL CHECK (status IN ('LISTED', 'SOLD', 'WITHDRAWN')),
  listed_at         timestamptz NOT NULL,
  sold_at           timestamptz,
  created_by        uuid NOT NULL REFERENCES users (id),
  CONSTRAINT resale_listings_return_uq UNIQUE (return_id),
  CONSTRAINT resale_listings_unit_uq UNIQUE (unit_ref),
  CONSTRAINT resale_listings_grade_c_note CHECK (grade <> 'C' OR defect_note IS NOT NULL),
  CONSTRAINT resale_listings_sold_at CHECK (status <> 'SOLD' OR sold_at IS NOT NULL)
);

CREATE INDEX resale_listings_store_idx ON resale_listings (store_id, listed_at DESC, id DESC);
CREATE INDEX resale_listings_listed_idx ON resale_listings (listed_at DESC, id DESC) WHERE status = 'LISTED';

CREATE TABLE resale_proceeds (
  listing_id             uuid PRIMARY KEY REFERENCES resale_listings (id),
  gross_piastres         bigint NOT NULL CHECK (gross_piastres >= 0),
  seller_payable         bigint NOT NULL CHECK (seller_payable >= 0),
  platform_retained      bigint NOT NULL CHECK (platform_retained >= 0),
  ledger_entry_id        uuid,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resale_proceeds_sum CHECK (seller_payable + platform_retained = gross_piastres)
);

-- Row level security --------------------------------------------------------------------
ALTER TABLE hubs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON hubs TO app_user;
CREATE POLICY hubs_select ON hubs FOR SELECT USING (true);
CREATE POLICY hubs_system_insert ON hubs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY hubs_system_update ON hubs FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE hub_order_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON hub_order_groups TO app_user;
CREATE POLICY hub_order_groups_select ON hub_order_groups FOR SELECT
  USING (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY hub_order_groups_system_insert ON hub_order_groups FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE consolidated_shipments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON consolidated_shipments TO app_user;
CREATE POLICY consolidated_shipments_select ON consolidated_shipments FOR SELECT
  USING (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM hub_order_groups g WHERE g.order_group_id = consolidated_shipments.order_group_id AND g.user_id = app_user_id()));
CREATE POLICY consolidated_shipments_system_insert ON consolidated_shipments FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY consolidated_shipments_system_update ON consolidated_shipments FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE hub_legs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON hub_legs TO app_user;
CREATE POLICY hub_legs_select ON hub_legs FOR SELECT
  USING (app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY hub_legs_system_insert ON hub_legs FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY hub_legs_system_update ON hub_legs FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE hub_receipts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON hub_receipts TO app_user;
CREATE POLICY hub_receipts_select ON hub_receipts FOR SELECT USING (app_role() = 'system');
CREATE POLICY hub_receipts_system_insert ON hub_receipts FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE resale_listings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON resale_listings TO app_user;
CREATE POLICY resale_listings_select ON resale_listings FOR SELECT
  USING (status = 'LISTED' OR app_role() = 'system' OR store_id::text = ANY (app_store_ids()));
CREATE POLICY resale_listings_system_insert ON resale_listings FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY resale_listings_system_update ON resale_listings FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE resale_proceeds ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON resale_proceeds TO app_user;
CREATE POLICY resale_proceeds_select ON resale_proceeds FOR SELECT
  USING (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM resale_listings l WHERE l.id = resale_proceeds.listing_id AND l.store_id::text = ANY (app_store_ids())));
CREATE POLICY resale_proceeds_system_insert ON resale_proceeds FOR INSERT WITH CHECK (app_role() = 'system');
