import { MANDATE_TEXT_VERSION, type MandateLocale } from "./types";

/**
 * DRAFT mandate wording, version 1. Legal text is a counsel decision (VR-P3-02) and is NOT
 * approved: it is stored immutably per (version, locale), and any change ships as version + 1.
 * Placeholders are filled from the accepted terms so the shopper sees the exact terms.
 */
export const MANDATE_TEMPLATES: Readonly<Record<number, Readonly<Record<MandateLocale, string>>>> = {
  1: {
    en:
      "I authorise Z-OUTLET to buy 1 unit of {{item}} (size {{size}}) for me when its verified price is {{target}} or lower, and never above {{max}}. " +
      "Before any charge I will be notified and can cancel within 15 minutes. This rule ends on {{expires}} or when I cancel it, and I can cancel it at any time in the app. " +
      "My return and cancellation rights are the same as for any order.",
    ar:
      "أفوّض Z-OUTLET بشراء قطعة واحدة من {{item}} (المقاس {{size}}) نيابة عني عندما يصبح سعرها الموثّق {{target}} أو أقل، وبحد أقصى {{max}}. " +
      "قبل أي خصم سيصلني إشعار ويمكنني الإلغاء خلال 15 دقيقة. تنتهي هذه القاعدة في {{expires}} أو عند إلغائها، ويمكنني إلغاؤها في أي وقت من التطبيق. " +
      "حقوقي في الإرجاع والإلغاء هي نفسها كأي طلب آخر.",
  },
};

export interface MandateTextFields {
  readonly item: string;
  readonly size: string;
  readonly target: string;
  readonly max: string;
  readonly expires: string;
}

/** Plain piastres to a display string using integer math only ("649.00"). */
export function formatPiastres(amount: bigint): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export function mandateTemplate(version: number, locale: MandateLocale): string | null {
  return MANDATE_TEMPLATES[version]?.[locale] ?? null;
}

export function renderMandateText(template: string, f: MandateTextFields): string {
  const values: Readonly<Record<string, string>> = { ...f };
  return template.replace(/\{\{(item|size|target|max|expires)\}\}/g, (_m, k: string) => values[k] ?? "");
}

export const CURRENT_MANDATE_VERSION = MANDATE_TEXT_VERSION;
