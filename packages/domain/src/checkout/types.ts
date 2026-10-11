import type { StoreCreditSub } from "../chart-of-accounts/accounts";
import type { Money } from "../money";

/** Payment methods a shopper can pick at checkout (spec 7). Same codes as orders and promotions. */
export const CHECKOUT_METHODS = [
  "card",
  "apple_pay",
  "meeza",
  "mobile_wallet",
  "instapay",
  "fawry",
  "bnpl",
  "cod",
] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

/** Price lock: the price at checkout start holds for 10 minutes (spec 7). */
export const PRICE_LOCK_MS = 10 * 60 * 1000;

export const MAX_VOUCHER_CODES = 5;

export type { Money };

/** A priced bag line entering checkout. `unitPrice` is the server price, VAT-inclusive. */
export interface CheckoutLine {
  readonly lineId: string;
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly isDrop: boolean;
}

export interface StoreTermsForCheckout {
  readonly storeId: string;
  /** Effective free-delivery threshold, piastres. null = no threshold. */
  readonly freeDeliveryThreshold: Money | null;
  readonly standardDeliveryFee: Money;
}

export interface QuoteLine {
  readonly lineId: string;
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  /** Voucher / promotion value allocated to this line (merchandise discount). */
  readonly discount: Money;
  readonly vat: Money;
}

export interface StoreQuote {
  readonly storeId: string;
  readonly merchandise: Money;
  readonly platformFundedDiscount: Money;
  readonly sellerFundedDiscount: Money;
  /** Delivery fee before shipping discounts and waivers. Shown on the first render (no drip pricing). */
  readonly deliveryFee: Money;
  /** What the shopper pays for delivery after waivers and shipping promotions. */
  readonly shipping: Money;
  readonly freeDeliveryReason: "plus" | "threshold" | "promotion" | "none";
  readonly vat: Money;
  /** merchandise - discounts + shipping. */
  readonly total: Money;
}

export interface TenderPlan {
  readonly storeCredit: readonly { readonly sub: StoreCreditSub; readonly amount: Money }[];
  readonly storeCreditTotal: Money;
  /** Remainder due through one external method (or cash on delivery). */
  readonly externalDue: Money;
}

export interface CheckoutQuote {
  readonly method: CheckoutMethod;
  readonly lines: readonly QuoteLine[];
  readonly stores: readonly StoreQuote[];
  readonly subtotal: Money;
  readonly discount: Money;
  readonly shipping: Money;
  readonly vat: Money;
  readonly total: Money;
  readonly tender: TenderPlan;
  readonly vatBps: bigint;
}
