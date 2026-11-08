import type { Money } from "@outlet/money";

/** Return policy facts owned elsewhere (catalog category rules, size availability, Plus membership). */
export interface ReturnPolicyPort {
  /** Sku ids in a CPL-excluded category (hygiene, personalised). Disclosed on the PDP and at checkout. */
  nonReturnable(skuIds: readonly string[]): Promise<ReadonlySet<string>>;
  /** An alternative size of the sku is in stock now (exchange-first, section 22). */
  sizeSwapAvailable(skuId: string): Promise<boolean>;
  isPlusMember(userId: string): Promise<boolean>;
}

/** Return photos. Shopper uploads are not a media_assets kind yet, so evidence is a logical reference verified by this port (@outlet/media pipeline behind it). */
export interface EvidencePort {
  /** True when every media id is a scanned, ready asset the shopper uploaded. */
  allReady(mediaIds: readonly string[], userId: string): Promise<boolean>;
}

export type RestockDecision = "restock" | "relist_open_box" | "write_off" | "donate";
export interface RestockPort {
  /** Idempotent per key. Only `restock` changes stock; the others are recorded decisions (defect grading). */
  apply(req: { readonly storeId: string; readonly skuId: string; readonly qty: number; readonly decision: RestockDecision; readonly idempotencyKey: string }): Promise<void>;
}

export type ProviderRefundResult =
  | { readonly outcome: "accepted"; readonly providerRef: string }
  | { readonly outcome: "retryable"; readonly code: string }
  | { readonly outcome: "rejected"; readonly code: string };

/**
 * Provider-side refund / loan cancellation. @outlet/checkout RefundPort only knows three reasons (late payment, seller rejection,
 * cancellation), so returns use this wider port; a production adapter wraps the same PSP / BNPL client and stays Unconfigured
 * (fails closed) until the contract is signed (V4, V5).
 */
export interface ProviderRefundPort {
  /** The PSP can reverse a wallet / InstaPay payment to its source (false = bank transfer instead). */
  canReverse(method: string): boolean;
  refund(req: {
    readonly refundId: string;
    readonly orderGroupId: string;
    readonly paymentIntentId: string;
    readonly route: "psp_original" | "bnpl_provider";
    readonly amount: Money;
    readonly idempotencyKey: string;
  }): Promise<ProviderRefundResult>;
}

/** Money kill switches. Fails closed: return true ("engaged") when the flag store cannot be read. Key used: refunds.enabled. */
export interface KillSwitchPort {
  isEngaged(key: string): Promise<boolean>;
}

export const REFUNDS_KILL_SWITCH = "refunds.enabled";
