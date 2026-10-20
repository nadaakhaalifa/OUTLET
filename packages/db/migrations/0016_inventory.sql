-- migration: 0016_inventory
-- phase: expand
--
-- Row-per-unit inventory (ADR-0005, ADR-0011; spec 20.2, 7, 19; docs/data-model/inventory.md).
--
-- What this adds
--   tables    locations, stock_pools, inventory_levels, inventory_units, reservation_ttl_policies,
--             reservations, reservation_lines, inventory_adjustments, inventory_oversell_events
--   functions inventory_reserve, inventory_claim, inventory_release, inventory_sweep_expired,
--             inventory_rebalance_pool, inventory_replenish_due, inventory_apply_stock_sync,
--             inventory_pool_transfer (all return jsonb, take the caller's clock as p_now)
--
-- Deliberate deviations from docs/data-model/inventory.md (see docs/specs/inventory.md section 4):
--   * No `committed <= on_hand` CHECK. A seller may lower on_hand below what is already promised;
--     orders are honoured (spec 20.2) and the shortfall is recorded in inventory_oversell_events.
--     Free stock is greatest(0, on_hand - committed - reserved) and the pool never exceeds it.
--   * inventory_adjustments is not partitioned yet (the outbox follows the same deferral, 0004).
--     Idempotency is one unique index. Partitioning is a later expand migration.
--   * CLAIM and RELEASE do not write adjustment rows: reservations, units and the outbox are the
--     record, which keeps the hot path to one write set. Adjustments record on_hand changes only.
--   * locations.store_id and *.store_id have no FK to stores: the sellers module does not exist yet.
--
-- Concurrency contract (proved against real PostgreSQL 16 by tooling/db/inventory-concurrency.sh,
-- NOT provable on PGlite, which has a single connection):
--   * unit picks use FOR UPDATE SKIP LOCKED and never wait on another picker;
--   * lock order is always: reservation row, then advisory lock, then level row, sorted by
--     (sku_id, location_id, pool_id); unit rows are only ever taken with SKIP LOCKED or by
--     the transaction that owns the reservation;
--   * the reserve path never touches the level row except to replenish an empty pool, and it
--     only does that when free stock exists (a sold-out SKU fails without any lock). Units and
--     reservation_lines carry NO foreign key to inventory_levels on purpose: an FK check takes
--     FOR KEY SHARE on the level row, which queued every reserve behind claims and produced
--     real 40P01 deadlocks in tooling/db/inventory-concurrency.sh (first version of this file);
--   * level and reservation rows are locked FOR NO KEY UPDATE, never FOR UPDATE;
--   * pool size is recomputed from ONE statement over the live partial index so that counts of
--     AVAILABLE and RESERVED rows come from a single snapshot.
--
-- Application contract
--   * run reserve under SET LOCAL statement_timeout = '2s' (the function cannot set it for itself)
--   * schedule inventory_sweep_expired every 30 s and inventory_replenish_due on a short interval
--     (pg_cron is not installed by 0001; a worker calls them until it is)
--   * functions are SECURITY INVOKER: they run under the caller's RLS. The API calls them with
--     app.role = 'system' after the policy guard has authorised the request.

-- ---------------------------------------------------------------------------------------
-- reference tables
-- ---------------------------------------------------------------------------------------

CREATE TABLE locations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid,                         -- null for a HAUL hub; tenant key otherwise
  kind            text NOT NULL CHECK (kind IN ('SELLER_WAREHOUSE', 'HUB')),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  governorate_code text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT locations_hub_has_no_store CHECK ((kind = 'HUB') = (store_id IS NULL))
);
CREATE INDEX locations_store_idx ON locations (store_id);

CREATE TABLE stock_pools (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('STANDARD', 'DROP', 'FAWRY')),
  drop_id     uuid,
  description text NOT NULL DEFAULT '',
  CONSTRAINT stock_pools_drop_has_drop_id CHECK ((kind = 'DROP') = (drop_id IS NOT NULL))
);
CREATE UNIQUE INDEX stock_pools_singleton_kind_uq ON stock_pools (kind) WHERE kind <> 'DROP';
CREATE UNIQUE INDEX stock_pools_drop_uq ON stock_pools (drop_id) WHERE drop_id IS NOT NULL;

-- Fixed ids so that the application constants and the seed agree.
INSERT INTO stock_pools (id, kind, description) VALUES
  ('00000000-0000-4000-8000-000000000501', 'STANDARD', 'Default sellable stock'),
  ('00000000-0000-4000-8000-000000000502', 'FAWRY',    'Separate non-drop pool for 24 h Fawry holds (ADR-0011)');

CREATE TABLE reservation_ttl_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method    text NOT NULL CHECK (payment_method IN
                      ('CARD', 'APPLE_PAY', 'MEEZA', 'COD', 'WALLET', 'INSTAPAY', 'BNPL', 'FAWRY')),
  ttl_seconds       integer NOT NULL CHECK (ttl_seconds BETWEEN 30 AND 172800),
  extension_seconds integer NOT NULL DEFAULT 0 CHECK (extension_seconds BETWEEN 0 AND 3600),
  pool_kind         text NOT NULL CHECK (pool_kind IN ('STANDARD', 'FAWRY')),
  max_qty_per_line  integer CHECK (max_qty_per_line IS NULL OR max_qty_per_line BETWEEN 1 AND 10),
  version           integer NOT NULL CHECK (version >= 1),
  valid_from        timestamptz NOT NULL DEFAULT now(),
  changed_by        uuid,
  CONSTRAINT reservation_ttl_policies_method_version_uq UNIQUE (payment_method, version)
);

-- ADR-0011 proposed defaults. Same ids as DEFAULT_TTL_POLICIES in packages/domain.
INSERT INTO reservation_ttl_policies (id, payment_method, ttl_seconds, extension_seconds, pool_kind, max_qty_per_line, version) VALUES
  ('00000000-0000-4000-8000-000000000601', 'CARD',      600,   300, 'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000602', 'APPLE_PAY', 600,   300, 'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000603', 'MEEZA',     600,   300, 'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000604', 'COD',       600,   0,   'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000605', 'WALLET',    1800,  0,   'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000606', 'INSTAPAY',  1800,  0,   'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000607', 'BNPL',      900,   0,   'STANDARD', NULL, 1),
  ('00000000-0000-4000-8000-000000000608', 'FAWRY',     86400, 0,   'FAWRY',    2,    1);

-- ---------------------------------------------------------------------------------------
-- levels and units
-- ---------------------------------------------------------------------------------------

CREATE TABLE inventory_levels (
  sku_id         uuid NOT NULL,                 -- logical FK to catalog (hot path avoids the check)
  location_id    uuid NOT NULL REFERENCES locations (id),
  pool_id        uuid NOT NULL REFERENCES stock_pools (id),
  store_id       uuid NOT NULL,                 -- tenancy
  on_hand        integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  committed      integer NOT NULL DEFAULT 0 CHECK (committed >= 0),
  sync_version   bigint  NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  source_version bigint,                        -- last accepted channel version, null if never
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id, pool_id)
);
CREATE INDEX inventory_levels_store_idx ON inventory_levels (store_id, sku_id);

CREATE TABLE reservations (
  id                uuid PRIMARY KEY,
  order_group_id    uuid NOT NULL,
  user_id           uuid NOT NULL REFERENCES users (id),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLAIMED', 'RELEASED', 'EXPIRED')),
  hold_reason       text NOT NULL CHECK (hold_reason IN
                      ('CARD_WINDOW', 'FAWRY_WINDOW', 'WALLET_WINDOW', 'INSTAPAY_WINDOW', 'BNPL_WINDOW', 'COD')),
  ttl_policy_id     uuid NOT NULL REFERENCES reservation_ttl_policies (id),
  expires_at        timestamptz NOT NULL,
  lines_fingerprint text NOT NULL,              -- canonical text of the sorted lines (idempotency)
  created_at        timestamptz NOT NULL,
  resolved_at       timestamptz,
  CONSTRAINT reservations_order_group_uq UNIQUE (order_group_id),
  CONSTRAINT reservations_resolved_chk CHECK ((status = 'ACTIVE') = (resolved_at IS NULL))
);
CREATE INDEX reservations_due_idx ON reservations (expires_at, id) WHERE status = 'ACTIVE';
CREATE INDEX reservations_user_idx ON reservations (user_id);

CREATE TABLE reservation_lines (
  reservation_id uuid NOT NULL REFERENCES reservations (id),
  sku_id         uuid NOT NULL,
  location_id    uuid NOT NULL,
  pool_id        uuid NOT NULL,
  store_id       uuid NOT NULL,
  qty            integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  PRIMARY KEY (reservation_id, sku_id, location_id)
  -- no FK to inventory_levels: see the header (a foreign-key check would lock the hot level row)
);

CREATE TABLE inventory_units (
  sku_id           uuid NOT NULL,
  location_id      uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),   -- globally unique (data model I-21)
  pool_id          uuid NOT NULL,
  store_id         uuid NOT NULL,
  state            text NOT NULL DEFAULT 'AVAILABLE'
                     CHECK (state IN ('AVAILABLE', 'RESERVED', 'CLAIMED', 'WRITTEN_OFF')),
  reservation_id   uuid REFERENCES reservations (id),
  expires_at       timestamptz,
  state_changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku_id, location_id, id),
  -- no FK to inventory_levels: see the header. Units are only ever created by
  -- inventory_rebalance_core, which requires the level row and holds its lock.
  CONSTRAINT inventory_units_available_free CHECK (state <> 'AVAILABLE' OR reservation_id IS NULL),
  CONSTRAINT inventory_units_held_has_reservation CHECK (state NOT IN ('RESERVED', 'CLAIMED') OR reservation_id IS NOT NULL)
);
-- pick query
CREATE INDEX inventory_units_available_idx ON inventory_units (sku_id, location_id, pool_id, id)
  WHERE state = 'AVAILABLE';
-- one-snapshot pool sizing (AVAILABLE and RESERVED counted by a single statement)
CREATE INDEX inventory_units_live_idx ON inventory_units (sku_id, location_id, pool_id, state)
  WHERE state IN ('AVAILABLE', 'RESERVED');
-- sweeper and per-reservation operations
CREATE INDEX inventory_units_expiry_idx ON inventory_units (expires_at) WHERE state = 'RESERVED';
CREATE INDEX inventory_units_reservation_idx ON inventory_units (reservation_id) WHERE reservation_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------
-- append-only evidence
-- ---------------------------------------------------------------------------------------

CREATE TABLE inventory_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at      timestamptz NOT NULL,
  sku_id           uuid NOT NULL,
  location_id      uuid NOT NULL,
  pool_id          uuid NOT NULL,
  store_id         uuid NOT NULL,
  delta            integer NOT NULL,
  resulting_on_hand integer NOT NULL CHECK (resulting_on_hand >= 0),
  reason           text NOT NULL CHECK (reason IN
                     ('SELLER_SYNC', 'MANUAL', 'RETURN_RESTOCK', 'WRITE_OFF', 'CORRECTION', 'POOL_TRANSFER')),
  reason_detail    text,                        -- seller-facing reason code (recount, damaged, ...)
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  sync_version     bigint NOT NULL,
  source_version   bigint,
  actor_type       text NOT NULL CHECK (actor_type IN ('seller', 'channel', 'system')),
  actor_id         text NOT NULL,
  CONSTRAINT inventory_adjustments_key_uq UNIQUE (idempotency_key, sku_id, pool_id)
);
CREATE INDEX inventory_adjustments_sku_idx ON inventory_adjustments (sku_id, occurred_at);

CREATE TRIGGER inventory_adjustments_immutable_trg
  BEFORE UPDATE OR DELETE ON inventory_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER inventory_adjustments_no_truncate_trg
  BEFORE TRUNCATE ON inventory_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Penalty input for the seller-health module. Written only when a decrease cannot cover stock
-- that is already reserved or claimed (spec 20.2).
CREATE TABLE inventory_oversell_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL,
  sku_id          uuid NOT NULL,
  location_id     uuid NOT NULL,
  pool_id         uuid NOT NULL,
  store_id        uuid NOT NULL,
  shortfall_units integer NOT NULL CHECK (shortfall_units > 0),
  sync_version    bigint NOT NULL,
  reason_detail   text
);
CREATE INDEX inventory_oversell_store_idx ON inventory_oversell_events (store_id, occurred_at);

CREATE TRIGGER inventory_oversell_events_immutable_trg
  BEFORE UPDATE OR DELETE ON inventory_oversell_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER inventory_oversell_events_no_truncate_trg
  BEFORE TRUNCATE ON inventory_oversell_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION inventory_advisory_key(p_sku uuid, p_loc uuid, p_pool uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE
AS $$
  SELECT hashtextextended(p_sku::text || '|' || p_loc::text || '|' || p_pool::text, 0)
$$;

CREATE FUNCTION inventory_emit(p_type text, p_aggregate_type text, p_aggregate_id uuid,
                               p_payload jsonb, p_headers jsonb, p_now timestamptz) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload, headers)
  VALUES (gen_random_uuid(), p_now, p_aggregate_type, p_aggregate_id, p_type,
          p_aggregate_type || ':' || p_aggregate_id::text, p_payload, p_headers)
$$;

-- Pool sizing. The caller MUST already hold the level row lock (FOR NO KEY UPDATE).
-- target = min(1000, greatest(0, on_hand - committed - reserved)); rows are inserted or the
-- highest ids removed (the pick takes the lowest, so removals avoid hot rows).
CREATE FUNCTION inventory_rebalance_core(p_sku uuid, p_loc uuid, p_pool uuid) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_on_hand   integer;
  v_committed integer;
  v_store     uuid;
  v_reserved  integer;
  v_available integer;
  v_target    integer;
BEGIN
  SELECT on_hand, committed, store_id INTO v_on_hand, v_committed, v_store
    FROM inventory_levels WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT count(*) FILTER (WHERE state = 'AVAILABLE'), count(*) FILTER (WHERE state = 'RESERVED')
    INTO v_available, v_reserved
    FROM inventory_units
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool AND state IN ('AVAILABLE', 'RESERVED');

  v_target := least(1000, greatest(0, v_on_hand - v_committed - v_reserved));

  IF v_available < v_target THEN
    INSERT INTO inventory_units (sku_id, location_id, pool_id, store_id)
    SELECT p_sku, p_loc, p_pool, v_store FROM generate_series(1, v_target - v_available);
  ELSIF v_available > v_target THEN
    DELETE FROM inventory_units d
     USING (SELECT sku_id, location_id, id FROM inventory_units
             WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool AND state = 'AVAILABLE'
             ORDER BY id DESC LIMIT (v_available - v_target)
             FOR UPDATE SKIP LOCKED) x
     WHERE d.sku_id = x.sku_id AND d.location_id = x.location_id AND d.id = x.id;
  END IF;
  RETURN v_target;
END
$$;

-- Replenisher for one (sku, location, pool): advisory lock, level lock, rebalance.
CREATE FUNCTION inventory_rebalance_pool(p_sku uuid, p_loc uuid, p_pool uuid) RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(inventory_advisory_key(p_sku, p_loc, p_pool));
  PERFORM 1 FROM inventory_levels
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool FOR NO KEY UPDATE;
  RETURN inventory_rebalance_core(p_sku, p_loc, p_pool);
END
$$;

-- ---------------------------------------------------------------------------------------
-- reserve
-- ---------------------------------------------------------------------------------------
-- p_lines: [{"sku_id","location_id","pool_id","store_id","qty"}], at most 50, qty 1..10.
-- Returns {"status":"reserved","reservation_id","expires_at","replayed"}
--       | {"status":"insufficient","shortfalls":[{"sku_id","location_id","requested","available"}]}
--       | {"status":"conflict"} (order group reused with different lines)
--       | {"status":"closed","reservation_status"} (same lines, reservation no longer ACTIVE)
-- All-or-nothing: the inner block is a subtransaction, so a shortfall on any line rolls back
-- every unit taken so far and the reservation row itself.

CREATE FUNCTION inventory_reserve(
  p_reservation_id uuid,
  p_order_group_id uuid,
  p_user_id        uuid,
  p_lines          jsonb,
  p_ttl_seconds    integer,
  p_ttl_policy_id  uuid,
  p_hold_reason    text,
  p_fingerprint    text,
  p_now            timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_expires  timestamptz := p_now + make_interval(secs => p_ttl_seconds);
  v_inserted uuid;
  v_existing reservations%ROWTYPE;
  v_line     record;
  v_picked   integer;
  v_rest     integer;
  v_free     integer;
  v_short    jsonb := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'inventory_reserve: p_lines must be an array of 1 to 50 lines' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO reservations (id, order_group_id, user_id, status, hold_reason, ttl_policy_id,
                              expires_at, lines_fingerprint, created_at)
    VALUES (p_reservation_id, p_order_group_id, p_user_id, 'ACTIVE', p_hold_reason, p_ttl_policy_id,
            v_expires, p_fingerprint, p_now)
    ON CONFLICT (order_group_id) DO NOTHING
    RETURNING id INTO v_inserted;

    IF v_inserted IS NULL THEN
      SELECT * INTO v_existing FROM reservations WHERE order_group_id = p_order_group_id;
      IF v_existing.lines_fingerprint <> p_fingerprint THEN
        RETURN jsonb_build_object('status', 'conflict');
      END IF;
      IF v_existing.status <> 'ACTIVE' THEN
        RETURN jsonb_build_object('status', 'closed', 'reservation_status', v_existing.status);
      END IF;
      RETURN jsonb_build_object('status', 'reserved', 'reservation_id', v_existing.id,
                                'expires_at', v_existing.expires_at, 'replayed', true);
    END IF;

    FOR v_line IN
      SELECT x.sku_id, x.location_id, x.pool_id, x.store_id, x.qty
        FROM jsonb_to_recordset(p_lines)
             AS x(sku_id uuid, location_id uuid, pool_id uuid, store_id uuid, qty integer)
       ORDER BY x.sku_id, x.location_id, x.pool_id
    LOOP
      IF v_line.qty IS NULL OR v_line.qty < 1 THEN
        RAISE EXCEPTION 'inventory_reserve: invalid quantity' USING ERRCODE = '22023';
      END IF;

      WITH picked AS (
        SELECT id FROM inventory_units
         WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id
           AND pool_id = v_line.pool_id AND state = 'AVAILABLE'
         ORDER BY id LIMIT v_line.qty FOR UPDATE SKIP LOCKED)
      UPDATE inventory_units u
         SET state = 'RESERVED', reservation_id = p_reservation_id, expires_at = v_expires, state_changed_at = p_now
        FROM picked
       WHERE u.sku_id = v_line.sku_id AND u.location_id = v_line.location_id AND u.id = picked.id;
      GET DIAGNOSTICS v_picked = ROW_COUNT;
      v_free := NULL;

      IF v_picked < v_line.qty THEN
        -- Pool empty or rows skipped. Free stock = on_hand - committed - reserved in ONE statement
        -- (one snapshot). If none exists the SKU is sold out: fail without taking any lock.
        SELECT l.on_hand - l.committed - (SELECT count(*) FROM inventory_units u
                                           WHERE u.sku_id = l.sku_id AND u.location_id = l.location_id
                                             AND u.pool_id = l.pool_id AND u.state = 'RESERVED')
          INTO v_free
          FROM inventory_levels l
         WHERE l.sku_id = v_line.sku_id AND l.location_id = v_line.location_id AND l.pool_id = v_line.pool_id;
      END IF;

      IF v_picked < v_line.qty AND coalesce(v_free, 0) > 0 THEN
        -- Stock exists but is not materialised (or rows were skipped): one inline replenish under
        -- the advisory lock, then retry the pick.
        PERFORM pg_advisory_xact_lock(inventory_advisory_key(v_line.sku_id, v_line.location_id, v_line.pool_id));
        PERFORM 1 FROM inventory_levels
         WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id AND pool_id = v_line.pool_id
           FOR NO KEY UPDATE;
        PERFORM inventory_rebalance_core(v_line.sku_id, v_line.location_id, v_line.pool_id);

        v_rest := v_line.qty - v_picked;
        WITH picked AS (
          SELECT id FROM inventory_units
           WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id
             AND pool_id = v_line.pool_id AND state = 'AVAILABLE'
           ORDER BY id LIMIT v_rest FOR UPDATE SKIP LOCKED)
        UPDATE inventory_units u
           SET state = 'RESERVED', reservation_id = p_reservation_id, expires_at = v_expires, state_changed_at = p_now
          FROM picked
         WHERE u.sku_id = v_line.sku_id AND u.location_id = v_line.location_id AND u.id = picked.id;
        GET DIAGNOSTICS v_rest = ROW_COUNT;
        v_picked := v_picked + v_rest;
      END IF;

      IF v_picked < v_line.qty THEN
        v_short := v_short || jsonb_build_object('sku_id', v_line.sku_id, 'location_id', v_line.location_id,
                                                 'requested', v_line.qty, 'available', v_picked);
      ELSE
        INSERT INTO reservation_lines (reservation_id, sku_id, location_id, pool_id, store_id, qty)
        VALUES (p_reservation_id, v_line.sku_id, v_line.location_id, v_line.pool_id, v_line.store_id, v_line.qty);
      END IF;
    END LOOP;

    IF jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION 'insufficient stock' USING ERRCODE = 'IV001';
    END IF;

    FOR v_line IN SELECT sku_id, qty FROM reservation_lines WHERE reservation_id = p_reservation_id ORDER BY sku_id LOOP
      PERFORM inventory_emit('inventory.reserved', 'reservation', p_reservation_id,
        jsonb_build_object('reservation_id', p_reservation_id, 'sku_id', v_line.sku_id,
                           'quantity', v_line.qty, 'expires_at', v_expires),
        '{}'::jsonb, p_now);
    END LOOP;

    RETURN jsonb_build_object('status', 'reserved', 'reservation_id', p_reservation_id,
                              'expires_at', v_expires, 'replayed', false);
  EXCEPTION WHEN SQLSTATE 'IV001' THEN
    RETURN jsonb_build_object('status', 'insufficient', 'shortfalls', v_short);
  END;
END
$$;

-- ---------------------------------------------------------------------------------------
-- claim (payment succeeded) - same transaction as the caller's ledger posting
-- ---------------------------------------------------------------------------------------
-- ACTIVE: RESERVED units become CLAIMED even if expires_at has passed but the sweeper has not run.
-- EXPIRED or RELEASED: late claim straight from the free pool; if stock is gone the function
-- returns {"status":"unavailable"} and the saga refunds automatically (spec 7).

CREATE FUNCTION inventory_claim(p_order_group_id uuid, p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r        reservations%ROWTYPE;
  v_line   record;
  v_n      integer;
  v_have   integer;
  v_late   boolean;
  v_short  jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO r FROM reservations WHERE order_group_id = p_order_group_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF r.status = 'CLAIMED' THEN
    RETURN jsonb_build_object('status', 'already_claimed');
  END IF;
  v_late := r.status <> 'ACTIVE';

  BEGIN
    IF v_late THEN
      -- advisory locks first (same order as the reserve path), sorted
      FOR v_line IN SELECT sku_id, location_id, pool_id FROM reservation_lines
                     WHERE reservation_id = r.id ORDER BY sku_id, location_id, pool_id LOOP
        PERFORM pg_advisory_xact_lock(inventory_advisory_key(v_line.sku_id, v_line.location_id, v_line.pool_id));
      END LOOP;
    ELSE
      -- Unit rows BEFORE any level lock. A concurrent reserve can hold a stray row lock on one of
      -- these units (FOR UPDATE locks a row before re-checking the predicate, and keeps the lock
      -- when the re-check fails). That reserve may itself be queued for the level lock, so waiting
      -- on its rows while holding the level lock is a deadlock (observed on PostgreSQL 16 by
      -- tooling/db/inventory-concurrency.sh). Waiting here, holding no level lock, is safe.
      FOR v_line IN SELECT sku_id, location_id, pool_id, qty FROM reservation_lines
                     WHERE reservation_id = r.id ORDER BY sku_id, location_id, pool_id LOOP
        UPDATE inventory_units
           SET state = 'CLAIMED', expires_at = NULL, state_changed_at = p_now
         WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id
           AND reservation_id = r.id AND state = 'RESERVED';
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n <> v_line.qty THEN
          RAISE EXCEPTION 'reservation % line % holds % units, expected %', r.id, v_line.sku_id, v_n, v_line.qty
            USING ERRCODE = 'IV002';
        END IF;
      END LOOP;
    END IF;

    PERFORM 1 FROM inventory_levels l
      JOIN reservation_lines rl
        ON rl.sku_id = l.sku_id AND rl.location_id = l.location_id AND rl.pool_id = l.pool_id
     WHERE rl.reservation_id = r.id
     ORDER BY l.sku_id, l.location_id, l.pool_id
       FOR NO KEY UPDATE OF l;

    FOR v_line IN SELECT sku_id, location_id, pool_id, qty FROM reservation_lines
                   WHERE reservation_id = r.id ORDER BY sku_id, location_id, pool_id LOOP
      IF v_late THEN
        SELECT count(*) INTO v_have FROM inventory_units
         WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id
           AND pool_id = v_line.pool_id AND state = 'AVAILABLE';
        IF v_have < v_line.qty THEN
          PERFORM inventory_rebalance_core(v_line.sku_id, v_line.location_id, v_line.pool_id);
        END IF;
        WITH picked AS (
          SELECT id FROM inventory_units
           WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id
             AND pool_id = v_line.pool_id AND state = 'AVAILABLE'
           ORDER BY id LIMIT v_line.qty FOR UPDATE SKIP LOCKED)
        UPDATE inventory_units u
           SET state = 'CLAIMED', reservation_id = r.id, expires_at = NULL, state_changed_at = p_now
          FROM picked
         WHERE u.sku_id = v_line.sku_id AND u.location_id = v_line.location_id AND u.id = picked.id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        IF v_n < v_line.qty THEN
          v_short := v_short || jsonb_build_object('sku_id', v_line.sku_id, 'location_id', v_line.location_id,
                                                   'requested', v_line.qty, 'available', v_n);
        END IF;
      END IF;

      UPDATE inventory_levels
         SET committed = committed + v_line.qty, updated_at = p_now
       WHERE sku_id = v_line.sku_id AND location_id = v_line.location_id AND pool_id = v_line.pool_id;
    END LOOP;

    IF jsonb_array_length(v_short) > 0 THEN
      RAISE EXCEPTION 'insufficient stock for late claim' USING ERRCODE = 'IV001';
    END IF;

    UPDATE reservations SET status = 'CLAIMED', resolved_at = p_now WHERE id = r.id;

    FOR v_line IN SELECT sku_id, qty FROM reservation_lines WHERE reservation_id = r.id ORDER BY sku_id LOOP
      PERFORM inventory_emit('inventory.claimed', 'reservation', r.id,
        jsonb_build_object('reservation_id', r.id, 'sku_id', v_line.sku_id, 'quantity', v_line.qty,
                           'order_group_id', r.order_group_id),
        jsonb_build_object('late', v_late), p_now);
    END LOOP;

    RETURN jsonb_build_object('status', CASE WHEN v_late THEN 'claimed_late' ELSE 'claimed' END);
  EXCEPTION WHEN SQLSTATE 'IV001' THEN
    RETURN jsonb_build_object('status', 'unavailable', 'shortfalls', v_short);
  END;
END
$$;

-- ---------------------------------------------------------------------------------------
-- release and expiry
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION inventory_release_reservation(p_reservation_id uuid, p_new_status text,
                                              p_reason text, p_now timestamptz) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_n integer;
  v_line record;
BEGIN
  UPDATE inventory_units
     SET state = 'AVAILABLE', reservation_id = NULL, expires_at = NULL, state_changed_at = p_now
   WHERE reservation_id = p_reservation_id AND state = 'RESERVED';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE reservations SET status = p_new_status, resolved_at = p_now WHERE id = p_reservation_id;
  FOR v_line IN SELECT sku_id, qty FROM reservation_lines WHERE reservation_id = p_reservation_id ORDER BY sku_id LOOP
    PERFORM inventory_emit('inventory.released', 'reservation', p_reservation_id,
      jsonb_build_object('reservation_id', p_reservation_id, 'sku_id', v_line.sku_id,
                         'quantity', v_line.qty, 'reason', p_reason),
      '{}'::jsonb, p_now);
  END LOOP;
  RETURN v_n;
END
$$;

CREATE FUNCTION inventory_release(p_order_group_id uuid, p_reason text, p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r      reservations%ROWTYPE;
  v_line record;
BEGIN
  IF p_reason NOT IN ('payment_failed', 'cancelled', 'abandoned') THEN
    RAISE EXCEPTION 'inventory_release: unknown reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM reservations WHERE order_group_id = p_order_group_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF r.status <> 'ACTIVE' THEN
    RETURN jsonb_build_object('status', 'noop', 'reservation_status', r.status);
  END IF;
  PERFORM inventory_release_reservation(r.id, 'RELEASED', p_reason, p_now);
  FOR v_line IN SELECT sku_id, location_id, pool_id FROM reservation_lines
                 WHERE reservation_id = r.id ORDER BY sku_id, location_id, pool_id LOOP
    PERFORM inventory_rebalance_pool(v_line.sku_id, v_line.location_id, v_line.pool_id);
  END LOOP;
  RETURN jsonb_build_object('status', 'released');
END
$$;

CREATE FUNCTION inventory_sweep_expired(p_now timestamptz, p_batch integer DEFAULT 500) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  r       record;
  v_ids   uuid[] := ARRAY[]::uuid[];
  v_units integer := 0;
  v_n     integer;
  v_key   record;
BEGIN
  IF p_batch NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'inventory_sweep_expired: batch out of range' USING ERRCODE = '22023';
  END IF;
  FOR r IN
    SELECT id FROM reservations
     WHERE status = 'ACTIVE' AND expires_at <= p_now
     ORDER BY expires_at, id LIMIT p_batch
       FOR NO KEY UPDATE SKIP LOCKED
  LOOP
    v_n := inventory_release_reservation(r.id, 'EXPIRED', 'expired', p_now);
    v_units := v_units + v_n;
    v_ids := v_ids || r.id;
  END LOOP;

  FOR v_key IN
    SELECT DISTINCT rl.sku_id, rl.location_id, rl.pool_id
      FROM reservation_lines rl WHERE rl.reservation_id = ANY (v_ids)
     ORDER BY 1, 2, 3
  LOOP
    PERFORM inventory_rebalance_pool(v_key.sku_id, v_key.location_id, v_key.pool_id);
  END LOOP;
  RETURN jsonb_build_object('expired_reservations', coalesce(array_length(v_ids, 1), 0), 'released_units', v_units);
END
$$;

-- Candidate finder + rebalance for the background replenisher.
CREATE FUNCTION inventory_replenish_due(p_limit integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_key record;
  v_n   integer := 0;
BEGIN
  FOR v_key IN
    SELECT l.sku_id, l.location_id, l.pool_id
      FROM inventory_levels l
      CROSS JOIN LATERAL (
        SELECT count(*) FILTER (WHERE u.state = 'AVAILABLE') AS available,
               count(*) FILTER (WHERE u.state = 'RESERVED')  AS reserved
          FROM inventory_units u
         WHERE u.sku_id = l.sku_id AND u.location_id = l.location_id AND u.pool_id = l.pool_id
           AND u.state IN ('AVAILABLE', 'RESERVED')) c
     WHERE c.available <> least(1000, greatest(0, l.on_hand - l.committed - c.reserved))
     ORDER BY l.sku_id, l.location_id, l.pool_id
     LIMIT p_limit
  LOOP
    PERFORM inventory_rebalance_pool(v_key.sku_id, v_key.location_id, v_key.pool_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END
$$;

-- ---------------------------------------------------------------------------------------
-- seller stock sync (idempotent, versioned)
-- ---------------------------------------------------------------------------------------
-- p_mode set|adjust. p_expected_version is optimistic concurrency against sync_version.
-- p_source_version is a channel-supplied monotonic version; equal or older is a stale no-op.
-- The idempotency key is checked UNDER the level lock, so concurrent replays cannot double-apply.

CREATE FUNCTION inventory_apply_stock_sync(
  p_sku              uuid,
  p_loc              uuid,
  p_pool             uuid,
  p_store            uuid,
  p_mode             text,
  p_quantity         integer,
  p_reason           text,
  p_idempotency_key  text,
  p_expected_version bigint,
  p_source_version   bigint,
  p_actor_type       text,
  p_actor_id         text,
  p_now              timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  l          inventory_levels%ROWTYPE;
  v_prev     inventory_adjustments%ROWTYPE;
  v_reserved integer;
  v_new      bigint;
  v_oversold integer := 0;
  v_old      integer;
  v_created  uuid;
  v_fawry    uuid;
  v_fawry_on integer := 0;
  v_pool     uuid;
BEGIN
  IF p_mode NOT IN ('set', 'adjust') THEN
    RAISE EXCEPTION 'inventory_apply_stock_sync: unknown mode' USING ERRCODE = '22023';
  END IF;

  -- 'set' on the STANDARD pool is the PHYSICAL total across pools (ADV-3): the FAWRY allocation
  -- is subtracted. Advisory locks are taken in sorted pool order, like inventory_pool_transfer.
  IF p_mode = 'set' AND EXISTS (SELECT 1 FROM stock_pools WHERE id = p_pool AND kind = 'STANDARD') THEN
    SELECT id INTO v_fawry FROM stock_pools WHERE kind = 'FAWRY';
  END IF;
  FOR v_pool IN SELECT unnest(ARRAY[p_pool, coalesce(v_fawry, p_pool)]) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(inventory_advisory_key(p_sku, p_loc, v_pool));
  END LOOP;
  IF v_fawry IS NOT NULL THEN
    SELECT coalesce(on_hand, 0) INTO v_fawry_on FROM inventory_levels
     WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = v_fawry;
    v_fawry_on := coalesce(v_fawry_on, 0);
  END IF;
  INSERT INTO inventory_levels (sku_id, location_id, pool_id, store_id, updated_at)
  VALUES (p_sku, p_loc, p_pool, p_store, p_now)
  ON CONFLICT (sku_id, location_id, pool_id) DO NOTHING
  RETURNING sku_id INTO v_created;
  SELECT * INTO l FROM inventory_levels
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool FOR NO KEY UPDATE;

  IF l.store_id <> p_store THEN
    RAISE EXCEPTION 'inventory_apply_stock_sync: store mismatch' USING ERRCODE = 'IV003';
  END IF;

  v_old := l.on_hand;
  SELECT count(*) INTO v_reserved FROM inventory_units
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool AND state = 'RESERVED';

  SELECT * INTO v_prev FROM inventory_adjustments
   WHERE idempotency_key = p_idempotency_key AND sku_id = p_sku AND pool_id = p_pool;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'applied', 'replayed', true, 'on_hand', l.on_hand,
      'committed', l.committed, 'reserved', v_reserved,
      'available', greatest(0, l.on_hand - l.committed - v_reserved),
      'sync_version', l.sync_version, 'updated_at', l.updated_at, 'oversold_units', 0);
  END IF;

  IF p_source_version IS NOT NULL AND l.source_version IS NOT NULL AND p_source_version <= l.source_version THEN
    RETURN jsonb_build_object('status', 'stale', 'current_source_version', l.source_version);
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version <> l.sync_version THEN
    IF v_created IS NOT NULL THEN
      DELETE FROM inventory_levels WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool;
    END IF;
    RETURN jsonb_build_object('status', 'version_conflict', 'current_version', l.sync_version);
  END IF;

  v_new := CASE p_mode WHEN 'set' THEN greatest(0, p_quantity::bigint - v_fawry_on) ELSE l.on_hand::bigint + p_quantity END;
  IF v_new < 0 OR v_new > 2147483647 THEN
    IF v_created IS NOT NULL THEN
      DELETE FROM inventory_levels WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool;
    END IF;
    RETURN jsonb_build_object('status', 'negative', 'would_be', v_new);
  END IF;

  IF v_new < l.on_hand THEN
    v_oversold := greatest(0, l.committed + v_reserved - v_new::integer);
  END IF;

  UPDATE inventory_levels
     SET on_hand = v_new::integer, sync_version = l.sync_version + 1,
         source_version = coalesce(p_source_version, l.source_version), updated_at = p_now
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_pool
   RETURNING * INTO l;

  INSERT INTO inventory_adjustments (occurred_at, sku_id, location_id, pool_id, store_id, delta,
                                     resulting_on_hand, reason, reason_detail, idempotency_key,
                                     sync_version, source_version, actor_type, actor_id)
  VALUES (p_now, p_sku, p_loc, p_pool, p_store, l.on_hand - v_old,
          l.on_hand, 'SELLER_SYNC', p_reason, p_idempotency_key, l.sync_version, p_source_version,
          p_actor_type, p_actor_id);

  IF v_oversold > 0 THEN
    INSERT INTO inventory_oversell_events (occurred_at, sku_id, location_id, pool_id, store_id,
                                           shortfall_units, sync_version, reason_detail)
    VALUES (p_now, p_sku, p_loc, p_pool, p_store, v_oversold, l.sync_version, p_reason);
    PERFORM inventory_emit('inventory.oversold', 'sku', p_sku,
      jsonb_build_object('sku_id', p_sku, 'shortfall_units', v_oversold), '{}'::jsonb, p_now);
  END IF;

  PERFORM inventory_rebalance_core(p_sku, p_loc, p_pool);

  RETURN jsonb_build_object('status', 'applied', 'replayed', false, 'on_hand', l.on_hand,
    'committed', l.committed, 'reserved', v_reserved,
    'available', greatest(0, l.on_hand - l.committed - v_reserved),
    'sync_version', l.sync_version, 'updated_at', l.updated_at, 'oversold_units', v_oversold);
END
$$;

-- ---------------------------------------------------------------------------------------
-- pool transfer (Fawry allocation, ADR-0011 pool size limit)
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION inventory_pool_transfer(
  p_sku uuid, p_loc uuid, p_from_pool uuid, p_to_pool uuid, p_store uuid,
  p_qty integer, p_idempotency_key text, p_now timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_from     inventory_levels%ROWTYPE;
  v_reserved integer;
  v_free     integer;
  v_pool     uuid;
BEGIN
  IF p_qty < 1 OR p_from_pool = p_to_pool THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- advisory locks and level locks in sorted pool order
  FOR v_pool IN SELECT unnest(ARRAY[p_from_pool, p_to_pool]) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(inventory_advisory_key(p_sku, p_loc, v_pool));
  END LOOP;
  INSERT INTO inventory_levels (sku_id, location_id, pool_id, store_id, updated_at)
  VALUES (p_sku, p_loc, p_to_pool, p_store, p_now)
  ON CONFLICT (sku_id, location_id, pool_id) DO NOTHING;
  PERFORM 1 FROM inventory_levels
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id IN (p_from_pool, p_to_pool)
   ORDER BY pool_id FOR NO KEY UPDATE;

  IF EXISTS (SELECT 1 FROM inventory_adjustments
              WHERE idempotency_key = p_idempotency_key AND sku_id = p_sku AND pool_id = p_to_pool) THEN
    RETURN jsonb_build_object('status', 'transferred', 'replayed', true);
  END IF;

  SELECT * INTO v_from FROM inventory_levels
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_from_pool;
  IF NOT FOUND OR v_from.store_id <> p_store THEN
    RETURN jsonb_build_object('status', 'insufficient', 'free', 0);
  END IF;
  SELECT count(*) INTO v_reserved FROM inventory_units
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_from_pool AND state = 'RESERVED';
  v_free := v_from.on_hand - v_from.committed - v_reserved;
  IF v_free < p_qty THEN
    RETURN jsonb_build_object('status', 'insufficient', 'free', greatest(0, v_free));
  END IF;

  UPDATE inventory_levels SET on_hand = on_hand - p_qty, updated_at = p_now
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_from_pool;
  UPDATE inventory_levels SET on_hand = on_hand + p_qty, updated_at = p_now
   WHERE sku_id = p_sku AND location_id = p_loc AND pool_id = p_to_pool;

  INSERT INTO inventory_adjustments (occurred_at, sku_id, location_id, pool_id, store_id, delta, resulting_on_hand,
                                     reason, idempotency_key, sync_version, actor_type, actor_id)
  SELECT p_now, p_sku, p_loc, l.pool_id, p_store,
         CASE WHEN l.pool_id = p_from_pool THEN -p_qty ELSE p_qty END, l.on_hand,
         'POOL_TRANSFER', p_idempotency_key, l.sync_version, 'system', 'pool_transfer'
    FROM inventory_levels l
   WHERE l.sku_id = p_sku AND l.location_id = p_loc AND l.pool_id IN (p_from_pool, p_to_pool);

  FOR v_pool IN SELECT unnest(ARRAY[p_from_pool, p_to_pool]) ORDER BY 1 LOOP
    PERFORM inventory_rebalance_core(p_sku, p_loc, v_pool);
  END LOOP;
  RETURN jsonb_build_object('status', 'transferred', 'replayed', false);
END
$$;

-- ---------------------------------------------------------------------------------------
-- RLS and grants (packages/policy/RLS.md: class B store tenant, class A owner)
-- ---------------------------------------------------------------------------------------

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON locations TO app_user;
CREATE POLICY locations_select ON locations FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY locations_insert ON locations FOR INSERT
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'));
CREATE POLICY locations_update ON locations FOR UPDATE
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'))
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'system'));

ALTER TABLE stock_pools ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON stock_pools TO app_user;
CREATE POLICY stock_pools_select ON stock_pools FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY stock_pools_insert ON stock_pools FOR INSERT WITH CHECK (app_role() IN ('ops', 'system'));

ALTER TABLE reservation_ttl_policies ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON reservation_ttl_policies TO app_user;
CREATE POLICY reservation_ttl_policies_select ON reservation_ttl_policies FOR SELECT USING (app_role() IS NOT NULL);
CREATE POLICY reservation_ttl_policies_insert ON reservation_ttl_policies FOR INSERT
  WITH CHECK (app_role() IN ('ops', 'super_admin', 'system'));

ALTER TABLE inventory_levels ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON inventory_levels TO app_user;
CREATE POLICY inventory_levels_select ON inventory_levels FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY inventory_levels_insert ON inventory_levels FOR INSERT
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
CREATE POLICY inventory_levels_update ON inventory_levels FOR UPDATE
  USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system')
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');

ALTER TABLE inventory_units ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_units TO app_user;
-- units are internal bookkeeping: sellers may count them, only system mutates them
CREATE POLICY inventory_units_select ON inventory_units FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'super_admin', 'system'));
CREATE POLICY inventory_units_insert ON inventory_units FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY inventory_units_update ON inventory_units FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
CREATE POLICY inventory_units_delete ON inventory_units FOR DELETE USING (app_role() = 'system');

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON reservations TO app_user;
CREATE POLICY reservations_select ON reservations FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('ops', 'support', 'super_admin', 'system'));
CREATE POLICY reservations_insert ON reservations FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY reservations_update ON reservations FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE reservation_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON reservation_lines TO app_user;
-- seller staff see only lines of their own store (counts of what is held), never the buyer id
CREATE POLICY reservation_lines_select ON reservation_lines FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'support', 'super_admin', 'system')
         OR EXISTS (SELECT 1 FROM reservations r WHERE r.id = reservation_lines.reservation_id
                      AND r.user_id = app_user_id()));
CREATE POLICY reservation_lines_insert ON reservation_lines FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE inventory_adjustments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON inventory_adjustments TO app_user;
CREATE POLICY inventory_adjustments_select ON inventory_adjustments FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'finance', 'super_admin', 'system'));
CREATE POLICY inventory_adjustments_insert ON inventory_adjustments FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE inventory_oversell_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON inventory_oversell_events TO app_user;
CREATE POLICY inventory_oversell_events_select ON inventory_oversell_events FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('ops', 'trust_safety', 'super_admin', 'system'));
CREATE POLICY inventory_oversell_events_insert ON inventory_oversell_events FOR INSERT
  WITH CHECK (app_role() = 'system');

-- Functions: callable by the application role only (never PUBLIC).
REVOKE ALL ON FUNCTION
  inventory_advisory_key(uuid, uuid, uuid),
  inventory_emit(text, text, uuid, jsonb, jsonb, timestamptz),
  inventory_rebalance_core(uuid, uuid, uuid),
  inventory_rebalance_pool(uuid, uuid, uuid),
  inventory_reserve(uuid, uuid, uuid, jsonb, integer, uuid, text, text, timestamptz),
  inventory_claim(uuid, timestamptz),
  inventory_release_reservation(uuid, text, text, timestamptz),
  inventory_release(uuid, text, timestamptz),
  inventory_sweep_expired(timestamptz, integer),
  inventory_replenish_due(integer),
  inventory_apply_stock_sync(uuid, uuid, uuid, uuid, text, integer, text, text, bigint, bigint, text, text, timestamptz),
  inventory_pool_transfer(uuid, uuid, uuid, uuid, uuid, integer, text, timestamptz)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  inventory_advisory_key(uuid, uuid, uuid),
  inventory_emit(text, text, uuid, jsonb, jsonb, timestamptz),
  inventory_rebalance_core(uuid, uuid, uuid),
  inventory_rebalance_pool(uuid, uuid, uuid),
  inventory_reserve(uuid, uuid, uuid, jsonb, integer, uuid, text, text, timestamptz),
  inventory_claim(uuid, timestamptz),
  inventory_release_reservation(uuid, text, text, timestamptz),
  inventory_release(uuid, text, timestamptz),
  inventory_sweep_expired(timestamptz, integer),
  inventory_replenish_due(integer),
  inventory_apply_stock_sync(uuid, uuid, uuid, uuid, text, integer, text, text, bigint, bigint, text, text, timestamptz),
  inventory_pool_transfer(uuid, uuid, uuid, uuid, uuid, integer, text, timestamptz)
  TO app_user;
