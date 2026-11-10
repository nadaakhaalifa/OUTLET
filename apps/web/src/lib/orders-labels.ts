import type { Translator } from "@outlet/i18n";
import { ORDER_STATUSES, RETURN_REASONS, RETURN_STATUSES, SHIPMENT_STATUSES, type ReturnReason } from "./wire";

export const SELLER_STATUSES = ["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CLOSED", "CANCELLED", "REJECTED_BY_SELLER", "DELIVERY_FAILED", "RTO", "RETURNED_TO_SELLER", "DISPUTED"] as const;
export const CANCEL_REASONS = ["changed_mind", "ordered_by_mistake", "delivery_too_slow", "other"] as const;
const isIn = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** Wire statuses are open strings; anything the catalog has no label for gets a neutral one, never the raw code. */
export const orderStatusLabel = (t: Translator, s: string): string => (isIn(ORDER_STATUSES, s) ? t(`checkout.order.status.${s}`) : t("orders.status.unknown"));
export const sellerStatusLabel = (t: Translator, s: string): string => (isIn(SELLER_STATUSES, s) ? t(`orders.sellerStatus.${s}`) : t("orders.sellerStatus.unknown"));
export const trackingLabel = (t: Translator, s: string): string => {
  const up = s.toUpperCase();
  return isIn(SHIPMENT_STATUSES, up) ? t(`orders.tracking.${up}`) : t("orders.tracking.update");
};
export const returnStatusLabel = (t: Translator, s: string): string => (isIn(RETURN_STATUSES, s) ? t(`returns.status.${s}`) : t("orders.status.unknown"));
export const isReturnReason = (s: string): s is ReturnReason => isIn(RETURN_REASONS, s);
export const returnReasonLabel = (t: Translator, s: string): string => (isReturnReason(s) ? t(`returns.reason.${s}`) : t("orders.status.unknown"));
export const cancelReasonLabel = (t: Translator, s: (typeof CANCEL_REASONS)[number]): string => t(`orders.cancel.reason.${s}`);
