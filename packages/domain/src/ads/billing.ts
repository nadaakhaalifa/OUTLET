import { InvalidAmountError } from "../errors";
import { money, type Money } from "../money";
import type { Posting } from "../ledger";
import { addVatToNet } from "../tax/vat";

/**
 * Ad spend is a B2B service from Z-OUTLET to the seller (B4): prices are VAT-exclusive, VAT 14%
 * is added once (the tax engine's single rounding point), and the e-invoice is issued when the
 * seller pays (the advance payment is the tax point; VERIFY BEFORE LAUNCH, VR-B4).
 * The prepaid balance is a closed-loop seller liability: never cash-redeemable, never pooled
 * seller payable money.
 */
export const ACCOUNTS = {
  prepaidLiability: (storeId: string): string => `ads_prepaid_liability:${storeId}`,
  revenue: "ads_revenue",
  vatOutput: "platform_vat_output",
  pspClearing: (psp: string): string => `psp_clearing:${psp}`,
} as const;

export interface TopUpQuote {
  readonly net: bigint;
  readonly vat: bigint;
  readonly gross: bigint;
}

export function quoteTopUp(net: bigint, vatBps: bigint): TopUpQuote {
  if (net <= 0n) throw new InvalidAmountError("top-up must be positive");
  const s = addVatToNet(money(net), vatBps);
  return { net: s.net.amount, vat: s.vat.amount, gross: s.gross.amount };
}

const m = (n: bigint): Money => money(n);

/** Dr PSP clearing gross / Cr prepaid liability net / Cr VAT output vat. Balanced by construction. */
export function topUpPostings(storeId: string, quote: TopUpQuote, psp: string): Posting[] {
  const out: Posting[] = [
    { account: ACCOUNTS.pspClearing(psp), amount: m(quote.gross) },
    { account: ACCOUNTS.prepaidLiability(storeId), amount: m(-quote.net) },
  ];
  if (quote.vat !== 0n) out.push({ account: ACCOUNTS.vatOutput, amount: m(-quote.vat) });
  return out;
}

/** Revenue recognition for one valid click: Dr prepaid liability / Cr ads revenue. */
export function clickPostings(storeId: string, cost: bigint): Posting[] {
  if (cost <= 0n) throw new InvalidAmountError("click cost must be positive");
  return [
    { account: ACCOUNTS.prepaidLiability(storeId), amount: m(cost) },
    { account: ACCOUNTS.revenue, amount: m(-cost) },
  ];
}

/** Credit-back of an invalidated click: exact mirror of `clickPostings`. */
export function creditBackPostings(storeId: string, cost: bigint): Posting[] {
  return clickPostings(storeId, cost).map((p) => ({ account: p.account, amount: m(-p.amount.amount) }));
}
