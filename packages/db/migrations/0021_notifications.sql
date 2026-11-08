-- migration: 0021_notifications
-- phase: expand (new tables only)
-- Source: master prompt section 24 (notifications), B1 (consent per channel), docs/data-model.md 7.24, docs/analytics/events.md 4.11, ADR-0011.
--
-- Channels: push, in_app, whatsapp, sms, email. Marketing needs the matching consent purpose (enforced in the domain `decide`,
-- not here: consent_records stays the single source of truth); transactional does not. Frequency caps and quiet hours are domain rules.
--
-- Tenancy: notification_preferences and notification_log are user-owned (app.enable_user_rls, FORCE RLS on user_id). The dispatcher
-- runs as worker job `notifications.dispatch` and, like every other worker, NARROWS to one shopper before it reads or writes
-- anything user-owned. Exception policies (ADR-0011, named, market-pinned): scan of due queued log rows, and the outbox emit.
-- notification_templates is global configuration (no personal data, no tenant key; market_id only scopes the copy).
--
-- Deviations from data-model 7.24 (reported): notification_requests + notification_deliveries are one table, notification_log
-- (one row per user, event and channel slot; the delivery state machine is the status column); in_app_messages is not built here
-- (the in_app channel port owns that store). notification_log keeps NO message body and NO destination: only template code,
-- render variables (ids and formatted amounts, never P3) and provider result codes. Monthly partitioning is deferred (comment only):
-- partition RANGE (created_at) before the table passes ~5M rows (docs/data-model.md volume table).
-- Extra template columns: title (push title / email subject), active. Seeds: transactional copy for the EG market, ar-EG and en-EG.

CREATE TABLE notification_templates (
  id                      uuid PRIMARY KEY,
  market_id               text NOT NULL CHECK (length(market_id) > 0),
  code                    text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  channel                 text NOT NULL CHECK (channel IN ('push', 'in_app', 'whatsapp', 'sms', 'email')),
  locale                  text NOT NULL CHECK (locale IN ('ar-EG', 'en-EG')),
  version                 int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  category                text NOT NULL CHECK (category IN ('transactional', 'marketing')),
  title                   text,
  body                    text NOT NULL CHECK (length(body) > 0),     -- ICU message; no personal data in templates
  provider_template_name  text,                                        -- WhatsApp approved template id
  approval_status         text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('approved', 'pending', 'rejected')),
  active                  boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (market_id, code, channel, locale, version),
  CHECK (channel <> 'whatsapp' OR provider_template_name IS NOT NULL)
);

CREATE TABLE notification_preferences (
  user_id     uuid NOT NULL REFERENCES users (id),
  channel     text NOT NULL CHECK (channel IN ('push', 'in_app', 'whatsapp', 'sms', 'email')),
  category    text NOT NULL CHECK (category IN ('transactional', 'marketing')),
  market_id   text NOT NULL CHECK (length(market_id) > 0),
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel, category)
);
SELECT app.enable_user_rls('notification_preferences');

CREATE TABLE notification_log (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users (id),
  market_id           text NOT NULL CHECK (length(market_id) > 0),
  template_code       text NOT NULL,
  category            text NOT NULL CHECK (category IN ('transactional', 'marketing')),
  channel             text NOT NULL CHECK (channel IN ('push', 'in_app', 'whatsapp', 'sms', 'email')),
  fallback_channels   text[] NOT NULL DEFAULT '{}',                    -- remaining failover chain, already decided eligible
  event_id            uuid,                                            -- source outbox event (null for scheduled marketing)
  dedupe_key          text NOT NULL,                                   -- event_id:user_id:first channel; idempotency of the dispatcher
  vars                jsonb NOT NULL DEFAULT '{}'::jsonb,              -- render variables: ids and formatted amounts, never P3
  status              text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'suppressed')),
  suppression_reason  text CHECK (suppression_reason IN ('consent', 'quiet_hours', 'cap', 'killed', 'unsubscribed')),
  provider            text,
  provider_msg_id     text,
  error_code          text,
  attempts            int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  scheduled_for       timestamptz NOT NULL DEFAULT now(),              -- shifted out of quiet hours for marketing
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedupe_key),
  CHECK ((status = 'suppressed') = (suppression_reason IS NOT NULL))
);
CREATE INDEX notification_log_due_idx ON notification_log (market_id, scheduled_for) WHERE status = 'queued';
CREATE INDEX notification_log_user_idx ON notification_log (user_id, created_at DESC, id DESC);
CREATE INDEX notification_log_cap_idx ON notification_log (user_id, channel, sent_at DESC) WHERE status = 'sent' AND category = 'marketing';
SELECT app.enable_user_rls('notification_log');

-- Named worker exception policies (ADR-0011): scan the due queue, emit delivery events. Writes happen narrowed to one shopper.
CREATE POLICY notification_log__worker_notifications_dispatch ON notification_log FOR SELECT TO outlet_worker
  USING (app.ctx() = 'worker' AND app.job() = 'notifications.dispatch' AND market_id = app.current_market_id());
CREATE POLICY outbox_events__worker_notifications_dispatch ON outbox_events FOR INSERT TO outlet_worker
  WITH CHECK (app.ctx() = 'worker' AND app.job() = 'notifications.dispatch' AND market_id = app.current_market_id());

-- ---------------------------------------------------------------- grants
REVOKE ALL ON notification_templates, notification_preferences, notification_log FROM outlet_app, outlet_worker;
-- Shoppers: read the copy, manage their own preferences, read their own log. Never write the log or templates.
GRANT SELECT ON notification_templates TO outlet_app;
GRANT SELECT, INSERT ON notification_preferences TO outlet_app;
GRANT UPDATE (enabled, updated_at) ON notification_preferences TO outlet_app;
GRANT SELECT ON notification_log TO outlet_app;
-- Dispatcher worker.
GRANT SELECT ON notification_templates TO outlet_worker;
GRANT SELECT ON notification_preferences TO outlet_worker;
GRANT SELECT, INSERT ON notification_log TO outlet_worker;
GRANT UPDATE (channel, fallback_channels, status, suppression_reason, provider, provider_msg_id, error_code, attempts, scheduled_for, sent_at)
  ON notification_log TO outlet_worker;

-- ---------------------------------------------------------------- seed: transactional copy (EG, v1), Egyptian register
-- One (code, locale) copy fans out to every channel. WhatsApp templates are 'pending' until the BSP approves them
-- (provider contract, VERIFY V-list): the dispatcher treats a non-approved WhatsApp template as rejected and falls back to SMS.
CREATE TEMP TABLE seed_copy (code text, locale text, title text, body text) ON COMMIT DROP;
INSERT INTO seed_copy (code, locale, title, body) VALUES
  ('order_placed',     'ar-EG', 'استلمنا طلبك',       'وصلنا طلبك بقيمة {amount}. هنبلغك أول ما الدفع يتأكد وبعدها البائعين يبدأوا يجهزوه.'),
  ('order_placed',     'en-EG', 'We got your order',   'We received your order of {amount}. We will let you know as soon as payment is confirmed and the sellers start preparing it.'),
  ('order_paid',       'ar-EG', 'تم تأكيد الدفع',      'اتأكد دفع {amount}، شكراً ليك. البائعين بدأوا يجهزوا طلبك.'),
  ('order_paid',       'en-EG', 'Payment confirmed',   'Your payment of {amount} is confirmed, thank you. The sellers are preparing your order.'),
  ('order_shipped',    'ar-EG', 'طلبك في الطريق',      'طلبك اتشحن وفي الطريق ليك. تقدر تتابعه من صفحة طلباتك.'),
  ('order_shipped',    'en-EG', 'Your order is on its way', 'Your order has shipped. You can track it from your orders page.'),
  ('order_delivered',  'ar-EG', 'وصل طلبك',            'طلبك وصل. لو في أي مشكلة تقدر تطلب إرجاع أو استبدال من صفحة الطلب خلال 14 يوم من الاستلام.'),
  ('order_delivered',  'en-EG', 'Your order arrived',  'Your order has been delivered. If anything is wrong you can request a return or exchange from the order page within 14 days of delivery.'),
  ('refund_completed', 'ar-EG', 'بدأنا رد المبلغ',     'رجّعنالك {amount}. لو الرد على وسيلة الدفع الأصلية ممكن ياخد من 5 لـ 14 يوم عمل لحد ما يظهر في حسابك.'),
  ('refund_completed', 'en-EG', 'Your refund is on its way', 'We have refunded {amount}. If it goes back to your original payment method it can take 5 to 14 business days to show in your account.'),
  ('return_received',  'ar-EG', 'استلمنا المرتجع',     'استلمنا المنتج اللي رجّعته وبنفحصه دلوقتي. هنبلغك بالنتيجة خلال 48 ساعة.'),
  ('return_received',  'en-EG', 'We received your return', 'We received the item you sent back and are inspecting it now. We will tell you the result within 48 hours.');

INSERT INTO notification_templates (id, market_id, code, channel, locale, version, category, title, body, provider_template_name, approval_status)
SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(row_number() OVER (ORDER BY s.code, s.locale, c.channel)), 12, '0'))::uuid,
       'EG', s.code, c.channel, s.locale, 1, 'transactional',
       CASE WHEN c.channel IN ('push', 'email', 'in_app') THEN s.title END,
       s.body,
       CASE WHEN c.channel = 'whatsapp' THEN 'outlex_' || s.code || '_' || left(s.locale, 2) END,
       CASE WHEN c.channel = 'whatsapp' THEN 'pending' ELSE 'approved' END
  FROM seed_copy s CROSS JOIN (VALUES ('push'), ('in_app'), ('sms'), ('email'), ('whatsapp')) AS c (channel);
