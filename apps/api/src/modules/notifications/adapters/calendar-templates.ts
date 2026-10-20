import { createHash } from "node:crypto";
import type { Channel, NotificationTemplate } from "../domain/types";

/** Same derivation as seed-templates.ts so ids are stable UUIDs and re-seeding is idempotent. */
const seedId = (key: string, channel: string, version: number): string => {
  const h = createHash("sha256").update(`z-outlet.notification-template:${key}:${channel}:${version}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};

interface Copy {
  readonly key: string;
  readonly subjectAr: string;
  readonly subjectEn: string;
  readonly bodyAr: string;
  readonly bodyEn: string;
}

/**
 * Outfit calendar reminders (spec P3-02). Service messages for an event the shopper created and
 * enabled reminders for: transactional, no marketing consent needed, no promotional phrasing, no
 * event note, no amounts and no urgency claims. The calendar module itself holds them back during
 * quiet hours (23:00-09:00 Africa/Cairo) and under its own frequency cap. Synthetic copy: marketing
 * and counsel approve the final Arabic text.
 */
const COPY: readonly Copy[] = [
  {
    key: "calendar_reminder_week",
    subjectAr: "مناسبة قادمة في تقويمك",
    subjectEn: "An event is coming up in your calendar",
    bodyAr: "لديك مناسبة بعد أسبوع. افتح التقويم لتجهيز إطلالتك قبل موعد الطلب.",
    bodyEn: "You have an event in a week. Open your calendar to plan your outfit before the order date.",
  },
  {
    key: "calendar_reminder_day",
    subjectAr: "مناسبتك غدا",
    subjectEn: "Your event is tomorrow",
    bodyAr: "مناسبتك غدا. افتح التقويم لمراجعة إطلالتك.",
    bodyEn: "Your event is tomorrow. Open your calendar to review your outfit.",
  },
];

const CHANNELS: readonly Extract<Channel, "in_app" | "push">[] = ["in_app", "push"];

export const CALENDAR_TEMPLATE_KEYS = COPY.map((c) => c.key);

export function calendarTemplates(): NotificationTemplate[] {
  return COPY.flatMap((c) =>
    CHANNELS.map(
      (channel): NotificationTemplate => ({
        id: seedId(c.key, channel, 1),
        key: c.key,
        version: 1,
        channel,
        category: "transactional",
        type: "ORDER_UPDATES",
        subjectAr: c.subjectAr,
        subjectEn: c.subjectEn,
        bodyAr: c.bodyAr,
        bodyEn: c.bodyEn,
        providerTemplateId: null,
        approval: "APPROVED",
        active: true,
        alertType: null,
        validFromMs: 0,
      }),
    ),
  );
}
