/** Pure notification vocabulary (spec section 24, docs/specs/notifications.md). No IO, no clock. */

export const EXTERNAL_CHANNELS = ["push", "whatsapp", "email", "sms"] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];
export type Channel = ExternalChannel | "in_app";

/** Delivery preference order of external channels (first deliverable wins). */
export const CHANNEL_ORDER: readonly ExternalChannel[] = EXTERNAL_CHANNELS;

export const CATEGORIES = ["transactional", "marketing", "security"] as const;
export type Category = (typeof CATEGORIES)[number];

/** User switchable types. All are marketing. */
export const SWITCHABLE_TYPES = ["PRICE_DROPS", "BACK_IN_SIZE", "STYLIST", "BUDGET", "PROMOTIONS", "REWARDS", "PLUS"] as const;
export type SwitchableType = (typeof SWITCHABLE_TYPES)[number];
export const FIXED_TYPES = ["ORDER_UPDATES", "REFUNDS", "ACCOUNT_SECURITY"] as const;
export type NotificationType = SwitchableType | (typeof FIXED_TYPES)[number];
export const isSwitchable = (t: string): t is SwitchableType => (SWITCHABLE_TYPES as readonly string[]).includes(t);

export type MarketingPurpose = "marketing_push" | "marketing_whatsapp" | "marketing_email";
/** SMS has no marketing purpose (ADR-0018): it is absent on purpose. */
export const MARKETING_PURPOSE: Readonly<Partial<Record<ExternalChannel, MarketingPurpose>>> = {
  push: "marketing_push",
  whatsapp: "marketing_whatsapp",
  email: "marketing_email",
};

export type ApprovalStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";
export type AlertType = "price_drop" | "back_in_size" | "low_stock" | "date_approaching";

export interface NotificationTemplate {
  readonly id: string;
  readonly key: string;
  readonly version: number;
  readonly channel: Channel;
  readonly category: Category;
  readonly type: NotificationType;
  readonly subjectAr: string | null;
  readonly subjectEn: string | null;
  readonly bodyAr: string;
  readonly bodyEn: string | null;
  readonly providerTemplateId: string | null;
  readonly approval: ApprovalStatus;
  readonly active: boolean;
  readonly alertType: AlertType | null;
  readonly validFromMs: number;
}

export type SuppressionReason = "UNSUBSCRIBED" | "BOUNCE" | "COMPLAINT" | "INVALID_TOKEN";
export type SuppressedReason = "NO_CONSENT" | "FREQUENCY_CAP" | "QUIET_HOURS" | "PREFERENCE" | "SUPPRESSION_LIST";
export type RequestStatus = "ACCEPTED" | "SUPPRESSED" | "SCHEDULED" | "SENT" | "FAILED" | "CANCELLED";
export type Locale = "ar" | "en";

export type PayloadValue = string | number;
export type Payload = Readonly<Record<string, PayloadValue>>;

export interface NotificationRequest {
  readonly id: string;
  readonly userId: string;
  readonly templateKey: string;
  readonly ref: string;
  readonly category: Category;
  readonly type: NotificationType;
  readonly payload: Payload;
  /** channel -> template version this request was rendered with (queued messages keep their version). */
  readonly templateVersions: Readonly<Partial<Record<Channel, number>>>;
  readonly status: RequestStatus;
  readonly suppressedReason: SuppressedReason | null;
  readonly pendingChannel: ExternalChannel | null;
  readonly scheduledForMs: number | null;
  readonly attempts: number;
  readonly expiresAtMs: number;
  readonly deepLink: string | null;
  readonly locale: Locale;
  readonly createdAtMs: number;
}

export type LogStatus = "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "BOUNCED";

export interface DeliveryLogEntry {
  readonly id: string;
  readonly requestId: string;
  readonly userId: string;
  readonly channel: Channel;
  readonly templateKey: string;
  readonly templateVersion: number;
  readonly category: Category;
  readonly providerCode: string;
  readonly providerRef: string | null;
  readonly status: LogStatus;
  readonly failureCode: string | null;
  readonly sentAtMs: number;
}

export interface InboxMessage {
  readonly id: string;
  readonly userId: string;
  readonly requestId: string;
  readonly type: NotificationType;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly bodyAr: string;
  readonly bodyEn: string | null;
  readonly deepLink: string | null;
  readonly readAtMs: number | null;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
}

export interface FrequencyCaps {
  readonly perDay: number;
  readonly perWeek: number;
}

export interface QuietHours {
  /** Minutes after local midnight (Africa/Cairo). */
  readonly fromMin: number;
  readonly toMin: number;
}

export const DEFAULT_CAPS: FrequencyCaps = { perDay: 1, perWeek: 3 };
export const DEFAULT_QUIET_HOURS: QuietHours = { fromMin: 23 * 60, toMin: 9 * 60 };
export const DEFAULT_INBOX_TTL_MS = 90 * 86_400_000;
export const DEFAULT_TTL_MS: Readonly<Record<Category, number>> = {
  transactional: 24 * 3_600_000,
  security: 15 * 60_000,
  marketing: 24 * 3_600_000,
};
