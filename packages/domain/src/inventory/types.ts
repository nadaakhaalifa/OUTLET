/**
 * Inventory domain vocabulary (spec 20.2, 7, ADR-0005, ADR-0011, docs/data-model/inventory.md).
 * Pure data: no clock, no randomness, no I/O. Time is epoch milliseconds supplied by the caller.
 */

export const POOL_KINDS = ["STANDARD", "DROP", "FAWRY"] as const;
export type PoolKind = (typeof POOL_KINDS)[number];

/** Pool kinds a payment-method TTL policy may draw from. DROP stock is selected by the SKU, never by the method. */
export type HoldPoolKind = Exclude<PoolKind, "DROP">;

export const PAYMENT_METHODS = ["CARD", "APPLE_PAY", "MEEZA", "COD", "WALLET", "INSTAPAY", "BNPL", "FAWRY"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const UNIT_STATES = ["AVAILABLE", "RESERVED", "CLAIMED", "WRITTEN_OFF"] as const;
export type UnitState = (typeof UNIT_STATES)[number];

export const RESERVATION_STATUSES = ["ACTIVE", "CLAIMED", "RELEASED", "EXPIRED"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const HOLD_REASONS = [
  "CARD_WINDOW",
  "FAWRY_WINDOW",
  "WALLET_WINDOW",
  "INSTAPAY_WINDOW",
  "BNPL_WINDOW",
  "COD",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Maximum rows materialised per (sku, location, pool), spec 20.2. */
export const POOL_CAP = 1000;
/** Bag rule: max 10 units per SKU (spec 6). One definition, owned by the cart rules. */
export { MAX_UNITS_PER_SKU } from "../cart/types";
/** Bag rule: max 50 lines (spec 6). */
export const MAX_RESERVATION_LINES = 50;
/** Sweeper batch size (spec 20.2). */
export const SWEEP_BATCH = 500;

/** One physical stock location of a SKU within a pool, resolved by the application. */
export interface StockLine {
  readonly skuId: string;
  readonly locationId: string;
  readonly poolId: string;
  readonly storeId: string;
  readonly qty: number;
}

export interface Shortfall {
  readonly skuId: string;
  readonly locationId: string;
  readonly requested: number;
  readonly available: number;
}

/** Stable key of a level or pool. Lowercase uuids, so string order equals uuid byte order. */
export const levelKey = (skuId: string, locationId: string, poolId: string): string =>
  `${skuId}|${locationId}|${poolId}`;

/** Total order used for locking and for the request fingerprint: sku, then location, then pool. */
export const compareLines = (
  a: Pick<StockLine, "skuId" | "locationId" | "poolId">,
  b: Pick<StockLine, "skuId" | "locationId" | "poolId">,
): number => {
  if (a.skuId !== b.skuId) return a.skuId < b.skuId ? -1 : 1;
  if (a.locationId !== b.locationId) return a.locationId < b.locationId ? -1 : 1;
  if (a.poolId !== b.poolId) return a.poolId < b.poolId ? -1 : 1;
  return 0;
};
