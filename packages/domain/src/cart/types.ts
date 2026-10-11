import type { Money } from "../money";

export const MAX_CART_LINES = 50;
export const MAX_UNITS_PER_SKU = 10;
/** ADR-0010 default: 2,000 EGP in piastres, merchandise subtotal, per store. */
export const DEFAULT_FREE_DELIVERY_THRESHOLD_PIASTRES = 200_000n;

export type LineState = "IN_BAG" | "SAVED_FOR_LATER";
export type PriceChange = "none" | "dropped" | "rose";
export type GroupStatus = "open" | "locked_store_suspended";

/** One bag line joined with live catalog facts. Prices are the catalog price after item discounts. */
export interface BagLineInput {
  readonly lineId: string;
  readonly skuId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly unitPrice: Money;
  readonly priceAtAdd: Money;
  readonly state: LineState;
  readonly available: boolean;
}

export interface StoreTerms {
  readonly open: boolean;
  /** Per-store override; null falls back to the platform threshold. */
  readonly thresholdOverride: Money | null;
  readonly standardDeliveryFee: Money;
}

export interface PricedLine extends BagLineInput {
  readonly lineTotal: Money;
  readonly priceChange: PriceChange;
  /** True when the line is counted toward the subtotal. */
  readonly counted: boolean;
}

export interface FreeDelivery {
  readonly threshold: Money;
  readonly remaining: Money;
  readonly unlocked: boolean;
  readonly plusMember: boolean;
}

export interface PricedGroup {
  readonly storeId: string;
  readonly status: GroupStatus;
  readonly lines: readonly PricedLine[];
  readonly merchandiseSubtotal: Money;
  readonly freeDelivery: FreeDelivery;
  /** Delivery fee for this parcel: 0 when unlocked, Plus, or nothing billable. */
  readonly deliveryFee: Money;
}
