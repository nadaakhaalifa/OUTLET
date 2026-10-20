-- migration: 0094_returns_seller_order_idx
-- phase: expand
--
-- Supports the internal read of non-terminal returns per order line of a seller order
-- (orders closeDelivered -> LineReturnsPort). Index only: no columns, no data change, no PII.
-- Rollback: DROP INDEX returns_seller_order_idx.

CREATE INDEX IF NOT EXISTS returns_seller_order_idx ON returns (seller_order_id, order_line_id);
