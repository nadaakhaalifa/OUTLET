-- Transactional copy for `order_group.cancelled` (template code order_cancelled), EG v1, Arabic first.
-- No refund amount or urgency is stated: the refund route and timing are shown on the order page.
-- UUID prefix ...-7001- keeps ids disjoint from the 0021 seed (...-8000-...).
CREATE TEMP TABLE seed_copy (code text, locale text, title text, body text) ON COMMIT DROP;
INSERT INTO seed_copy (code, locale, title, body) VALUES
  ('order_cancelled', 'ar-EG', 'اتلغى طلبك',        'طلبك اتلغى. لو كنت دفعت، هنرجّعلك المبلغ وتقدر تتابع حالة الرد من صفحة الطلب.'),
  ('order_cancelled', 'en-EG', 'Your order was cancelled', 'Your order has been cancelled. If you had paid, we will refund you and you can follow the refund from the order page.');

INSERT INTO notification_templates (id, market_id, code, channel, locale, version, category, title, body, provider_template_name, approval_status)
SELECT ('01900000-0000-7001-8000-' || lpad(to_hex(row_number() OVER (ORDER BY s.code, s.locale, c.channel)), 12, '0'))::uuid,
       'EG', s.code, c.channel, s.locale, 1, 'transactional',
       CASE WHEN c.channel IN ('push', 'email', 'in_app') THEN s.title END,
       s.body,
       CASE WHEN c.channel = 'whatsapp' THEN 'outlex_' || s.code || '_' || left(s.locale, 2) END,
       CASE WHEN c.channel = 'whatsapp' THEN 'pending' ELSE 'approved' END
  FROM seed_copy s CROSS JOIN (VALUES ('push'), ('in_app'), ('sms'), ('email'), ('whatsapp')) AS c (channel);
