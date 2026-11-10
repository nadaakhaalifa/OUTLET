-- migration: 0031_checkout_settle_job
-- phase: expand (one policy, no table change)
-- Source: chief review waves 9-10, finding 4 (PromotionsSettleConsumer). ADR-0011.
-- New worker job `checkout.settle` (WORKER_JOBS): the inbox consumer of `promotions.settle_requested`. It needs only what 0007 already grants
-- every worker on inbox_processed (SELECT, INSERT; no RLS) plus an INSERT-only outbox exception so a malformed payload can be parked as
-- `promotions.settle_attention` in the same transaction as its inbox row. The voucher confirm itself does NOT run as outlet_worker:
-- VoucherService runs on outlet_app in the shopper's user context (promotion_usage_* functions require ctx 'user'), so no promotions grant
-- is added for outlet_worker here (finding 11: verified, intentionally none).
CREATE POLICY outbox_events__worker_checkout_settle ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'checkout.settle' AND market_id = app.current_market_id());
