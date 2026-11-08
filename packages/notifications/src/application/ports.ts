import type { Locale } from "@outlet/i18n";
import type { ConsentPurpose } from "@outlet/privacy";
import type { Channel } from "../domain/types.js";

export interface OutboundMessage {
  readonly userId: string;
  readonly channel: Channel;
  readonly templateCode: string;
  readonly locale: Locale;
  readonly title: string | null;
  /** Rendered body. Adapters must not log it (it can hold personal data). */
  readonly body: string;
  /** WhatsApp approved template name; null for other channels. */
  readonly providerTemplateName: string | null;
  readonly vars: Readonly<Record<string, string | number>>;
  /** Stable per (event, user, channel slot); adapters pass it to the provider as its own idempotency key. */
  readonly idempotencyKey: string;
}

export type SendFailureCode = "template_rejected" | "no_destination" | "provider_error" | "rate_limited";

export type SendResult =
  | { readonly ok: true; readonly providerMsgId: string }
  | { readonly ok: false; readonly code: SendFailureCode };

/** One provider of one channel. The destination (phone, email, push token) is resolved by the adapter from the user id. */
export interface ChannelPort {
  readonly provider: string;
  send(msg: OutboundMessage): Promise<SendResult>;
}

/** Kill switch per channel. Names to register in @outlet/flags: see CHANNEL_KILL_SWITCH_NAMES. */
export interface ChannelKillSwitchPort {
  isKilled(channel: Channel): Promise<boolean>;
}

export const CHANNEL_KILL_SWITCH_NAMES: Readonly<Record<Channel, string>> = {
  push: "notifications.push.enabled",
  in_app: "notifications.in_app.enabled",
  whatsapp: "notifications.whatsapp.enabled",
  sms: "notifications.sms.enabled",
  email: "notifications.email.enabled",
};

/** Subset of ConsentService the dispatcher needs. */
export interface ConsentReader {
  current(userId: string): Promise<readonly { readonly purpose: ConsentPurpose; readonly granted: boolean }[]>;
}
