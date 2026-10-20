import type { PriceEvent } from "./domain";

/** Wire shape consumed by auto-buy (PriceChangedSchema): decimal-string piastres, ISO time. */
export function priceChangedEvent(event: PriceEvent, s: { verified: boolean; anomaly: boolean }) {
  return {
    aggregateType: "price",
    aggregateId: event.skuId,
    eventType: "price.changed",
    payload: {
      event_id: event.id,
      sku_id: event.skuId,
      price: { amount: event.priceAmount.toString(), currency: "EGP" },
      verified: s.verified,
      anomaly: s.anomaly,
      occurred_at: new Date(event.validFromMs).toISOString(),
    },
  } as const;
}
