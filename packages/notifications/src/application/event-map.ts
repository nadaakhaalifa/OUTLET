import { formatMoney } from "@outlet/i18n";
import type { Locale } from "@outlet/i18n";
import { CURRENCIES, money } from "@outlet/money";
import type { Currency } from "@outlet/money";
import type { OutboxEvent } from "@outlet/outbox";
import type { TemplateVars } from "../domain/render.js";

export interface EventNotification {
  readonly templateCode: string;
  /** Variables for the user's locale (amounts are formatted per locale). */
  vars(locale: Locale): TemplateVars;
}

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
      return { templateCode: "order_placed", vars: (l) => amountVars(e.payload, "total_minor", l) };
    case "order_group.paid":
      return { templateCode: "order_paid", vars: (l) => amountVars(e.payload, "total_minor", l) };
    case "seller_order.shipped":
      return { templateCode: "order_shipped", vars: () => ({}) };
    case "seller_order.delivered":
      return { templateCode: "order_delivered", vars: () => ({}) };
    case "refund.completed":
      return { templateCode: "refund_completed", vars: (l) => amountVars(e.payload, "amount_minor", l) };
    case "return.received":
      return { templateCode: "return_received", vars: () => ({}) };
    default:
      return null;
  }
};

export const NOTIFYING_EVENT_TYPES = [
  "order_group.placed",
  "order_group.paid",
  "seller_order.shipped",
  "seller_order.delivered",
  "refund.completed",
  "return.received",
] as const;
