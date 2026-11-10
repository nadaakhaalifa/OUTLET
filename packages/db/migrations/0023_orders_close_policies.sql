-- 0023: read access for the orders.close worker job (packages/checkout OrderCloseJob) to the returns tables created in 0019.
-- Kept separate from 0016 because return_requests, disputes and refunds do not exist at that point. SELECT only, job-pinned, market-pinned.
-- The seller_orders and outbox policies of the same job are in 0016.
CREATE POLICY return_requests__worker_orders_close ON return_requests FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'orders.close' AND market_id = app.current_market_id());
CREATE POLICY disputes__worker_orders_close ON disputes FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'orders.close' AND market_id = app.current_market_id());
CREATE POLICY refunds__worker_orders_close ON refunds FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'orders.close' AND market_id = app.current_market_id());
