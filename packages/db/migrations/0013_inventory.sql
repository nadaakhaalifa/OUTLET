-- migration: 0013_inventory
-- phase: expand (new tables only)
-- Source: docs/adr/0005-inventory-row-per-unit.md, docs/haul-master-prompt-v3.md 20.2, docs/data-model.md 7.12, ADR-0009, ADR-0011.
--
-- RLS design (ADR-0011, audit unchanged; this migration adds NO exception policy):
--   * inventory_locations, inventory_levels, inventory_units, reservation_lines, inventory_adjustments are store-owned:
--     store_id + app.enable_store_rls (store AND market isolation). Seller staff read their own rows through a store context.
--   * reservations are user-owned: app.enable_user_rls (the shopper sees only their own reservation).
--   * The shopper-side reserve/claim/release path runs as outlet_app. The audit only admits outlet_app exceptions of the form
--     <tbl>__app_insert, so a "reserve" UPDATE policy for outlet_app on the units is NOT possible without weakening it. The
--     service therefore uses the same trust model as the catalog: inside ONE transaction it re-binds the database context
--     per store ({kind:'store', storeId, userId}) for each SKU line, runs the line's statements, and restores the caller's
--     context. The store id comes from the line (catalog read model), never from a shopper-controlled filter: a wrong store id
--     simply finds zero rows. All store RLS policies stay in force on every statement.
--   * The sweeper cannot see other tenants' rows either. inventory_expiry_index is a small, non-tenant work queue (no
--     store_id / user_id column on purpose, like catalog_public_*: store_refs / owner_ref are pointers, not tenant keys; P1
--     opaque uuids, no personal data) written in the reserve transaction and deleted in the claim / release transaction.
--     The sweeper reads it, then re-binds store / user contexts per reservation. No worker policy, no WORKER_JOBS change,
--     no change to the reviewed rls-exceptions snapshot.
--
-- Deviations from the ERD (reported):
--   * inventory_locations: store-owned only (store_id NOT NULL, owner_type 'store'); platform hubs, store_location_id and
--     geo_area_id come with the tables they reference. No FK to markets (not built).
--   * inventory_units gets market_id (needed by the store policy pin and the sweeper); defect_card_id (graded one-off unit,
--     ADR-0009) next to item_unit_id (passport link). A serialised unit is never created or trimmed by the replenisher.
--   * reservations: store_ids uuid[] (which stores hold lines, needed to re-bind the context on claim / release), ttl_policy,
--     user_id. Reservation state names follow the ERD machine: ACTIVE, CLAIMED, RELEASED, EXPIRED.
--   * inventory_adjustments is not partitioned yet (volume is low in Phase 1); UNIQUE (store_id, idempotency_key) gives the
--     idempotency the master prompt asks for on every stock write.

CREATE TABLE inventory_locations (
  id         uuid PRIMARY KEY,
  market_id  text NOT NULL,
  owner_type text NOT NULL DEFAULT 'store' CHECK (owner_type = 'store'),
  store_id   uuid NOT NULL REFERENCES stores (id),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_locations_store_idx ON inventory_locations (store_id) WHERE active;
SELECT app.enable_store_rls('inventory_locations');

CREATE TABLE inventory_levels (
  sku_id               uuid NOT NULL REFERENCES skus (id),
  location_id          uuid NOT NULL REFERENCES inventory_locations (id),
  store_id             uuid NOT NULL REFERENCES stores (id),
  market_id            text NOT NULL,
  on_hand              int NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  -- claimed, not yet shipped. May exceed on_hand after a negative seller adjustment (orders are honoured).
  committed            int NOT NULL DEFAULT 0 CHECK (committed >= 0),
  pool_target          int NOT NULL DEFAULT 0 CHECK (pool_target >= 0),
  last_channel_version bigint,
  version              int NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id)
);
CREATE INDEX inventory_levels_store_idx ON inventory_levels (store_id, updated_at DESC);
SELECT app.enable_store_rls('inventory_levels');

CREATE TABLE reservations (
  id           uuid PRIMARY KEY,
  market_id    text NOT NULL,
  user_id      uuid NOT NULL,
  -- order group id: the idempotency key of the reserve call
  order_group_ref text NOT NULL CHECK (length(btrim(order_group_ref)) > 0),
  state        text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'CLAIMED', 'RELEASED', 'EXPIRED')),
  ttl_policy   text NOT NULL DEFAULT 'card' CHECK (ttl_policy IN ('card', 'wallet', 'fawry', 'cod')),
  expires_at   timestamptz NOT NULL,
  store_ids    uuid[] NOT NULL CHECK (cardinality(store_ids) > 0),
  claimed_at   timestamptz,
  released_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, order_group_ref)
);
CREATE INDEX reservations_active_expiry_idx ON reservations (expires_at) WHERE state = 'ACTIVE';
SELECT app.enable_user_rls('reservations');

CREATE TABLE reservation_lines (
  reservation_id uuid NOT NULL REFERENCES reservations (id),
  sku_id         uuid NOT NULL REFERENCES skus (id),
  location_id    uuid NOT NULL REFERENCES inventory_locations (id),
  store_id       uuid NOT NULL REFERENCES stores (id),
  market_id      text NOT NULL,
  qty            smallint NOT NULL CHECK (qty > 0),
  PRIMARY KEY (reservation_id, sku_id, location_id)
);
SELECT app.enable_store_rls('reservation_lines');

CREATE TABLE inventory_units (
  sku_id         uuid NOT NULL,
  location_id    uuid NOT NULL,
  id             uuid NOT NULL,
  store_id       uuid NOT NULL REFERENCES stores (id),
  market_id      text NOT NULL,
  state          text NOT NULL DEFAULT 'available' CHECK (state IN ('available', 'reserved', 'claimed')),
  reservation_id uuid REFERENCES reservations (id),
  expires_at     timestamptz,
  -- Graded one-off unit (ADR-0009): own defects, own passport. NULL for fungible pool rows.
  defect_card_id uuid REFERENCES defect_cards (id),
  item_unit_id   uuid REFERENCES item_units (id),
  PRIMARY KEY (sku_id, location_id, id),
  FOREIGN KEY (sku_id, location_id) REFERENCES inventory_levels (sku_id, location_id),
  CHECK ((state = 'available') = (reservation_id IS NULL)),
  CHECK ((state = 'reserved') = (expires_at IS NOT NULL))
) WITH (fillfactor = 70);
-- reserve scan: ORDER BY id LIMIT qty FOR UPDATE SKIP LOCKED
CREATE INDEX inventory_units_available_idx ON inventory_units (sku_id, location_id, id) WHERE state = 'available';
CREATE INDEX inventory_units_reserved_expiry_idx ON inventory_units (expires_at) WHERE state = 'reserved';
CREATE INDEX inventory_units_reservation_idx ON inventory_units (reservation_id) WHERE reservation_id IS NOT NULL;
SELECT app.enable_store_rls('inventory_units');

CREATE TABLE inventory_adjustments (
  id               uuid PRIMARY KEY,
  sku_id           uuid NOT NULL REFERENCES skus (id),
  location_id      uuid NOT NULL REFERENCES inventory_locations (id),
  store_id         uuid NOT NULL REFERENCES stores (id),
  market_id        text NOT NULL,
  delta            int NOT NULL CHECK (delta <> 0),
  reason           text NOT NULL CHECK (reason IN ('seller_edit', 'channel_sync', 'return_restock', 'claim', 'write_off', 'count', 'donation')),
  idempotency_key  text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  external_version bigint,
  actor_type       text NOT NULL,
  actor_id         uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, idempotency_key)
);
CREATE INDEX inventory_adjustments_sku_idx ON inventory_adjustments (sku_id, id DESC);
SELECT app.enable_store_rls('inventory_adjustments');
-- Append-only history.
REVOKE UPDATE, DELETE ON inventory_adjustments FROM outlet_app;

-- Sweeper work queue, see the RLS note above. No tenant key columns by design.
CREATE TABLE inventory_expiry_index (
  reservation_id uuid PRIMARY KEY REFERENCES reservations (id),
  market_id      text NOT NULL,
  store_refs     uuid[] NOT NULL,
  owner_ref      uuid NOT NULL,
  expires_at     timestamptz NOT NULL
);
CREATE INDEX inventory_expiry_index_due_idx ON inventory_expiry_index (market_id, expires_at);
