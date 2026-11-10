import { accountCode } from "@outlet/ledger";
import { allocate, money, add } from "@outlet/money";
import type { Money } from "@outlet/money";
import { ReturnsError } from "./errors.js";

export type TenderMethod = "card" | "apple_pay" | "meeza" | "wallet" | "instapay" | "fawry" | "bnpl" | "cod" | "store_credit";
export type RouteKind = "psp_original" | "bnpl_provider" | "store_credit" | "bank_transfer" | "fawry_voucher";
export type ShopperChoice = "original" | "store_credit";

/** A captured store-credit leg of the original payment: the refund goes back to the SAME sub-balance account. */
export interface CreditLeg {
  readonly accountCode: string;
  readonly amount: Money;
}

export interface RouteInput {
  readonly marketId: string;
  readonly userId: string;
  readonly method: TenderMethod;
  /** psp_clearing owner (paymob, ...) or the BNPL provider code for bnpl_clearing. */
  readonly clearingOwner: string | null;
  /** PSP can reverse a wallet / InstaPay payment to its source; false = IBAN bank transfer instead (15.6, V4). */
  readonly pspReversible: boolean;
  readonly refund: Money;
  readonly credit: Money;
  readonly external: Money;
  readonly creditLegs: readonly CreditLeg[];
  readonly choice: ShopperChoice | null;
}

export interface Destination {
  readonly route: RouteKind;
  readonly amount: Money;
  /** Ledger account credited by the refund entry. */
  readonly accountCode: string;
}

const REFUND_CREDIT = (i: RouteInput): string => accountCode({ type: "store_credit", market: i.marketId, currency: i.refund.currency, owner: i.userId, sub: "refund_credit" });
const PAYABLE = (i: RouteInput): string => accountCode({ type: "shopper_refunds_payable", market: i.marketId, currency: i.refund.currency });

/**
 * RefundRouter (master prompt 15.6, ledger spec I8). Pure. Rules:
 *  - the store-credit portion of the original payment always goes back to the same sub-balance;
 *  - card / Apple Pay / Meeza: PSP to the original method (default) or instant store credit if the shopper chooses;
 *  - wallet / InstaPay: PSP reverse where supported (default), else bank transfer to the payer's verified IBAN; credit if chosen;
 *  - Fawry: store credit (default) or a Fawry refund voucher when the shopper chooses the original method;
 *  - BNPL: provider cancellation ONLY, never store credit or psp_clearing (a credit choice is refused, not silently ignored);
 *  - COD: instant store credit (default) or a bank / wallet transfer when the shopper chooses the original method.
 * The destinations always sum exactly to the refund.
 */
export function routeRefund(i: RouteInput): Destination[] {
  const cur = i.refund.currency;
  if (i.credit.amountMinor + i.external.amountMinor !== i.refund.amountMinor) throw new ReturnsError("refund_exceeds_paid", "tender parts do not sum to the refund");
  const out: Destination[] = [];
  if (i.credit.amountMinor > 0n) {
    if (i.creditLegs.length === 0) throw new ReturnsError("refund_exceeds_paid", "no captured store-credit leg to return the credit portion to");
    const parts = allocate(i.credit, i.creditLegs.map((l) => l.amount.amountMinor));
    i.creditLegs.forEach((leg, idx) => {
      const amount = parts[idx] ?? money(0n, cur);
      if (amount.amountMinor > 0n) out.push({ route: "store_credit", amount, accountCode: leg.accountCode });
    });
  }
  if (i.external.amountMinor > 0n) {
    const amount = i.external;
    const clearing = (type: "psp_clearing" | "bnpl_clearing"): string => {
      if (i.clearingOwner === null) throw new ReturnsError("not_found", "no clearing owner for the original tender");
      return accountCode({ type, market: i.marketId, currency: cur, owner: i.clearingOwner });
    };
    switch (i.method) {
      case "card":
      case "apple_pay":
      case "meeza":
        out.push(i.choice === "store_credit" ? { route: "store_credit", amount, accountCode: REFUND_CREDIT(i) } : { route: "psp_original", amount, accountCode: clearing("psp_clearing") });
        break;
      case "wallet":
      case "instapay":
        if (i.choice === "store_credit") out.push({ route: "store_credit", amount, accountCode: REFUND_CREDIT(i) });
        else if (i.pspReversible) out.push({ route: "psp_original", amount, accountCode: clearing("psp_clearing") });
        else out.push({ route: "bank_transfer", amount, accountCode: PAYABLE(i) });
        break;
      case "fawry":
        out.push(i.choice === "original" ? { route: "fawry_voucher", amount, accountCode: PAYABLE(i) } : { route: "store_credit", amount, accountCode: REFUND_CREDIT(i) });
        break;
      case "bnpl":
        if (i.choice === "store_credit") throw new ReturnsError("bnpl_provider_only", "BNPL refunds go back through the provider only");
        out.push({ route: "bnpl_provider", amount, accountCode: clearing("bnpl_clearing") });
        break;
      case "cod":
        out.push(i.choice === "original" ? { route: "bank_transfer", amount, accountCode: PAYABLE(i) } : { route: "store_credit", amount, accountCode: REFUND_CREDIT(i) });
        break;
      case "store_credit":
        throw new ReturnsError("refund_exceeds_paid", "a store-credit-only order has no external tender");
    }
  }
  const sum = out.reduce((a, d) => add(a, d.amount), money(0n, cur));
  if (sum.amountMinor !== i.refund.amountMinor) throw new ReturnsError("refund_exceeds_paid", "destinations do not sum to the refund");
  return out;
}

/** Single label stored on refunds.route. */
export const summaryRoute = (d: readonly Destination[]): RouteKind | "mixed" => {
  const kinds = new Set(d.map((x) => x.route));
  const only = [...kinds][0];
  return kinds.size === 1 && only !== undefined ? only : "mixed";
};
