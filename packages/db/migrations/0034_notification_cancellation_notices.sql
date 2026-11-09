-- migration: 0034_notification_cancellation_notices
-- phase: expand (new rows, two read-only worker policies, column grant widened by two public store names)
-- Transactional copy for two events, EG v1, Arabic first, same pattern as 0030:
--   * seller_order_cancelled_by_shopper  -> store members (owner, manager, warehouse), event `seller_order.cancelled` with initiator shopper|system.
--   * order_item_cancelled_by_seller     -> the shopper, event `seller_order.rejected` (a seller rejection emits no order_group.cancelled).
-- No amounts, no cancellation reason (the shopper's reason stays with the shopper), no urgency, no ETA promise beyond "within the legal deadline".
-- WhatsApp rows are 'pending' (not approved by the BSP): the dispatcher fails over to the next channel until approval.
--
-- Worker access (ADR-0011, reviewed diff of rls-exceptions.json): the dispatcher resolves store members and the store's PUBLIC display name
-- under job `notifications.dispatch`. Both policies are SELECT-only and market-pinned; store_members is limited to ACTIVE rows with a user.
-- UUID prefix ...-7002- keeps ids disjoint from 0021 (...-8000-) and 0030 (...-7001-).
CREATE TEMP TABLE seed_copy (code text, locale text, title text, body text, channels text[]) ON COMMIT DROP;
INSERT INTO seed_copy (code, locale, title, body, channels) VALUES
  ('seller_order_cancelled_by_shopper', 'ar-EG', 'العميل لغى الطلب',
   'العميل لغى الطلب رقم {order_ref}. مفيش حاجة مطلوبة منك، وهتلاقي التفاصيل في صفحة الطلب في مركز البائع.', ARRAY['push', 'in_app', 'email', 'whatsapp']),
  ('seller_order_cancelled_by_shopper', 'en-EG', 'The shopper cancelled an order',
   'The shopper cancelled order {order_ref}. No action is needed from you; the details are on the order page in Seller Center.', ARRAY['push', 'in_app', 'email', 'whatsapp']),
  ('order_item_cancelled_by_seller', 'ar-EG', 'اتلغت حاجات من طلبك',
   '{store_name} مقدرش يجهّز المنتجات اللي منه في طلبك واتلغت. لو كنت دفعت، هنرجّعلك مبلغها في المعاد القانوني، وتقدر تتابع الرد من صفحة الطلب.', ARRAY['push', 'in_app', 'sms', 'email', 'whatsapp']),
  ('order_item_cancelled_by_seller', 'en-EG', 'Some items in your order were cancelled',
   '{store_name} could not prepare its items in your order, so they were cancelled. If you had paid, we will refund them within the legal deadline and you can follow the refund from the order page.', ARRAY['push', 'in_app', 'sms', 'email', 'whatsapp']);

INSERT INTO notification_templates (id, market_id, code, channel, locale, version, category, title, body, provider_template_name, approval_status)
SELECT ('01900000-0000-7002-8000-' || lpad(to_hex(row_number() OVER (ORDER BY s.code, s.locale, c.channel)), 12, '0'))::uuid,
       'EG', s.code, c.channel, s.locale, 1, 'transactional',
       CASE WHEN c.channel IN ('push', 'email', 'in_app') THEN s.title END,
       s.body,
       CASE WHEN c.channel = 'whatsapp' THEN 'outlex_' || s.code || '_' || left(s.locale, 2) END,
       CASE WHEN c.channel = 'whatsapp' THEN 'pending' ELSE 'approved' END
  FROM seed_copy s CROSS JOIN LATERAL unnest(s.channels) AS c (channel);

CREATE POLICY store_members__worker_notifications_dispatch ON store_members FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'notifications.dispatch' AND market_id = app.current_market_id() AND status = 'active' AND user_id IS NOT NULL);

CREATE POLICY stores__worker_notifications_dispatch ON stores FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'notifications.dispatch' AND market_id = app.current_market_id());
GRANT SELECT (display_name_ar, display_name_en) ON stores TO outlet_worker;
