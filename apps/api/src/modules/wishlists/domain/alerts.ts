import { LIMITS, type Money, type Wishlist, type WishlistItem } from "./types";
import { cairoDate, daysUntil } from "./wishlist";

export const ALERT_TYPES = ["price_drop_verified", "back_in_size", "low_stock", "date_approaching"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/**
 * Signals from catalog and pricing integrity. There is deliberately no "plain price cut"
 * signal: price-drop alerts exist only for verified reductions (spec section 8, 9).
 */
export type CatalogSignal =
  | { readonly kind: "verified_price_drop"; readonly eventId: string; readonly productId: string; readonly newPrice: Money; readonly claimId: string }
  | { readonly kind: "back_in_size"; readonly eventId: string; readonly productId: string; readonly skuId: string }
  | { readonly kind: "stock_level"; readonly eventId: string; readonly productId: string; readonly skuId: string; readonly available: number };

export interface PlannedAlert {
  readonly alertType: AlertType;
  readonly wishlistId: string;
  readonly itemId: string | null;
  readonly userId: string;
  readonly productId: string | null;
  readonly skuId: string | null;
  readonly daysBefore: number | null;
  readonly dedupeKey: string;
}

export function planSignalAlert(signal: CatalogSignal, item: WishlistItem): PlannedAlert | null {
  if (item.productId !== signal.productId) return null;
  const base = { wishlistId: item.wishlistId, itemId: item.id, userId: item.userId, productId: item.productId, daysBefore: null };
  switch (signal.kind) {
    case "verified_price_drop": {
      if (signal.newPrice.currency !== item.addedPrice.currency) return null;
      if (signal.newPrice.amount >= item.addedPrice.amount) return null;
      return { ...base, alertType: "price_drop_verified", skuId: null, dedupeKey: `price_drop:${item.id}:${signal.claimId}` };
    }
    case "back_in_size": {
      if (item.skuPref === null || item.skuPref !== signal.skuId) return null;
      return { ...base, alertType: "back_in_size", skuId: signal.skuId, dedupeKey: `back_in_size:${item.id}:${signal.eventId}` };
    }
    case "stock_level": {
      if (item.skuPref !== null && item.skuPref !== signal.skuId) return null;
      if (!Number.isInteger(signal.available) || signal.available < 1 || signal.available > LIMITS.lowStockMax) return null;
      return {
        ...base,
        alertType: "low_stock",
        skuId: signal.skuId,
        dedupeKey: `low_stock:${item.id}:${signal.skuId}:${signal.eventId}`,
      };
    }
  }
}

/** Date alerts for one list at `nowMs`: exactly 7 and exactly 1 Cairo calendar days ahead. */
export function planDateAlerts(list: Wishlist, nowMs: number): PlannedAlert[] {
  const today = cairoDate(nowMs);
  const dates = new Set<string>();
  if (list.targetDate !== null) dates.add(list.targetDate);
  const giftDate = list.giftFor?.date ?? null;
  if (giftDate !== null) dates.add(giftDate);
  const out: PlannedAlert[] = [];
  for (const date of [...dates].sort()) {
    const d = daysUntil(date, today);
    if (d === null || !LIMITS.dateAlertDays.includes(d)) continue;
    out.push({
      alertType: "date_approaching",
      wishlistId: list.id,
      itemId: null,
      userId: list.userId,
      productId: null,
      skuId: null,
      daysBefore: d,
      dedupeKey: `date:${list.id}:${date}:${d}`,
    });
  }
  return out;
}
