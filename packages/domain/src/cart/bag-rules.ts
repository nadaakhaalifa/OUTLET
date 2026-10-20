import { InvalidCartInputError } from "./errors";
import { MAX_CART_LINES, MAX_UNITS_PER_SKU, type LineState } from "./types";

export interface ExistingLine {
  readonly lineId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly state: LineState;
}

export type AddPlan =
  | { readonly kind: "create"; readonly qty: number }
  | { readonly kind: "merge"; readonly lineId: string; readonly qty: number }
  | { readonly kind: "rejected"; readonly reason: "line_limit_reached" | "sku_unit_limit_reached" };

function assertQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1 || qty > MAX_UNITS_PER_SKU) {
    throw new InvalidCartInputError(`qty must be an integer between 1 and ${MAX_UNITS_PER_SKU}`);
  }
}

/** Decides how an add lands. One line per SKU; merged quantity is capped at 10; 50 lines total. */
export function planAdd(existing: readonly ExistingLine[], skuId: string, qty: number): AddPlan {
  assertQty(qty);
  const same = existing.find((l) => l.skuId === skuId);
  if (same !== undefined) {
    const merged = same.qty + qty;
    return merged > MAX_UNITS_PER_SKU
      ? { kind: "rejected", reason: "sku_unit_limit_reached" }
      : { kind: "merge", lineId: same.lineId, qty: merged };
  }
  return existing.length >= MAX_CART_LINES
    ? { kind: "rejected", reason: "line_limit_reached" }
    : { kind: "create", qty };
}

export function validateQty(qty: number): number {
  assertQty(qty);
  return qty;
}
