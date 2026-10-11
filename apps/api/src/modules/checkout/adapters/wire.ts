import type { CheckoutQuote, Money } from "../domain/bridge";
import type { ClientAction, SagaRecord } from "../domain/ports";
import type { QuoteOk } from "../application/quote";

export const moneyWire = (m: Money): { amount: string; currency: "EGP" } => ({
  amount: m.amount.toString(),
  currency: m.currency,
});

const iso = (ms: number): string => new Date(ms).toISOString();

export function clientActionWire(a: ClientAction) {
  switch (a.type) {
    case "none":
      return { type: "none" as const };
    case "redirect":
      return { type: "redirect" as const, url: a.url };
    case "sdk":
      return { type: "sdk" as const, sdk: a.sdk, token: a.token };
    case "fawry_reference":
      return { type: "fawry_reference" as const, reference: a.reference, expires_at: iso(a.expiresAtMs) };
    case "await_confirmation":
      return { type: "await_confirmation" as const, channel: a.channel };
  }
}

function quoteBody(q: CheckoutQuote) {
  return {
    method: q.method,
    lines: q.lines.map((l) => ({
      line_id: l.lineId,
      sku_id: l.skuId,
      store_id: l.storeId,
      qty: l.qty,
      unit_price: moneyWire(l.unitPrice),
      discount: moneyWire(l.discount),
      vat: moneyWire(l.vat),
    })),
    stores: q.stores.map((s) => ({
      store_id: s.storeId,
      merchandise: moneyWire(s.merchandise),
      discount: moneyWire({ amount: s.platformFundedDiscount.amount + s.sellerFundedDiscount.amount, currency: "EGP" }),
      delivery_fee: moneyWire(s.deliveryFee),
      shipping: moneyWire(s.shipping),
      free_delivery_reason: s.freeDeliveryReason,
      vat: moneyWire(s.vat),
      total: moneyWire(s.total),
    })),
    subtotal: moneyWire(q.subtotal),
    discount_total: moneyWire(q.discount),
    shipping_total: moneyWire(q.shipping),
    vat_total: moneyWire(q.vat),
    total: moneyWire(q.total),
    store_credit_applied: moneyWire(q.tender.storeCreditTotal),
    amount_due: moneyWire(q.tender.externalDue),
  };
}

export function quoteWire(q: QuoteOk) {
  return {
    ...quoteBody(q.quote),
    plus_member: q.plusMember,
    methods: q.methods.map((m) => ({
      method: m.method,
      available: m.available,
      ...(m.reason !== undefined ? { reason: m.reason } : {}),
      ...(m.provider !== undefined ? { provider: m.provider } : {}),
    })),
    unavailable_lines: q.unavailable.map((u) => ({ line_id: u.lineId, reason: u.reason })),
    price_lock: { token: q.lockToken, expires_at: iso(q.lockExpiresAtMs) },
  };
}

export function sagaWire(r: SagaRecord, clientAction?: ClientAction) {
  const f = r.facts;
  return {
    order_group_id: r.orderGroupId,
    status: f.status.toLowerCase(),
    method: f.method,
    total: moneyWire(r.stored.quote.total),
    store_credit_applied: moneyWire({ amount: f.creditAmount, currency: "EGP" }),
    amount_due: moneyWire({ amount: f.externalDue, currency: "EGP" }),
    client_action: clientActionWire(clientAction ?? r.clientAction ?? { type: "none" }),
    payment_expires_at: f.reservationExpiresAtMs === null ? null : iso(f.reservationExpiresAtMs),
    created_at: iso(r.createdAtMs),
  };
}
