import type { Quote, PriceDelta } from "./types.js";

export type CheckoutErrorCode =
  | "quote-token-invalid"
  | "quote-expired"
  | "price-changed"
  | "stock-shortfall"
  | "method-unavailable"
  | "address-not-found"
  | "empty-bag"
  | "idempotency-conflict"
  | "credit-insufficient"
  | "cod-credit-unsupported"
  | "cod-not-allowed"
  | "store-not-onboarded"
  | "payment-declined"
  | "psp-unavailable"
  | "not-found"
  | "invalid-state"
  | "webhook-rejected"
  | "invalid-quantity";

/** `status` is the HTTP status the API layer maps to (Problem+JSON type = code). */
const STATUS: Readonly<Record<CheckoutErrorCode, number>> = {
  "quote-token-invalid": 422,
  "quote-expired": 409,
  "price-changed": 409,
  "stock-shortfall": 409,
  "method-unavailable": 403,
  "address-not-found": 404,
  "empty-bag": 422,
  "idempotency-conflict": 422,
  "credit-insufficient": 422,
  "cod-credit-unsupported": 422,
  "cod-not-allowed": 403,
  "store-not-onboarded": 409,
  "payment-declined": 402,
  "psp-unavailable": 503,
  "not-found": 404,
  "invalid-state": 409,
  "webhook-rejected": 400,
  "invalid-quantity": 422,
};

export interface CheckoutErrorDetails {
  readonly deltas?: readonly PriceDelta[];
  readonly fresh?: Quote;
  readonly shortfalls?: readonly { readonly skuId: string; readonly locationId: string; readonly requested: number; readonly available: number }[];
  readonly riskDecision?: string;
}

export class CheckoutError extends Error {
  readonly status: number;
  /** `statusOverride` is for the few places where one code maps to two HTTP statuses (quote-token-invalid: 422 forged, 409 already used). */
  constructor(readonly code: CheckoutErrorCode, message: string, readonly details: CheckoutErrorDetails = {}, statusOverride?: number) {
    super(message);
    this.name = "CheckoutError";
    this.status = statusOverride ?? STATUS[code];
  }
}

/** Invariant I13: the seller residual (base - commission - commission VAT) must not be negative. */
export class SellerNetError extends Error {
  readonly code = "seller-net-negative";
  constructor(readonly storeId: string, readonly netMinor: bigint) {
    super(`seller net would be negative for store ${storeId}`);
    this.name = "SellerNetError";
  }
}
