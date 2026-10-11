import type {
  Channel,
  DeliveryLogEntry,
  ExternalChannel,
  InboxMessage,
  Locale,
  MarketingPurpose,
  NotificationRequest,
  NotificationTemplate,
  SuppressionReason,
} from "./types";

export interface Clock {
  nowMs(): number;
}
export interface IdPort {
  uuidV7(): string;
}

export interface TemplateRepository {
  /** Highest active version per channel whose valid_from has passed. */
  activeFor(key: string, nowMs: number): Promise<readonly NotificationTemplate[]>;
  /** Exact version, used for queued messages. */
  version(key: string, channel: Channel, version: number): Promise<NotificationTemplate | null>;
  get(id: string): Promise<NotificationTemplate | null>;
  save(template: NotificationTemplate): Promise<void>;
}

export interface RequestRepository {
  /** Atomic. False when `(userId, templateKey, ref)` already exists. */
  insertIfAbsent(request: NotificationRequest): Promise<boolean>;
  find(userId: string, templateKey: string, ref: string): Promise<NotificationRequest | null>;
  save(request: NotificationRequest): Promise<void>;
  /** Moves due SCHEDULED requests to ACCEPTED (claimed) and returns them (SKIP LOCKED in SQL). */
  claimDue(nowMs: number, limit: number): Promise<readonly NotificationRequest[]>;
}

export interface DeliveryLogRepository {
  append(entry: DeliveryLogEntry): Promise<void>;
  forRequest(requestId: string): Promise<readonly DeliveryLogEntry[]>;
}

export interface FrequencyStore {
  record(userId: string, channel: ExternalChannel, atMs: number): Promise<void>;
  /**
   * Atomic check-and-reserve of one marketing send slot. `admit` receives the delivery times
   * (including live reservations) and runs inside the store's critical section; on true the slot
   * is recorded in the same step. Returns false when not admitted.
   */
  reserve(userId: string, channel: ExternalChannel, atMs: number, admit: (sentTimes: readonly number[]) => boolean): Promise<boolean>;
  /** Gives back a slot taken by `reserve` when the send did not happen. */
  release(userId: string, channel: ExternalChannel, atMs: number): Promise<void>;
  /** Delivery times of marketing messages at or after `sinceMs`. */
  sentTimes(userId: string, channel: ExternalChannel, sinceMs: number): Promise<readonly number[]>;
}

/** Keys are `TYPE` (all channels) or `TYPE.channel`. */
export interface PreferenceRepository {
  all(userId: string): Promise<ReadonlyMap<string, boolean>>;
  setMany(userId: string, entries: ReadonlyMap<string, boolean>, nowMs: number): Promise<void>;
}

export interface SuppressionRepository {
  active(userId: string, channel: ExternalChannel): Promise<ReadonlySet<SuppressionReason>>;
  add(userId: string, channel: ExternalChannel, reason: SuppressionReason, nowMs: number): Promise<void>;
  remove(userId: string, channel: ExternalChannel, reason: SuppressionReason): Promise<void>;
}

export interface InboxRepository {
  insert(message: InboxMessage): Promise<void>;
  /** Newest first, strictly after the cursor, hiding expired rows. */
  list(
    userId: string,
    after: { readonly createdAtMs: number; readonly id: string } | null,
    limit: number,
    nowMs: number,
  ): Promise<readonly InboxMessage[]>;
  /** All-or-nothing: false (and no change) when any id is not the user's or does not exist. */
  markRead(userId: string, ids: readonly string[], nowMs: number): Promise<boolean>;
}

export interface PushToken {
  readonly installId: string;
  readonly platform: "ios" | "android";
  readonly token: string;
}
export interface PushTokenRepository {
  upsert(userId: string, token: PushToken, nowMs: number): Promise<void>;
  active(userId: string): Promise<readonly PushToken[]>;
  deactivate(userId: string, token: string, nowMs: number): Promise<void>;
}

/** Consent is owned by privacy. Marketing messages need the channel's purpose granted. */
export interface ConsentPort {
  isGranted(userId: string, purpose: MarketingPurpose): Promise<boolean>;
  withdraw(userId: string, purpose: MarketingPurpose): Promise<void>;
}

export interface Contact {
  readonly locale: Locale;
  readonly phone: string | null;
  readonly email: string | null;
}
/** Contact data is read at send time and never copied or logged. Null means the user is gone. */
export interface ContactPort {
  contact(userId: string): Promise<Contact | null>;
}

export interface ProviderMessage {
  readonly requestId: string;
  readonly channel: ExternalChannel;
  /** Device token, phone or address. Never logged. */
  readonly to: string;
  readonly subject: string | null;
  readonly body: string;
  readonly providerTemplateId: string | null;
  readonly locale: Locale;
}

export type ProviderResult =
  | { readonly kind: "sent"; readonly providerRef: string }
  /** Timeout, 5xx, circuit open: the next provider is tried. */
  | { readonly kind: "unavailable" }
  /** The provider refused the template (WhatsApp). */
  | { readonly kind: "template_rejected" }
  /** Bad or expired token, unknown number or address. Permanent for this recipient. */
  | { readonly kind: "invalid_recipient" }
  | { readonly kind: "failed"; readonly code: string };

export interface ChannelProvider<C extends ExternalChannel = ExternalChannel> {
  readonly code: string;
  readonly channel: C;
  send(message: ProviderMessage & { readonly channel: C }): Promise<ProviderResult>;
}
export type PushProvider = ChannelProvider<"push">;
export type SmsProvider = ChannelProvider<"sms">;
export type WhatsAppProvider = ChannelProvider<"whatsapp">;
export type EmailProvider = ChannelProvider<"email">;

/** Providers per channel, enabled only, in priority order (the channel_providers table). */
export interface ProviderRegistry {
  providersFor(channel: ExternalChannel): readonly ChannelProvider[];
}

export type NotificationEvent =
  | { readonly type: "notification.sent"; readonly requestId: string; readonly category: string; readonly channel: Channel }
  | { readonly type: "notification.failed"; readonly requestId: string; readonly category: string; readonly channel: Channel | null; readonly code: string }
  | { readonly type: "notification.suppressed"; readonly requestId: string; readonly category: string; readonly reason: string };

/** Production adapter writes the outbox row in the same transaction as the state change. */
export interface NotificationEventPublisher {
  publish(event: NotificationEvent): Promise<void>;
}

export interface AnalyticsEvent {
  readonly name: "wishlist_alert_sent";
  readonly properties: { readonly alert_type: string; readonly channel: Channel };
}
export interface AnalyticsPort {
  track(event: AnalyticsEvent): Promise<void>;
}

/** inbox_processed: the mark and the effect commit together or not at all. */
export interface InboxProcessedPort {
  runOnce<T>(consumer: string, messageId: string, fn: () => Promise<T>): Promise<{ readonly kind: "duplicate" } | { readonly kind: "done"; readonly value: T }>;
}
