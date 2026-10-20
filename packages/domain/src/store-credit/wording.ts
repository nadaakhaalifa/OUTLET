import type { StoreCreditSub } from "../chart-of-accounts";

/**
 * Closed-loop wording (spec 15.2, ADR-0003): the product never calls store credit cash or money.
 * Labels are the only strings this module puts on the wire besides amounts and codes.
 */
export const FORBIDDEN_WORDING: readonly RegExp[] = [
  /\bcash\b/i,
  /\bmoney\b/i,
  /\bwithdraw/i,
  /\btop[ -]?up\b/i,
  /\bdeposit\b/i,
  /\btransfer\b/i,
  /\bpayout\b/i,
  /نقد/,
  /فلوس/,
  /سحب/, // سحب (withdraw)
  /تحويل/, // تحويل (transfer)
  /شحن/, // شحن as in top-up is ambiguous with shipping, kept off the credit surface
];

export interface Label {
  readonly ar: string;
  readonly en: string;
}

export function labelFor(sub: StoreCreditSub): Label {
  switch (sub.kind) {
    case "refund_credit":
      return { ar: "رصيد المرتجعات", en: "Refund credit" };
    case "gift_card":
      return { ar: "رصيد بطاقة هدية", en: "Gift card credit" };
    case "cashback_coins":
      return { ar: "رصيد نقاط الاسترداد", en: "Cashback coins credit" };
    case "referral_credit":
      return { ar: "رصيد الدعوات", en: "Referral credit" };
    case "goodwill":
      return { ar: "رصيد تقدير", en: "Goodwill credit" };
  }
}

export const WALLET_TITLE: Label = { ar: "رصيد Z-OUTLET", en: "Z-OUTLET credit" };

export function violatesWording(text: string): boolean {
  return FORBIDDEN_WORDING.some((re) => re.test(text));
}

export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}
