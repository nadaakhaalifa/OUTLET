import type { HubTracking } from "../api/schemas-phase2";
import type { Locale, MessageKey } from "../i18n";
import { formatInt, formatMoney } from "../lib/format";

const STATUS = new Set(["waiting", "consolidating", "dispatched", "in_transit", "delivered"]);

export interface HubVM {
  readonly orderGroupId: string;
  readonly deliveryFee: string;
  readonly waiting: string;
  readonly hasWaiting: boolean;
  readonly parcels: readonly { readonly id: string; readonly statusKey: MessageKey; readonly awb: string | null; readonly courier: string | null; readonly orders: string; readonly fee: string }[];
}

export function hubRows(h: HubTracking, locale: Locale): HubVM {
  return {
    orderGroupId: h.order_group_id,
    deliveryFee: formatMoney(h.delivery_fee_piastres, locale),
    waiting: formatInt(h.waiting_seller_orders, locale),
    hasWaiting: h.waiting_seller_orders > 0,
    parcels: h.parcels.map((p) => ({
      id: p.id,
      statusKey: STATUS.has(p.status) ? (`hub.status.${p.status}` as MessageKey) : "hub.status.unknown",
      awb: p.awb,
      courier: p.courier,
      orders: formatInt(p.seller_order_count, locale),
      fee: formatMoney(p.fee_charged_piastres, locale),
    })),
  };
}
