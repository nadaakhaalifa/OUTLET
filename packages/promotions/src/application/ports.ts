import type { RoleSqlClient } from "@outlet/db";

/** Kill switch `promotions.enabled` (register in @outlet/flags later). Unknown state must read as disabled (fail closed). */
export interface KillSwitchPort { isEnabled(): Promise<boolean> }

export type AbuseVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: "device_flagged" | "phone_unverified" | "multi_account" };
/** Device fingerprint, phone verification and the multi-account graph live behind this port (risk module). */
export interface AbuseSignalsPort {
  assess(input: { readonly userId: string; readonly deviceId: string | null; readonly promotionId: string }): Promise<AbuseVerdict>;
}

/**
 * Attempt budget for entered voucher codes (per user and per device), consulted by VoucherService.resolveCode before any lookup.
 * `consume` returns false once the caller is over budget. The API layer MUST also rate-limit the code-entry route (Redis token bucket, per user,
 * device and IP): this port is the in-package second line, not the only one. Backed by the rate limiter in the composition root.
 */
export interface CodeResolutionBudget {
  consume(input: { readonly userId: string; readonly deviceId: string | null }): Promise<boolean>;
}

/**
 * Orders module fact for reinstatement: every seller order of the group is CANCELLED and none had shipped. `userId` is the shopper the
 * voucher service acts for: a shopper-scoped implementation answers only for that shopper's own groups (anything else reads as false).
 */
export interface OrderFactsPort { wholeOrderCancelledBeforeShipping(orderGroupId: string, userId: string): Promise<boolean> }

export interface AuditPort {
  append(input: {
    marketId: string; actorType: "staff" | "seller"; actorId: string | null; action: string; targetType: string; targetId: string;
    diff: { before?: unknown; after?: unknown } | null; ipHash: string | null; deviceId: string | null; requestId: string | null;
  }): Promise<unknown>;
}

export interface PromotionsDeps {
  /** Connection as outlet_app (ADR-0011). Every call binds its own context. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly kill: KillSwitchPort;
  readonly audit?: AuditPort;
  readonly abuse?: AbuseSignalsPort;
  readonly orderFacts?: OrderFactsPort;
  readonly codeBudget?: CodeResolutionBudget;
  /** HMAC key for unique voucher codes (from the secret store) */
  readonly hmacKey?: Uint8Array;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** max reservations per shopper per rolling hour (velocity rule), default 5 */
  readonly velocityPerHour?: number;
}
