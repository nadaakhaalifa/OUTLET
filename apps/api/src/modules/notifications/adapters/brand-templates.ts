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
 * Brand onboarding messages (transactional, no marketing consent needed). Only `{{brand_name}}` is
 * interpolated: reviewer messages and requested items stay in the application and are read in the
 * app through the deep link, so no free text from an admin or an applicant reaches a push or an
 * e-mail. Synthetic copy: marketing and counsel approve the final Arabic text.
 */
const COPY: readonly Copy[] = [
  {
    key: "brand_application_received",
    subjectAr: "استلمنا طلب انضمام علامتك",
    subjectEn: "We received your brand application",
    bodyAr: "استلمنا طلب انضمام {{brand_name}} وسيراجعه فريقنا. يمكنك متابعة الحالة من التطبيق.",
    bodyEn: "We received the application for {{brand_name}} and our team will review it. You can follow its status in the app.",
  },
  {
    key: "brand_application_needs_info",
    subjectAr: "مطلوب معلومات إضافية لطلبك",
    subjectEn: "More information is needed for your application",
    bodyAr: "نحتاج إلى معلومات إضافية لإكمال مراجعة طلب {{brand_name}}. افتح الطلب لمعرفة المطلوب.",
    bodyEn: "We need more information to finish reviewing the application for {{brand_name}}. Open the application to see what is needed.",
  },
  {
    key: "brand_application_approved",
    subjectAr: "تم قبول علامتك",
    subjectEn: "Your brand was approved",
    bodyAr: "تم قبول {{brand_name}} وأصبح متجرك جاهزا. ابدأ من قائمة خطوات الإعداد.",
    bodyEn: "{{brand_name}} was approved and your store is ready. Start with the setup checklist.",
  },
  {
    key: "brand_application_rejected",
    subjectAr: "نتيجة طلب انضمام علامتك",
    subjectEn: "Your brand application result",
    bodyAr: "لم نتمكن من قبول طلب {{brand_name}}. افتح الطلب لمعرفة السبب وخياراتك.",
    bodyEn: "We could not approve the application for {{brand_name}}. Open the application to see the reason and your options.",
  },
  {
    key: "brand_application_appeal_result",
    subjectAr: "نتيجة التظلم على طلبك",
    subjectEn: "The result of your appeal",
    bodyAr: "صدرت نتيجة التظلم على طلب {{brand_name}}. افتح الطلب لمعرفة القرار.",
    bodyEn: "A decision was made on your appeal for {{brand_name}}. Open the application to see it.",
  },
];

const CHANNELS: readonly Extract<Channel, "in_app" | "push" | "email">[] = ["in_app", "push", "email"];

export const BRAND_TEMPLATE_KEYS = COPY.map((c) => c.key);

export function brandTemplates(): NotificationTemplate[] {
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
