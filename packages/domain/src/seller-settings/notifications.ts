import { SellerSettingsError } from "./errors";

export const SELLER_NOTIFICATION_EVENTS = [
  "new_order",
  "order_sla_warning",
  "order_cancelled",
  "return_requested",
  "return_received",
  "payout_sent",
  "payout_held",
  "price_claim_action",
  "account_security",
  "kyc_update",
  "stock_low",
  "marketing_tips",
] as const;
export type SellerNotificationEvent = (typeof SELLER_NOTIFICATION_EVENTS)[number];

export const SELLER_CHANNELS = ["in_app", "push", "email", "whatsapp", "sms"] as const;
export type SellerChannel = (typeof SELLER_CHANNELS)[number];

/** Transactional events (B1): in-app delivery can never be turned off. Only marketing and stock tips are optional. */
export const TRANSACTIONAL_EVENTS: ReadonlySet<SellerNotificationEvent> = new Set([
  "new_order",
  "order_sla_warning",
  "order_cancelled",
  "return_requested",
  "return_received",
  "payout_sent",
  "payout_held",
  "price_claim_action",
  "account_security",
  "kyc_update",
]);

export type ChannelPrefs = Readonly<Record<SellerChannel, boolean>>;
export type NotificationPrefs = Readonly<Record<SellerNotificationEvent, ChannelPrefs>>;

const chan = (on: readonly SellerChannel[]): ChannelPrefs =>
  Object.fromEntries(SELLER_CHANNELS.map((c) => [c, on.includes(c)])) as ChannelPrefs;

export function defaultPrefs(): NotificationPrefs {
  return Object.fromEntries(
    SELLER_NOTIFICATION_EVENTS.map((e) => [
      e,
      TRANSACTIONAL_EVENTS.has(e) ? chan(["in_app", "push", "email"]) : chan(["in_app"]),
    ]),
  ) as NotificationPrefs;
}

/**
 * Merges a partial update over the current prefs. A transactional event may change its optional
 * channels but never its `in_app` channel, and `account_security` always keeps email as well.
 */
export function applyPrefUpdate(
  current: NotificationPrefs,
  update: Partial<Record<SellerNotificationEvent, Partial<Record<SellerChannel, boolean>>>>,
): NotificationPrefs {
  const next: Record<string, ChannelPrefs> = { ...current };
  for (const [event, channels] of Object.entries(update)) {
    if (!(SELLER_NOTIFICATION_EVENTS as readonly string[]).includes(event)) {
      throw new SellerSettingsError("notification_event_unknown");
    }
    const e = event as SellerNotificationEvent;
    const merged = { ...current[e], ...channels } as Record<SellerChannel, boolean>;
    if (TRANSACTIONAL_EVENTS.has(e)) {
      if (!merged.in_app) throw new SellerSettingsError("transactional_cannot_be_disabled");
      if (e === "account_security" && !merged.email) throw new SellerSettingsError("transactional_cannot_be_disabled");
    }
    next[e] = merged;
  }
  return next as NotificationPrefs;
}
