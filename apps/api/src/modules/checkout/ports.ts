import type { CheckoutService, ClientAction, PspCode, WebhookProcessor } from "@outlet/checkout";

/** First gate of the PSP webhook route: the provider's published source addresses. The HMAC is the second gate, not a replacement. */
export interface WebhookIpPolicy {
  allowed(provider: string, ip: string): boolean;
}

/** Deny everything: the production default until the owner configures the provider's address list (ADR-0029). */
export const denyAllWebhookIps: WebhookIpPolicy = { allowed: () => false };

/** Fixed allow-list per provider (exact addresses, as seen after trusted-proxy resolution). */
export const staticWebhookIps = (byProvider: Readonly<Record<string, readonly string[]>>): WebhookIpPolicy => ({
  allowed: (provider, ip) => Object.hasOwn(byProvider, provider) && (byProvider[provider] ?? []).includes(ip),
});

/** Verifies the one-time code sent to the shopper (WhatsApp / SMS / IVR) for a cash-on-delivery order. */
export interface CodConfirmationPort {
  verify(input: { readonly userId: string; readonly orderGroupId: string; readonly code: string }): Promise<boolean>;
}

/** No code channel is configured, so no code is ever valid: COD orders cannot be confirmed by guessing (fail closed). */
export const unconfiguredCodConfirmation: CodConfirmationPort = { verify: () => Promise.resolve(false) };

export interface MoneyMinor {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export interface OrderGroupSummaryRow {
  readonly id: string;
  readonly status: string;
  readonly total: MoneyMinor;
  readonly storeCount: number;
  readonly placedAt: Date;
}

export interface OrderGroupDetail {
  readonly id: string;
  readonly status: string;
  readonly currency: string;
  readonly itemsSubtotal: MoneyMinor;
  readonly discount: MoneyMinor;
  readonly shipping: MoneyMinor;
  readonly vat: MoneyMinor;
  readonly storeCredit: MoneyMinor;
  readonly total: MoneyMinor;
  readonly paymentMethod: string;
  readonly paymentStatus: string;
  readonly clientAction: ClientAction | null;
  readonly placedAt: Date;
  readonly paidAt: Date | null;
  readonly paymentExpiresAt: Date | null;
  readonly sellerOrders: readonly {
    readonly id: string;
    readonly storeId: string;
    readonly storeNameAr: string;
    readonly status: string;
    readonly itemsSubtotal: MoneyMinor;
    readonly shipping: MoneyMinor;
    readonly vat: MoneyMinor;
    readonly total: MoneyMinor;
    readonly lines: readonly { readonly id: string; readonly skuId: string; readonly titleAr: string; readonly qty: number; readonly unitPrice: MoneyMinor }[];
  }[];
}

/** Shopper's own orders (outlet_app, user context): a foreign id is invisible under RLS and reads as null. */
export interface OrderGroupReaderPort {
  list(userId: string, page: { readonly limit: number; readonly cursor?: string; readonly status?: string }): Promise<{ readonly items: readonly OrderGroupSummaryRow[]; readonly nextCursor: string | null }>;
  detail(userId: string, id: string): Promise<OrderGroupDetail | null>;
}

export interface CheckoutServices {
  readonly checkout: Pick<CheckoutService, "quote" | "place" | "confirmCod">;
  /** Worker-role job `payments.webhook`. */
  readonly webhooks: Pick<WebhookProcessor, "handle">;
  readonly orders: OrderGroupReaderPort;
  readonly cod: CodConfirmationPort;
  /** The one PSP wired for this market; a webhook for another provider is 404. */
  readonly provider: PspCode;
}
