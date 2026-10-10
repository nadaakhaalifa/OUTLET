import type { NotificationTemplate } from "../domain/types";

type Seed = Omit<NotificationTemplate, "id" | "validFromMs" | "active" | "version"> & { version?: number };

let n = 0;
const mk = (s: Seed): NotificationTemplate => ({
  ...s,
  id: `seed-${(n += 1)}`,
  version: s.version ?? 1,
  active: true,
  validFromMs: 0,
});

const base = { subjectAr: null, subjectEn: null, providerTemplateId: null, approval: "APPROVED" as const, alertType: null };

/**
 * Synthetic launch templates (development and tests). Copy contains no numeric social proof, no
 * timers and no amounts. Real copy is authored and approved by marketing and counsel.
 */
export function seedTemplates(): NotificationTemplate[] {
  return [
    mk({ ...base, key: "order_confirmed", channel: "push", category: "transactional", type: "ORDER_UPDATES",
      subjectAr: "تم تأكيد طلبك", subjectEn: "Order confirmed",
      bodyAr: "استلمنا طلبك وجاري تجهيزه.", bodyEn: "We received your order and are preparing it." }),
    mk({ ...base, key: "order_confirmed", channel: "sms", category: "transactional", type: "ORDER_UPDATES",
      bodyAr: "تم تأكيد طلبك من Z-OUTLET.", bodyEn: "Your Z-OUTLET order is confirmed." }),
    mk({ ...base, key: "order_shipped", channel: "push", category: "transactional", type: "ORDER_UPDATES",
      subjectAr: "طلبك في الطريق", subjectEn: "Your order is on its way",
      bodyAr: "تم شحن طلبك رقم {{order_no}}.", bodyEn: "Your order {{order_no}} has shipped." }),
    mk({ ...base, key: "order_shipped", channel: "whatsapp", category: "transactional", type: "ORDER_UPDATES",
      bodyAr: "تم شحن طلبك رقم {{order_no}}.", bodyEn: "Your order {{order_no}} has shipped.",
      providerTemplateId: "wa_order_shipped_v1" }),
    mk({ ...base, key: "order_shipped", channel: "sms", category: "transactional", type: "ORDER_UPDATES",
      bodyAr: "تم شحن طلبك رقم {{order_no}}.", bodyEn: "Your order {{order_no}} has shipped." }),
    mk({ ...base, key: "refund_completed", channel: "push", category: "transactional", type: "REFUNDS",
      subjectAr: "تم رد المبلغ", subjectEn: "Refund completed",
      bodyAr: "اكتمل استرداد المبلغ لطلبك.", bodyEn: "Your refund has been completed." }),
    mk({ ...base, key: "otp_code", channel: "sms", category: "security", type: "ACCOUNT_SECURITY",
      bodyAr: "رمز التحقق: {{code}}", bodyEn: "Your verification code: {{code}}" }),
    mk({ ...base, key: "wishlist_price_drop", channel: "push", category: "marketing", type: "PRICE_DROPS",
      subjectAr: "انخفض سعر منتج في قائمتك", subjectEn: "A price dropped on your list",
      bodyAr: "انخفض السعر الموثق لأحد منتجاتك المحفوظة.", bodyEn: "The verified price of a saved item dropped.",
      alertType: "price_drop" }),
    mk({ ...base, key: "wishlist_back_in_size", channel: "push", category: "marketing", type: "BACK_IN_SIZE",
      subjectAr: "عاد مقاسك", subjectEn: "Your size is back",
      bodyAr: "المقاس الذي حفظته متوفر مرة أخرى.", bodyEn: "The size you saved is available again.",
      alertType: "back_in_size" }),
    mk({ ...base, key: "wishlist_low_stock", channel: "push", category: "marketing", type: "PRICE_DROPS",
      subjectAr: "كمية محدودة", subjectEn: "Limited stock",
      bodyAr: "بقيت كمية محدودة من منتج في قائمتك.", bodyEn: "Limited stock remains on a saved item.",
      alertType: "low_stock" }),
    mk({ ...base, key: "wishlist_date_approaching", channel: "push", category: "marketing", type: "PRICE_DROPS",
      subjectAr: "موعد مناسبتك يقترب", subjectEn: "Your date is approaching",
      bodyAr: "اقترب موعد المناسبة في قائمتك.", bodyEn: "The date on your list is approaching.",
      alertType: "date_approaching" }),
    mk({ ...base, key: "promo_drop", channel: "push", category: "marketing", type: "PROMOTIONS",
      subjectAr: "مجموعة جديدة", subjectEn: "A new drop",
      bodyAr: "وصلت مجموعة جديدة من متاجرك المفضلة.", bodyEn: "A new drop from your favourite stores arrived." }),
    mk({ ...base, key: "promo_drop", channel: "whatsapp", category: "marketing", type: "PROMOTIONS",
      bodyAr: "وصلت مجموعة جديدة من متاجرك المفضلة.", bodyEn: "A new drop from your favourite stores arrived.",
      providerTemplateId: "wa_promo_drop_v1" }),
  ];
}
