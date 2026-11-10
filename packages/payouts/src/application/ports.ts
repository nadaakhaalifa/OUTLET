import type { AuditEntryInput } from "@outlet/audit-log";
import type { Money } from "@outlet/money";

/** AuditChain satisfies this structurally (same shape as @outlet/admin-access AuditPort). */
export interface AuditPort {
  append(input: AuditEntryInput): Promise<unknown>;
}

/** What the payout needs to know about where the money goes. The full IBAN (P3) never reaches this module: the rail adapter resolves it by instrumentId. */
export interface PayoutDestination {
  /** seller_bank_accounts.id. */
  readonly instrumentId: string;
  readonly ibanLast4: string;
  readonly accountHolderName: string;
  /** Seller's legal name from KYC; the holder name must match it. */
  readonly legalName: string;
}

export interface PayoutDestinationPort {
  /** null when the store has no verified bank account. */
  resolve(storeId: string): Promise<PayoutDestination | null>;
}

export interface PayoutRailRequest {
  /** payout:{payout_id}:{attempt}: the rail must treat a repeat of the same key as the same transfer. */
  readonly idempotencyKey: string;
  readonly payoutId: string;
  readonly storeId: string;
  readonly amount: Money;
  readonly destination: PayoutDestination;
}
export type PayoutRailResult =
  | { readonly status: "accepted"; readonly provider: string; readonly providerRef: string }
  | { readonly status: "rejected"; readonly code: string };

/** Bank or PSP transfer. Throwing means "unknown outcome": the caller keeps the payout SENT and may retry with the same key. */
export interface PayoutRailPort {
  send(req: PayoutRailRequest): Promise<PayoutRailResult>;
}

/** Fails closed until a provider contract exists (V3, V41; ADR-0029). */
export class UnconfiguredPayoutRail implements PayoutRailPort {
  send(): Promise<PayoutRailResult> {
    return Promise.reject(new Error("payout rail is not configured (ADR-0029: production adapters stay Unconfigured)"));
  }
}
export class UnconfiguredPayoutDestinations implements PayoutDestinationPort {
  resolve(): Promise<PayoutDestination | null> {
    return Promise.resolve(null);
  }
}
