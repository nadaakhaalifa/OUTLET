# @outlet/notifications

Planning and (later) sending of customer notifications (master prompt section 24, ADR-0011, ADR-0016, ADR-0029).

## Planning (composed in the worker)
`NotificationDispatchConsumer` handles every `NOTIFYING_EVENT_TYPES` event under worker job `notifications.dispatch`
(`apps/api/src/worker-consumers.ts` `notificationHandlers`, kill switch `workers.notifications.dispatch.enabled`).
Per event, in one inbox transaction: dedupe by event id, then one `notification_log` row per recipient and channel decision
(consent per channel, preferences, frequency caps, `notifications.<channel>.enabled` kill switches, Cairo quiet hours 23:00-09:00 for
marketing only; transactional is exempt). Copy is Arabic-first with an English fallback. A payload without a valid recipient id is
parked (inbox row plus error log), never retried into the DLQ.

## No provider yet: rows stay `queued`
Push, SMS, email and WhatsApp providers are not contracted, so no sender is composed. Outbound rows keep `status = 'queued'`,
`provider IS NULL`, `sent_at IS NULL`: nothing claims a message was delivered. (The in-app row is the inbox copy; the in-app port is not
yet composed either.)

## Configuring a provider later
Implement `ChannelPort` for the provider and compose `new Dispatcher({ channels, ... }).runDue(marketId)` as a worker scheduler entry.
`runDue` picks up the `queued` rows whose `scheduled_for` is due (marketing deferred out of quiet hours keeps its later time), sends with
provider then channel failover (transactional only), and only then writes `sent` / `failed` and emits `notification.delivered|failed`.
