import { CURRENCY_MINOR_UNITS } from "@outlet/money";
import type { Money } from "@outlet/money";
import type { EvaluationResult } from "./types.js";

export interface DisplayLabel {
  readonly promotionId: string;
  readonly kind: "voucher" | "discount";
  readonly textAr: string;
  readonly textEn: string;
  readonly amount: Money;
}

const AR_CURRENCY: Record<string, string> = { EGP: "ج.م" };

/** Integer-only formatting of minor units ("125.50"). */
export const formatMinor = (m: Money): string => {
  const digits = CURRENCY_MINOR_UNITS[m.currency];
  const neg = m.amountMinor < 0n;
  const abs = neg ? -m.amountMinor : m.amountMinor;
  if (digits === 0) return `${neg ? "-" : ""}${abs.toString()}`;
  const unit = 10n ** BigInt(digits);
  return `${neg ? "-" : ""}${(abs / unit).toString()}.${(abs % unit).toString().padStart(digits, "0")}`;
};

/**
 * Display copy for the applied promotions. A promotion is shown only as an amount taken off ("Voucher -X" / "Discount -X").
 * By construction it never contains a percentage, a reference ("was") price or the seller-entered promotion name, so a voucher can never
 * pose as a verified price claim (master prompt section 17; price claims come only from the Price Integrity Engine, section 9).
 */
export const displayLabels = (result: EvaluationResult): DisplayLabel[] =>
  result.applied
    .filter((a) => a.total.amountMinor > 0n)
    .map((a) => {
      const kind = a.voucherId !== null || a.stackingClass === "platform_code" || a.stackingClass === "store_voucher" ? "voucher" : "discount";
      const amt = formatMinor(a.total);
      const cur = a.total.currency;
      const ar = AR_CURRENCY[cur] ?? cur;
      return {
        promotionId: a.promotionId, kind, amount: a.total,
        textEn: `${kind === "voucher" ? "Voucher" : "Discount"} −${amt} ${cur}`,
        textAr: `${kind === "voucher" ? "قسيمة" : "خصم"} −${amt} ${ar}`,
      };
    });
