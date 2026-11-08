import type { RoleSqlClient } from "@outlet/db";

/** Kill switch `promotions.enabled` (register in @outlet/flags later). Unknown state must read as disabled (fail closed). */
export interface KillSwitchPort { isEnabled(): Promise<boolean> }

export type AbuseVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: "device_flagged" | "phone_unverified" | "multi_account" };
/** Device fingerprint, phone verification and the multi-account graph live behind this port (risk module). */
export interface AbuseSignalsPort {
  assess(input: { readonly userId: string; readonly deviceId: string | null; readonly promotionId: string }): Promise<AbuseVerdict>;
}

/** Orders module fact for reinstatement: every seller order of the group is CANCELLED and none had shipped. */
export interface OrderFactsPort { wholeOrderCancelledBeforeShipping(orderGroupId: string): Promise<boolean> }

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
  /** HMAC key for unique voucher codes (from the secret store) */
  readonly hmacKey?: Uint8Array;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** max reservations per shopper per rolling hour (velocity rule), default 5 */
  readonly velocityPerHour?: number;
}
