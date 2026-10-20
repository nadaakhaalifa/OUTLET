import type { StoreCreditSub } from "../chart-of-accounts";
import type { Money } from "../money";

/** How a shopper paid, as the refund router sees it (spec 15.6). */
export const PAYMENT_METHODS = [
  "card",
  "apple_pay",
  "meeza",
  "mobile_wallet",
  "instapay",
  "fawry",
  "bnpl",
  "cod",
  "store_credit",
  "gift_card",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** One tender of the order the refund is for. `amount` is what that tender paid, in piastres. */
export interface OriginalTender {
  readonly id: string;
  readonly method: PaymentMethod;
  readonly amount: Money;
  readonly refundedBefore: Money;
  /** PSP code for psp-backed methods ("paymob", "fawry"). */
  readonly psp?: string;
  /** BNPL provider code for method "bnpl". */
  readonly provider?: string;
  /** Courier code for method "cod". */
  readonly courier?: string;
  /** Sub-balance the tender drew from, for method "store_credit" or "gift_card". */
  readonly creditSub?: StoreCreditSub;
}

export const REFUND_CHANNELS = [
  "psp_original",
  "psp_reverse",
  "bank_transfer_iban",
  "wallet_transfer",
  "store_credit",
  "store_credit_original_sub",
  "fawry_voucher",
  "bnpl_cancel",
] as const;
export type RefundChannel = (typeof REFUND_CHANNELS)[number];

/** Channels that put value back as HAUL credit. BNPL must never use these. */
export const CREDIT_CHANNELS: readonly RefundChannel[] = ["store_credit", "store_credit_original_sub"];
/** Channels that pay out through a bank or wallet account. BNPL must never use these. */
export const CASH_CHANNELS: readonly RefundChannel[] = ["psp_reverse", "bank_transfer_iban", "wallet_transfer", "fawry_voucher"];

export interface RefundRoute {
  readonly tenderId: string;
  readonly method: PaymentMethod;
  readonly channel: RefundChannel;
  readonly amount: Money;
  /** Sub-balance to credit, for credit channels. */
  readonly creditSub: StoreCreditSub | null;
  /** True when the leg cannot execute until a verified IBAN or wallet is on file. */
  readonly needsPayoutDetails: boolean;
  /** The VERIFY BEFORE LAUNCH row this routing assumption depends on, if any. */
  readonly verify: string | null;
  /** Why the shopper's stated preference was not (fully) honoured, if so. */
  readonly note: "preference_ignored_bnpl_provider_only" | "preference_ignored_original_credit_only" | null;
}

export interface RefundChoice {
  /** Default original_method. Honoured only where both options are legal. */
  readonly preference: "original_method" | "store_credit";
  /** What a COD shopper chose. Default store_credit (cash was never taken by us as a refundable tender). */
  readonly cod: "store_credit" | "bank_transfer" | "wallet_transfer";
}

export const DEFAULT_REFUND_CHOICE: RefundChoice = { preference: "original_method", cod: "store_credit" };

export interface RefundRouterConfig {
  /** Fawry is refunded to store credit or a Fawry refund voucher "per contract" (VERIFY VR-RF-02). */
  readonly fawry: "store_credit" | "fawry_voucher";
  /** Whether the PSP can reverse a wallet or InstaPay payment (VERIFY VR-RF-01). */
  readonly pspReverse: { readonly mobile_wallet: boolean; readonly instapay: boolean };
}

export const DEFAULT_REFUND_ROUTER_CONFIG: RefundRouterConfig = {
  fawry: "store_credit",
  pspReverse: { mobile_wallet: false, instapay: false },
};
