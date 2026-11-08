import type { MessageKey, Translator } from "@outlet/i18n";

const KEYS: Readonly<Record<string, MessageKey>> = {
  PENDING_PAYMENT: "seller.orders.status.PENDING_PAYMENT",
  PAID: "seller.orders.status.PAID",
  CONFIRMED_COD: "seller.orders.status.CONFIRMED_COD",
  VOIDED: "seller.orders.status.VOIDED",
  ACCEPTED: "seller.orders.status.ACCEPTED",
  PACKED: "seller.orders.status.PACKED",
  SHIPPED: "seller.orders.status.SHIPPED",
  OUT_FOR_DELIVERY: "seller.orders.status.OUT_FOR_DELIVERY",
  DELIVERED: "seller.orders.status.DELIVERED",
  CLOSED: "seller.orders.status.CLOSED",
  CANCELLED: "seller.orders.status.CANCELLED",
  REJECTED_BY_SELLER: "seller.orders.status.REJECTED_BY_SELLER",
  DELIVERY_FAILED: "seller.orders.status.DELIVERY_FAILED",
  RTO: "seller.orders.status.RTO",
  RETURNED_TO_SELLER: "seller.orders.status.RETURNED_TO_SELLER",
  DISPUTED: "seller.orders.status.DISPUTED",
};

/** "Needs you" states use the warning tone; failures use the critical tone. Colour is never the only signal: the label is always text. */
const TONE = (s: string): "action" | "bad" | "plain" => (s === "PAID" || s === "CONFIRMED_COD" ? "action" : ["CANCELLED", "REJECTED_BY_SELLER", "DELIVERY_FAILED", "RTO", "DISPUTED", "VOIDED"].includes(s) ? "bad" : "plain");

export function StatusChip({ t, status }: { t: Translator; status: string }) {
  const key = KEYS[status];
  return (
    <span className="chip" data-tone={TONE(status)} data-status={status}>
      {key === undefined ? status : t(key)}
    </span>
  );
}
