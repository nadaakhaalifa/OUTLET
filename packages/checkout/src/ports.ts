/**
 * Checkout ports (hexagonal adapters). Contracts only: the builder implements the application services and the fakes
 * against these (packages/checkout/README.md section 7). No real PSP, courier or risk vendor is called from this package;
 * production adapters stay Unconfigured and fail closed until the owner signs the provider contract (D5 = Paymob, V4/V41).
 */
import type { Queryable } from "@outlet/db";
import type { Money } from "@outlet/money";
import type { AppliedPromotion, EvalBag, EvalContext, QuoteEvaluation } from "@outlet/promotions";
import type { AddressService } from "@outlet/shipping";

// ------------------------------------------------------------------ shared vocabulary
export const PAYMENT_METHODS = ["card", "apple_pay", "meeza", "wallet", "instapay", "fawry", "bnpl", "cod", "store_credit"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Methods paid through a PSP intent (everything except COD and store-credit-only). */
export type ExternalMethod = Exclude<PaymentMethod, "cod" | "store_credit">;
export type PspCode = "paymob" | "kashier" | "fawry" | "fake";

/** Reservation TTL class per method (ReservationService ttlPolicy). Seconds come from CheckoutConfig. */
export type HoldWindow = "card" | "wallet" | "fawry" | "cod";

/** What the client must do next. Card data never reaches us (PCI SAQ A): only hosted pages, iframes or PSP SDK tokens. */
export type ClientAction =
  | { readonly kind: "redirect"; readonly url: string }
  | { readonly kind: "iframe"; readonly url: string }
  | { readonly kind: "sdk"; readonly provider: PspCode; readonly clientToken: string }
  | { readonly kind: "fawry_reference"; readonly reference: string; readonly expiresAt: string }
  | { readonly kind: "instapay_request"; readonly reference: string; readonly expiresAt: string }
  | { readonly kind: "cod_confirmation"; readonly channel: "whatsapp" | "sms" | "ivr"; readonly expiresAt: string }
  | { readonly kind: "none" };

// ------------------------------------------------------------------ PaymentProviderPort (Paymob drop-in, D5 split model A)
/** One instruction per seller order: what the PSP should route to the seller's sub-merchant account (model A). */
export interface SplitInstruction {
  readonly sellerOrderId: string;
  readonly storeId: string;
  /** PSP sub-merchant reference from psp_merchant_accounts; null until the store is onboarded (fail closed: no split, no intent). */
  readonly subMerchantRef: string | null;
  /** Seller residual (I13): merchandise - commission - commission VAT. */
  readonly sellerAmount: Money;
  /** Platform share kept on the platform account: commission + commission VAT + delivery fee. */
  readonly platformAmount: Money;
}

export interface CreateIntentRequest {
  /** Our payment_intents.id, sent as the merchant reference and echoed by the webhook. */
  readonly paymentIntentId: string;
  readonly orderGroupId: string;
  readonly marketId: string;
  readonly method: ExternalMethod;
  readonly bnplProvider?: string;
  /** External amount only (total minus store credit). */
  readonly amount: Money;
  readonly split: readonly SplitInstruction[];
  /** Billing data the PSP requires (Paymob billing_data). Decrypted just for this call; adapters must never log it. */
  readonly billing: { readonly firstName: string; readonly lastName: string; readonly phoneE164: string; readonly email: string | null };
  readonly locale: "ar" | "en";
  readonly returnUrl: string;
  readonly expiresAt: Date;
}

export type CreateIntentResult =
  | { readonly ok: true; readonly providerRef: string; readonly clientAction: ClientAction; readonly status: "requires_action" | "authorized" | "captured" }
  | { readonly ok: false; readonly retryable: boolean; readonly code: string };

export interface NormalizedPaymentEvent {
  readonly providerEventId: string;
  readonly type: "payment.succeeded" | "payment.failed" | "payment.pending" | "payment.voided" | "refund.succeeded" | "refund.failed" | "unknown";
  /** Our payment_intents.id when the provider echoes the merchant reference. */
  readonly merchantReference: string | null;
  readonly providerRef: string;
  readonly amount: Money;
  readonly occurredAt: Date | null;
  readonly failureCode: string | null;
  readonly threeDs: boolean | null;
}

export interface WebhookInput {
  readonly rawBody: Uint8Array;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  /** Paymob puts its HMAC in the query string (transaction callback); other PSPs use a header. */
  readonly query: Readonly<Record<string, string>>;
  readonly receivedAt: Date;
}

export type WebhookVerification =
  | { readonly ok: true; readonly event: NormalizedPaymentEvent }
  | { readonly ok: false; readonly reason: "bad_signature" | "stale_timestamp" | "malformed" };

export interface PaymentProviderPort {
  readonly provider: PspCode;
  supports(method: ExternalMethod): boolean;
  /** PSP idempotency key = order_group_id (master prompt section 7 step 4). Timeout 10 s, at most 3 idempotent retries. */
  createIntent(req: CreateIntentRequest, idempotencyKey: string): Promise<CreateIntentResult>;
  /** Compensation. `already_captured` means the money moved: the caller follows the payment.succeeded path instead. */
  voidIntent(ref: { readonly paymentIntentId: string; readonly providerRef: string | null }, idempotencyKey: string): Promise<{ readonly outcome: "voided" | "already_captured" | "not_found" }>;
  /**
   * Pure and synchronous over bytes: provider-specific signature scheme (Paymob: HMAC-SHA512 over ordered fields;
   * others: HMAC over the raw body + timestamp within +/- 5 min). Constant-time compare. Never parses before verifying.
   */
  verifyWebhook(input: WebhookInput): WebhookVerification;
}

/** Refunds are ports only in this step (master prompt 15.6; RefundRouter lands with returns). */
export interface RefundPort {
  requestRefund(req: {
    readonly orderGroupId: string;
    readonly paymentIntentId: string;
    readonly amount: Money;
    readonly reason: "late_payment_unavailable" | "seller_rejected" | "cancelled";
    readonly idempotencyKey: string;
  }): Promise<{ readonly accepted: boolean }>;
}

// ------------------------------------------------------------------ other adapters
/** Real implementation lands in packages/shipping (0017). Fees are VAT-inclusive (B2C). */
export interface ShippingQuotePort {
  quote(req: {
    readonly marketId: string;
    readonly storeId: string;
    readonly addressRef: string;
    /** Destination geo area of the owned address (AddressPort.resolve): the real shipping adapter prices by area, not by the opaque ref. */
    readonly geoAreaId?: string;
    readonly itemsSubtotal: Money;
    readonly parcels: readonly { readonly skuId: string; readonly qty: number }[];
  }): Promise<{ readonly quoteRef: string; readonly fee: Money; readonly etaDaysMin: number; readonly etaDaysMax: number; readonly serviceLevel: string } | { readonly unavailable: true; readonly reason: string }>;
}

/** Owned-address check (body_refs_owned) and the delivery data needed for billing. not_found = 404, never 403. */
export interface AddressPort {
  resolve(userId: string, addressRef: string): Promise<{ readonly geoAreaId: string; readonly countryCode: string; /** landmark + map pin present (master prompt 20.7); absent is treated as not eligible */ readonly codEligible?: boolean } | null>;
}

export type RiskDecision = "allow" | "require_confirmation" | "require_prepayment" | "prepaid_only" | "limit_value" | "block";
export interface RiskPort {
  assessCod(req: { readonly userId: string; readonly marketId: string; readonly total: Money; readonly addressRef: string; readonly storeCount: number }): Promise<{ readonly decision: RiskDecision; readonly reasonCodes: readonly string[] }>;
}

/** Commission resolved from the seller plan (D1 open: rate is configuration, never code). */
export interface CommissionPort {
  rateFor(storeId: string, at: Date): Promise<{ readonly bp: number; readonly planId: string | null }>;
}

/** Tax category per sku (catalog has no tax column yet; default "standard"). */
export interface TaxCategoryPort {
  categoriesFor(skuIds: readonly string[]): Promise<ReadonlyMap<string, "standard" | "zero_rated" | "exempt" | "reduced">>;
}

/**
 * Store credit (closed loop, ADR-0003). Holds are ledger_holds rows, never pending postings. `hold` and `release` run in
 * the caller's transaction (shopper user context at placement; narrowed worker context at expiry / webhook).
 */
export interface StoreCreditPort {
  /** Spendable = derived ledger balance of the user's store_credit sub-balances minus HELD holds. */
  available(tx: Queryable, userId: string, marketId: string): Promise<Money>;
  /** Spend order: soonest-expiring first, refund_credit last (15.2). Returns one hold per sub-balance used. */
  hold(tx: Queryable, req: { readonly userId: string; readonly marketId: string; readonly orderGroupId: string; readonly amount: Money; readonly expiresAt: Date }): Promise<readonly { readonly holdId: string; readonly accountCode: string; readonly amount: Money }[]>;
  release(tx: Queryable, orderGroupId: string, status: "RELEASED" | "EXPIRED"): Promise<number>;
  /** Currently HELD holds of the group with their ledger account code (the debit side of the order_paid entry). */
  heldFor(tx: Queryable, orderGroupId: string): Promise<readonly { readonly accountCode: string; readonly amount: Money }[]>;
  /** Marks holds CAPTURED with the order_paid entry id; the postings themselves are part of that entry. */
  markCaptured(tx: Queryable, orderGroupId: string, entryId: string): Promise<number>;
}

/** Signs and verifies the 10-minute quote token (HMAC-SHA256, key from the secrets manager). Quote stays pure. */
export interface QuoteTokenPort {
  sign(payload: { readonly jti: string; readonly userId: string; readonly marketId: string; readonly quoteHash: string; readonly method: PaymentMethod; readonly expiresAt: Date }): string;
  verify(token: string): { readonly jti: string; readonly userId: string; readonly marketId: string; readonly quoteHash: string; readonly method: PaymentMethod; readonly expiresAt: Date } | null;
}

/** P2 raw-body encryption (same contract as auth-core FieldCipher; aad 'payment_events_raw.body_ct'). */
export interface RawBodyCipher {
  encrypt(plaintext: Uint8Array, aad: string): Promise<Uint8Array>;
}

/** Market configuration (config_entries); every value is admin-editable with audit, never code. */
export interface CheckoutConfig {
  readonly fundsFlow: "psp_split" | "collect_payout";
  readonly provider: PspCode;
  readonly priceLockSec: number; // 600
  readonly holdWindowSec: Readonly<Record<HoldWindow, number>>; // card 600, wallet 1800, fawry 86400, cod 7200
  readonly methodWindow: Readonly<Record<PaymentMethod, HoldWindow>>;
  /** Fixed per-method fee shown on the FIRST quote (no drip pricing). Default 0 for every method. */
  readonly methodFee: Readonly<Record<PaymentMethod, Money>>;
  readonly shippingTaxBp: number; // 1400
  readonly commissionVatBp: number; // 1400
  readonly sellerAcceptSlaSec: number; // 86400
  readonly codMaxFirstOrder: Money; // 1,500 EGP (20.7)
}

// ------------------------------------------------------------------ added by the builder (application wiring)
/**
 * Money kill switches (packages/flags KILL_SWITCHES). Fails closed: an implementation that cannot read the store must return
 * true ("engaged"). Keys: payments.card.enabled, payments.apple_pay.enabled, payments.meeza.enabled, payments.mobile_wallet.enabled,
 * payments.instapay.enabled, payments.fawry.enabled, payments.bnpl.enabled, payments.cod.enabled, payments.store_credit.enabled.
 */
export interface KillSwitchPort {
  isEngaged(key: string): Promise<boolean>;
}

/** Verified reference price at the moment of the line (PriceSnapshotService.snapshotForOrderLine satisfies this structurally). */
export interface PriceSnapshotPort {
  snapshotForOrderLine(skuId: string): Promise<{
    readonly vrp: Money | null;
    readonly evidenceIds: readonly string[];
    readonly claimType: "verified_discount" | "lowest_30d" | "launch_price" | "plain";
  }>;
}

/** PSP sub-merchant reference per store (psp_merchant_accounts, split model A). null = store not onboarded: placement fails closed. */
export interface SubMerchantPort {
  refFor(storeId: string): Promise<string | null>;
}

/** Billing data for the PSP call only (decrypted from users P3 fields by the adapter; never stored, never logged). */
export interface BillingPort {
  billingFor(userId: string): Promise<CreateIntentRequest["billing"]>;
}

/**
 * Promotions seen by checkout (structurally PromotionEvaluator.evaluateForQuote + VoucherService.reserve/confirm/release; see makePromotionsPort).
 * reserve is idempotent by (order group, promotion). Checkout never reads budget, wellbeing or measurement data to build the context.
 */
export interface PromotionsPort {
  evaluateForQuote(bag: EvalBag, ctx: EvalContext, opts?: { readonly codes?: readonly string[] }): Promise<QuoteEvaluation>;
  reserve(userId: string, orderGroupId: string, applied: readonly AppliedPromotion[]): Promise<{ readonly reserved: number; readonly replayed: number }>;
  confirm(userId: string, orderGroupId: string): Promise<number>;
  release(userId: string, orderGroupId: string): Promise<number>;
}

/** Freezes the delivery address for one seller order (AddressService.snapshotForOrder satisfies this). */
export type AddressSnapshotPort = Pick<AddressService, "snapshotForOrder">;
