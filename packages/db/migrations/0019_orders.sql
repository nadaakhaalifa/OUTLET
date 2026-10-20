-- migration: 0019_orders
-- phase: expand
--
-- Seller order lifecycle (spec 7, 19, 20.1; docs/specs/orders.md, docs/data-model/orders.md).
-- order_groups, seller_orders, order_lines, order_buyer_contacts, order_status_history.
--
-- Deliberate scope and deviations (see docs/specs/orders.md, Data):
--   * store_id, sku_id, product_id are LOGICAL references (no FK): stores and catalog are separate
--     modules whose rows the orders tests do not seed; an expand migration adds the FKs.
--   * Tenant key is the existing app.store_ids session variable (app_store_ids(), migration 0002),
--     a list, because one staff member can serve several stores.
--   * order_buyer_contacts is the SELLER-SAFE projection only (first name, relay number, governorate).
--     The raw phone and address (P3, encrypted delivery_snapshots) stay with checkout/fulfilment.
--   * Cancellation facts live on seller_orders (cancel_initiator, cancel_reason).
--   * order_status_history is not partitioned yet (same deferral as the outbox, 0004).
--   * Money is BIGINT piastres, EGP only. No ledger, payment or payout object is created here.

CREATE TABLE order_groups (
  id                   uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users (id),
  status               text NOT NULL CHECK (status IN
                         ('CREATED','RESERVED','PAYMENT_PENDING','PAID','CONFIRMED_COD','FULFILLING',
                          'COMPLETED','EXPIRED','FAILED','CANCELLED')),
  payment_method       text NOT NULL CHECK (payment_method IN
                         ('card','apple_pay','meeza','mobile_wallet','instapay','fawry','bnpl','cod')),
  payment_type         text NOT NULL CHECK (payment_type IN ('prepaid','cod')),
  currency             char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  subtotal_amount      bigint NOT NULL CHECK (subtotal_amount >= 0),
  shipping_amount      bigint NOT NULL CHECK (shipping_amount >= 0),
  discount_amount      bigint NOT NULL CHECK (discount_amount >= 0),
  vat_amount           bigint NOT NULL CHECK (vat_amount >= 0),
  store_credit_amount  bigint NOT NULL DEFAULT 0 CHECK (store_credit_amount >= 0),
  total_amount         bigint NOT NULL CHECK (total_amount >= 0),
  idempotency_key      text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  version              integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  placed_at            timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_groups_user_idx ON order_groups (user_id, placed_at DESC, id);

CREATE TRIGGER order_groups_touch_updated_at_trg
  BEFORE UPDATE ON order_groups FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE seller_orders (
  id                          uuid PRIMARY KEY,
  order_group_id              uuid NOT NULL REFERENCES order_groups (id),
  store_id                    uuid NOT NULL,
  user_id                     uuid NOT NULL REFERENCES users (id),   -- denormalised owner for RLS
  status                      text NOT NULL CHECK (status IN
                                ('PENDING_PAYMENT','PAID','CONFIRMED_COD','ACCEPTED','PACKED','SHIPPED',
                                 'OUT_FOR_DELIVERY','DELIVERED','CLOSED','RETURN_REQUESTED',
                                 'RETURN_PICKUP_SCHEDULED','RETURN_IN_TRANSIT','RETURN_RECEIVED',
                                 'RETURN_INSPECTED','REFUNDED','RETURN_REJECTED','CANCELLED',
                                 'REJECTED_BY_SELLER','DELIVERY_FAILED','RTO','RETURNED_TO_SELLER','DISPUTED')),
  version                     integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  payment_type                text NOT NULL CHECK (payment_type IN ('prepaid','cod')),
  currency                    char(3) NOT NULL DEFAULT 'EGP' CHECK (currency = 'EGP'),
  subtotal_amount             bigint NOT NULL CHECK (subtotal_amount >= 0),
  shipping_amount             bigint NOT NULL CHECK (shipping_amount >= 0),
  discount_amount             bigint NOT NULL CHECK (discount_amount >= 0),
  vat_amount                  bigint NOT NULL CHECK (vat_amount >= 0),
  total_amount                bigint NOT NULL CHECK (total_amount >= 0),
  commission_rate_snapshot_bps integer NOT NULL CHECK (commission_rate_snapshot_bps BETWEEN 0 AND 10000),
  paid_at                     timestamptz,
  accept_by                   timestamptz,
  dispatch_by                 timestamptz,
  accepted_at                 timestamptz,
  packed_at                   timestamptz,
  shipped_at                  timestamptz,
  delivered_at                timestamptz,
  closed_at                   timestamptz,
  cancelled_at                timestamptz,
  cancel_initiator            text CHECK (cancel_initiator IS NULL OR cancel_initiator IN
                                ('SHOPPER','SYSTEM_TIMEOUT','ADMIN','RISK')),
  cancel_reason               text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 64),
  reject_reason               text CHECK (reject_reason IS NULL OR reject_reason IN
                                ('out_of_stock','pricing_error','cannot_fulfil','other')),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seller_orders_store_idx ON seller_orders (store_id, status, created_at DESC, id);
CREATE INDEX seller_orders_group_idx ON seller_orders (order_group_id);
CREATE INDEX seller_orders_user_idx ON seller_orders (user_id);
CREATE INDEX seller_orders_accept_sla_idx ON seller_orders (accept_by)
  WHERE status IN ('PAID', 'CONFIRMED_COD');

CREATE TRIGGER seller_orders_touch_updated_at_trg
  BEFORE UPDATE ON seller_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Defence in depth behind the domain machine: terminal states are never left, versions never go back.
CREATE FUNCTION seller_orders_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('CLOSED', 'REFUNDED', 'CANCELLED', 'REJECTED_BY_SELLER') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'seller order % is in terminal state %', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'seller order version must not decrease' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.store_id <> OLD.store_id OR NEW.user_id <> OLD.user_id OR NEW.order_group_id <> OLD.order_group_id THEN
    RAISE EXCEPTION 'seller order ownership is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER seller_orders_guard_trg
  BEFORE UPDATE ON seller_orders FOR EACH ROW EXECUTE FUNCTION seller_orders_guard();

CREATE TABLE order_lines (
  id                  uuid PRIMARY KEY,
  seller_order_id     uuid NOT NULL REFERENCES seller_orders (id),
  store_id            uuid NOT NULL,           -- denormalised for RLS
  sku_id              uuid NOT NULL,
  product_id          uuid NOT NULL,
  qty                 integer NOT NULL CHECK (qty >= 1),
  unit_price_amount   bigint NOT NULL CHECK (unit_price_amount >= 0),
  discount_amount     bigint NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  vat_amount          bigint NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  title_ar            text NOT NULL CHECK (length(title_ar) BETWEEN 1 AND 300),
  title_en            text CHECK (title_en IS NULL OR length(title_en) <= 300),
  size_label          text CHECK (size_label IS NULL OR length(size_label) <= 40),
  position            integer NOT NULL DEFAULT 0
);
CREATE INDEX order_lines_order_idx ON order_lines (seller_order_id, position);
CREATE INDEX order_lines_store_idx ON order_lines (store_id);

CREATE TABLE order_buyer_contacts (
  seller_order_id  uuid PRIMARY KEY REFERENCES seller_orders (id),
  store_id         uuid NOT NULL,
  first_name       text CHECK (first_name IS NULL OR length(first_name) <= 80),
  phone_relay      text CHECK (phone_relay IS NULL OR length(phone_relay) <= 20),
  governorate_code text NOT NULL CHECK (length(governorate_code) BETWEEN 1 AND 16)
);

CREATE TABLE order_status_history (
  id               uuid PRIMARY KEY,
  seller_order_id  uuid NOT NULL REFERENCES seller_orders (id),
  store_id         uuid NOT NULL,
  from_status      text NOT NULL,
  to_status        text NOT NULL,
  event            text NOT NULL CHECK (length(event) BETWEEN 1 AND 64),
  actor_type       text NOT NULL CHECK (actor_type IN ('SHOPPER','SELLER','SYSTEM','COURIER','ADMIN')),
  actor_id         uuid,
  reason_code      text CHECK (reason_code IS NULL OR length(reason_code) <= 64),
  command_key      text NOT NULL CHECK (length(command_key) BETWEEN 1 AND 128),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_order_id, command_key)
);
CREATE INDEX order_status_history_order_idx ON order_status_history (seller_order_id, occurred_at);

CREATE TRIGGER order_status_history_immutable_trg
  BEFORE UPDATE OR DELETE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------
-- RLS. order_groups: class A (owner). seller_orders and children: class B2 (tenant by store
-- via app.store_ids) plus the owning shopper (read). Writes by store staff or the system role.
-- Intake (INSERT) is system only; the checkout saga runs as `system`.
-- ---------------------------------------------------------------------------------------
ALTER TABLE order_groups ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON order_groups TO app_user;
CREATE POLICY order_groups_select ON order_groups FOR SELECT
  USING (user_id = app_user_id()
    OR app_role() IN ('system', 'ops', 'support', 'super_admin')
    OR EXISTS (SELECT 1 FROM seller_orders o
                WHERE o.order_group_id = order_groups.id AND o.store_id::text = ANY (app_store_ids())));
CREATE POLICY order_groups_insert ON order_groups FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY order_groups_update ON order_groups FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');

ALTER TABLE seller_orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON seller_orders TO app_user;
CREATE POLICY seller_orders_select ON seller_orders FOR SELECT
  USING (store_id::text = ANY (app_store_ids())
    OR user_id = app_user_id()
    OR app_role() IN ('system', 'ops', 'support', 'super_admin'));
CREATE POLICY seller_orders_insert ON seller_orders FOR INSERT WITH CHECK (app_role() = 'system');
CREATE POLICY seller_orders_update ON seller_orders FOR UPDATE
  USING (store_id::text = ANY (app_store_ids()) OR user_id = app_user_id() OR app_role() = 'system')
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR user_id = app_user_id() OR app_role() = 'system');

ALTER TABLE order_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_lines TO app_user;
CREATE POLICY order_lines_select ON order_lines FOR SELECT
  USING (store_id::text = ANY (app_store_ids())
    OR app_role() IN ('system', 'ops', 'support', 'super_admin')
    OR EXISTS (SELECT 1 FROM seller_orders o WHERE o.id = order_lines.seller_order_id AND o.user_id = app_user_id()));
CREATE POLICY order_lines_insert ON order_lines FOR INSERT WITH CHECK (app_role() = 'system');

-- Buyer contact projection: tenant staff and system only. The shopper already knows their own data
-- and has no read need here; support reads through the audited admin path.
ALTER TABLE order_buyer_contacts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_buyer_contacts TO app_user;
CREATE POLICY order_buyer_contacts_select ON order_buyer_contacts FOR SELECT
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('system', 'super_admin'));
CREATE POLICY order_buyer_contacts_insert ON order_buyer_contacts FOR INSERT WITH CHECK (app_role() = 'system');

ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON order_status_history TO app_user;
CREATE POLICY order_status_history_select ON order_status_history FOR SELECT
  USING (store_id::text = ANY (app_store_ids())
    OR app_role() IN ('system', 'ops', 'support', 'super_admin')
    OR EXISTS (SELECT 1 FROM seller_orders o WHERE o.id = order_status_history.seller_order_id AND o.user_id = app_user_id()));
CREATE POLICY order_status_history_insert ON order_status_history FOR INSERT
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() = 'system');
