import { formatMoney } from "@outlet/i18n";
import type { Locale } from "@outlet/i18n";
import { CURRENCIES, money } from "@outlet/money";
import type { Currency } from "@outlet/money";
import type { OutboxEvent } from "@outlet/outbox";
import type { TemplateVars } from "../domain/render.js";

/** Who receives the notice: the shopper named by `payload.user_id`, or the active order-handling members of `payload.store_id`. */
export type Audience = "payload_user" | "store_members";

export interface EventNotification {
  readonly templateCode: string;
  readonly audience: Audience;
  /** Set when the copy names the store (`store_name` variable, resolved by the dispatcher in the user's locale). */
  readonly needsStoreName?: boolean;
  /** Variables for the user's locale (amounts are formatted per locale). */
  vars(locale: Locale): TemplateVars;
}

/** Short, stable order reference shown to the store: the first 8 characters of the seller order id, upper case. */
const orderRef = (payload: OutboxEvent["payload"]): TemplateVars => {
  const id = payload.seller_order_id;
  return { order_ref: typeof id === "string" && id.length >= 8 ? id.slice(0, 8).toUpperCase() : "-" };
};

/** Cancellations the store did not cause itself. A seller cancellation already reaches the shopper as `order_group.cancelled`. */
const SHOPPER_SIDE_INITIATORS: readonly unknown[] = ["shopper", "system"];

const isCurrency = (c: unknown): c is Currency => typeof c === "string" && (CURRENCIES as readonly string[]).includes(c);

const amountVars = (payload: OutboxEvent["payload"], key: string, locale: Locale): TemplateVars => {
  const raw = payload[key];
  const cur = payload.currency;
  if ((typeof raw !== "string" && typeof raw !== "number") || !/^\d+$/.test(String(raw)) || !isCurrency(cur)) return {};
  return { amount: formatMoney(money(BigInt(raw), cur), locale) };
};

/** Domain event type -> transactional template. Events not listed produce no notification. */
export const mapEvent = (e: OutboxEvent): EventNotification | null => {
  switch (e.type) {
    case "order_group.placed":
      return { templateCode: "order_placed", audience: "payload_user", vars: (l) => amountVars(e.payload, "total_minor", l) };
    case "order_group.paid":
      return { templateCode: "order_paid", audience: "payload_user", vars: (l) => amountVars(e.payload, "total_minor", l) };
    case "order_group.cancelled":
      return { templateCode: "order_cancelled", audience: "payload_user", vars: () => ({}) };
    case "seller_order.shipped":
      return { templateCode: "order_shipped", audience: "payload_user", vars: () => ({}) };
    case "seller_order.delivered":
      return { templateCode: "order_delivered", audience: "payload_user", vars: () => ({}) };
    case "refund.completed":
      return { templateCode: "refund_completed", audience: "payload_user", vars: (l) => amountVars(e.payload, "amount_minor", l) };
    case "return.received":
      return { templateCode: "return_received", audience: "payload_user", vars: () => ({}) };
    case "seller_order.cancelled":
      // Seller-side notice only when the shopper (or the system) cancelled; no reason, no amount.
      return SHOPPER_SIDE_INITIATORS.includes(e.payload.initiator)
        ? { templateCode: "seller_order_cancelled_by_shopper", audience: "store_members", vars: () => orderRef(e.payload) }
        : null;
    case "seller_order.rejected":
      // The seller rejection does not emit order_group.cancelled, so the shopper is told here (partial or whole).
      return { templateCode: "order_item_cancelled_by_seller", audience: "payload_user", needsStoreName: true, vars: () => ({}) };
    default:
      return null;
  }
};

export const NOTIFYING_EVENT_TYPES = [
  "order_group.placed",
  "order_group.paid",
  "order_group.cancelled",
  "seller_order.shipped",
  "seller_order.delivered",
  "refund.completed",
  "return.received",
  "seller_order.cancelled",
  "seller_order.rejected",
] as const;
