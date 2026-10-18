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
 * Price-drop auto-buy notices (spec P3-01, ADR-0036). Transactional: the shopper created the rule
 * and the pre-charge notice is part of the mandate, so it is not a marketing message and cannot be
 * switched off by a marketing preference. No amounts, no item names and no PII in a push; details
 * are read in the app behind the deep link. No urgency claims. Synthetic copy: marketing and
 * counsel approve the final Arabic text.
 */
const COPY: readonly Copy[] = [
  {
    key: "auto_buy_target_reached",
    subjectAr: "وصل السعر إلى هدفك",
    subjectEn: "Your target price was reached",
    bodyAr: "وصل أحد المنتجات إلى السعر الذي حددته. افتح التطبيق لإتمام الشراء إذا أردت.",
    bodyEn: "An item reached the price you set. Open the app to buy it if you still want it.",
  },
  {
    key: "auto_buy_pre_charge",
    subjectAr: "سنشتري المنتج قريبا",
    subjectEn: "We are about to buy your item",
    bodyAr: "وصل منتج إلى السعر الذي حددته وسيتم شراؤه بعد 15 دقيقة. يمكنك الإلغاء من التطبيق قبل ذلك.",
    bodyEn: "An item reached your price and will be bought in 15 minutes. You can cancel in the app before then.",
  },
  {
    key: "auto_buy_charged",
    subjectAr: "تم شراء المنتج",
    subjectEn: "Your item was bought",
    bodyAr: "تم شراء المنتج الذي حددت سعره. تجد تفاصيل الطلب في التطبيق.",
    bodyEn: "The item you set a price for was bought. Find the order details in the app.",
  },
  {
    key: "auto_buy_not_charged",
    subjectAr: "لم يتم الشراء",
    subjectEn: "The purchase did not go through",
    bodyAr: "لم نتمكن من إتمام الشراء التلقائي ولم يتم خصم أي مبلغ. قاعدتك ما زالت قائمة.",
    bodyEn: "We could not complete the automatic purchase and nothing was charged. Your rule is still active.",
  },
  {
    key: "auto_buy_sca_required",
    subjectAr: "مطلوب تأكيد منك",
    subjectEn: "Your confirmation is needed",
    bodyAr: "يحتاج البنك إلى تأكيدك لإتمام الشراء. افتح التطبيق للتأكيد.",
    bodyEn: "Your bank needs your confirmation to complete the purchase. Open the app to confirm.",
  },
];

const CHANNELS: readonly Extract<Channel, "in_app" | "push">[] = ["in_app", "push"];

export const AUTO_BUY_TEMPLATE_KEYS = COPY.map((c) => c.key);

export function autoBuyTemplates(): NotificationTemplate[] {
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
