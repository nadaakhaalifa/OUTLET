/**
 * Business numbers shown in seller copy. Copy takes them as ICU placeholders, so they live here, named, and point at the rule that enforces them on the server.
 */

/** Buyer PII stays visible to seller staff this many days after delivery or return closure (master prompt B1). Server: `sellerAccessUntil` in packages/seller-accounts/src/domain/roles.ts. */
export const SELLER_PII_ACCESS_DAYS = 30;

/** Dispatch SLA, counted from acceptance (master prompt 19). Server: `DISPATCH_SLA_MS` in apps/api/src/modules/seller-orders/seller-order-service.ts. */
export const DISPATCH_SLA_HOURS = 48;

/** Parcel weight accepted by the ship action, in grams. Server: `declared_weight_g` in apps/api/src/modules/seller-orders/dto.ts. */
export const PARCEL_WEIGHT_G = { min: 1, max: 30_000 } as const;
