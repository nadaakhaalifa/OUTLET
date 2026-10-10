-- migration: 0020_returns
-- phase: expand
--
-- Returns, exchange-first, inspection, disputes and the serial-returner standing
-- (spec 22, B5, docs/specs/returns.md, docs/data-model/returns.md).
--
-- This module moves NO money. `refund_intent` is the allocation that becomes the
-- `return.refund_intent` event; the RefundRouter and ledger execute it later.
--
-- order_line_id, seller_order_id, store_id and upload ids are LOGICAL references: the
-- order, store and media tables belong to other modules, so no FK is declared here
-- (an expand migration adds them when those modules are final). user_id is a real FK.
-- Money is BIGINT piastres (inside refund_intent as decimal strings). Depends on 0001-0011.
--
-- RLS: class A (owner) for the shopper, store scope (app.store_ids) for the seller side,
-- and the `system` role for the module's adapter, same pattern as 0015_cart.

CREATE TABLE returns (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES users (id),
  order_line_id               uuid NOT NULL,
  seller_order_id             uuid NOT NULL,
  store_id                    uuid NOT NULL,
  qty                         integer NOT NULL CHECK (qty BETWEEN 1 AND 1000),
  reason                      text NOT NULL CHECK (reason IN
                                ('too_small', 'too_large', 'not_as_described', 'defective', 'changed_mind', 'late', 'wrong_item')),
  resolution                  text NOT NULL CHECK (resolution IN ('exchange', 'refund')),
  exchange_sku_id             uuid,
  refund_preference           text NOT NULL DEFAULT 'original_method'
                                CHECK (refund_preference IN ('original_method', 'store_credit')),
  method                      text NOT NULL CHECK (method IN ('pickup', 'drop_off')),
  state                       text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN
                                ('REQUESTED', 'PICKUP_SCHEDULED', 'IN_TRANSIT', 'RECEIVED', 'APPROVED', 'REJECTED',
                                 'DISPUTED', 'REFUNDED', 'EXCHANGED', 'CLOSED', 'CANCELLED')),
  shipping_payer              text NOT NULL CHECK (shipping_payer IN ('shopper', 'seller', 'platform_free')),
  delivered_at                timestamptz NOT NULL,
  window_ends_at              timestamptz NOT NULL,
  note                        text CHECK (note IS NULL OR char_length(note) <= 500),
  received_at                 timestamptz,
  inspection_due_at           timestamptz,
  inspected_at                timestamptz,
  inspection_note             text CHECK (inspection_note IS NULL OR char_length(inspection_note) <= 500),
  inspection_result           text CHECK (inspection_result IS NULL OR inspection_result IN ('approved', 'auto_approved', 'rejected')),
  rejection_reason            text CHECK (rejection_reason IS NULL OR rejection_reason IN
                                ('used', 'missing_tags', 'damaged_by_customer', 'wrong_item_returned', 'other')),
  dispute_window_ends_at      timestamptz,
  refund_intent               jsonb,
  intent_published_at         timestamptz,
  prior_qty                   integer NOT NULL DEFAULT 0 CHECK (prior_qty >= 0),
  delivery_fee_refundable     boolean NOT NULL DEFAULT false,
  line_snapshot               jsonb NOT NULL,
  idempotency_key             text NOT NULL,
  version                     integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT returns_exchange_sku_chk CHECK (resolution <> 'exchange' OR exchange_sku_id IS NOT NULL),
  CONSTRAINT returns_user_idem_uq UNIQUE (user_id, idempotency_key)
);

CREATE INDEX returns_user_idx ON returns (user_id, created_at DESC, id);
CREATE INDEX returns_store_idx ON returns (store_id, created_at DESC, id);
CREATE INDEX returns_line_idx ON returns (order_line_id);
CREATE INDEX returns_inspection_due_idx ON returns (inspection_due_at) WHERE state = 'RECEIVED';
CREATE INDEX returns_dispute_window_idx ON returns (dispute_window_ends_at) WHERE state = 'REJECTED';
CREATE INDEX returns_unpublished_intent_idx ON returns (id) WHERE state = 'APPROVED' AND intent_published_at IS NULL;

CREATE TRIGGER returns_touch_updated_at_trg
  BEFORE UPDATE ON returns FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE return_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id         uuid NOT NULL REFERENCES returns (id) ON DELETE CASCADE,
  upload_id         uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('shopper_photo', 'inspection_photo', 'dispute_photo')),
  uploaded_by_type  text NOT NULL CHECK (uploaded_by_type IN ('shopper', 'seller', 'hub', 'trust_safety')),
  uploaded_by_id    uuid NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (return_id, upload_id)
);

CREATE TABLE return_disputes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id      uuid NOT NULL UNIQUE REFERENCES returns (id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN
                   ('OPEN', 'UNDER_REVIEW', 'RESOLVED_FOR_SHOPPER', 'RESOLVED_FOR_SELLER')),
  statement      text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 1000),
  review_due_at  timestamptz NOT NULL,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE returner_standing (
  user_id               uuid PRIMARY KEY REFERENCES users (id),
  delivered_orders_6m   integer NOT NULL CHECK (delivered_orders_6m >= 0),
  returned_orders_6m    integer NOT NULL CHECK (returned_orders_6m >= 0),
  rate_bps              integer NOT NULL CHECK (rate_bps >= 0),
  free_returns_removed  boolean NOT NULL DEFAULT false,
  notice_sent_at        timestamptz,
  evaluated_at          timestamptz NOT NULL DEFAULT now()
);

-- RLS --------------------------------------------------------------------------------
ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON returns TO app_user;
CREATE POLICY returns_select ON returns FOR SELECT
  USING (user_id = app_user_id() OR store_id::text = ANY (app_store_ids()) OR app_role() IN ('trust_safety', 'support', 'system'));
CREATE POLICY returns_insert ON returns FOR INSERT
  WITH CHECK (user_id = app_user_id() OR app_role() = 'system');
CREATE POLICY returns_update ON returns FOR UPDATE
  USING (store_id::text = ANY (app_store_ids()) OR app_role() IN ('trust_safety', 'system'))
  WITH CHECK (store_id::text = ANY (app_store_ids()) OR app_role() IN ('trust_safety', 'system'));

ALTER TABLE return_evidence ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON return_evidence TO app_user;
CREATE POLICY return_evidence_select ON return_evidence FOR SELECT
  USING (app_role() IN ('trust_safety', 'support', 'system')
    OR EXISTS (SELECT 1 FROM returns r WHERE r.id = return_evidence.return_id
                 AND (r.user_id = app_user_id() OR r.store_id::text = ANY (app_store_ids()))));
CREATE POLICY return_evidence_insert ON return_evidence FOR INSERT
  WITH CHECK (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM returns r WHERE r.id = return_evidence.return_id
                 AND (r.user_id = app_user_id() OR r.store_id::text = ANY (app_store_ids()))));

ALTER TABLE return_disputes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON return_disputes TO app_user;
CREATE POLICY return_disputes_select ON return_disputes FOR SELECT
  USING (app_role() IN ('trust_safety', 'support', 'system')
    OR EXISTS (SELECT 1 FROM returns r WHERE r.id = return_disputes.return_id
                 AND (r.user_id = app_user_id() OR r.store_id::text = ANY (app_store_ids()))));
CREATE POLICY return_disputes_insert ON return_disputes FOR INSERT
  WITH CHECK (app_role() = 'system'
    OR EXISTS (SELECT 1 FROM returns r WHERE r.id = return_disputes.return_id AND r.user_id = app_user_id()));
CREATE POLICY return_disputes_update ON return_disputes FOR UPDATE
  USING (app_role() IN ('trust_safety', 'system'))
  WITH CHECK (app_role() IN ('trust_safety', 'system'));

ALTER TABLE returner_standing ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON returner_standing TO app_user;
CREATE POLICY returner_standing_select ON returner_standing FOR SELECT
  USING (user_id = app_user_id() OR app_role() IN ('trust_safety', 'support', 'system'));
CREATE POLICY returner_standing_insert ON returner_standing FOR INSERT
  WITH CHECK (app_role() = 'system');
CREATE POLICY returner_standing_update ON returner_standing FOR UPDATE
  USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
