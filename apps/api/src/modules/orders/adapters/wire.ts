import {
  buyerViewForSeller,
  commissionFor,
  isCancellable,
  subtract,
  type Money,
} from "../domain/bridge";
import type {
  LocalizedText,
  OrderGroupRecord,
  OrderLineRecord,
  SellerOrderRecord,
  StoreSummaryFacts,
} from "../domain/ports";

const iso = (ms: number): string => new Date(ms).toISOString();
const text = (t: LocalizedText) => ({ ar: t.ar, ...(t.en !== undefined ? { en: t.en } : {}) });

export function moneyWire(m: Money): { amount: string; currency: "EGP" } {
  return { amount: m.amount.toString(), currency: m.currency };
}

function lineWire(l: OrderLineRecord) {
  return {
    id: l.id,
    sku_id: l.skuId,
    title: text(l.title),
    ...(l.sizeLabel !== null ? { size_label: l.sizeLabel } : {}),
    qty: l.qty,
    unit_price: moneyWire(l.unitPrice),
    discount_alloc: moneyWire(l.discountAlloc),
    vat: moneyWire(l.vat),
    return_eligible_until: null,
  };
}

/** SellerOrderView: what the seller sees. Buyer data passes through `buyerViewForSeller` only. */
export function sellerOrderViewWire(o: SellerOrderRecord, nowMs: number) {
  const commission = commissionFor(o.subtotal, o.commissionRateBps);
  const buyer =
    o.buyer === null
      ? null
      : buyerViewForSeller(
          o.buyer,
          { status: o.status, deliveredAtMs: o.deliveredAtMs, closedAtMs: o.closedAtMs },
          nowMs,
        );
  return {
    id: o.id,
    status: o.status,
    lines: o.lines.map(lineWire),
    subtotal: moneyWire(o.subtotal),
    shipping: moneyWire(o.shipping),
    commission: moneyWire(commission),
    net_to_seller: moneyWire(subtract(o.subtotal, commission)),
    ...(buyer === null
      ? {}
      : {
          buyer: {
            governorate_code: buyer.governorateCode,
            ...(buyer.firstName !== undefined ? { first_name: buyer.firstName } : {}),
            ...(buyer.phoneRelay !== undefined ? { phone_relay: buyer.phoneRelay } : {}),
            address_visible: buyer.addressVisible,
          },
        }),
    // accept_by is always set at intake (only paid or COD-confirmed orders reach sellers).
    accept_by: iso(o.acceptByMs ?? o.createdAtMs),
    ...(o.dispatchByMs !== null ? { dispatch_by: iso(o.dispatchByMs) } : {}),
    payment_type: o.paymentType,
    created_at: iso(o.createdAtMs),
  };
}

function storeWire(id: string, facts: StoreSummaryFacts | undefined) {
  return {
    id,
    slug: facts?.slug ?? id,
    name: text(facts?.name ?? { ar: "" }),
    kind: facts?.kind ?? ("local" as const),
    verified_badge: facts?.verifiedBadge ?? false,
    max_verified_discount_pct: null,
    rating: null,
    rating_count: 0,
    follower_count: 0,
    live_drop: false,
    is_favorite: false,
  };
}

/** SellerOrder: the shopper's view of one store's part of the order. No buyer block, no commission. */
export function shopperSellerOrderWire(o: SellerOrderRecord, stores: ReadonlyMap<string, StoreSummaryFacts>) {
  return {
    id: o.id,
    order_group_id: o.orderGroupId,
    store: storeWire(o.storeId, stores.get(o.storeId)),
    status: o.status,
    lines: o.lines.map(lineWire),
    subtotal: moneyWire(o.subtotal),
    shipping: moneyWire(o.shipping),
    discount: moneyWire(o.discount),
    vat: moneyWire(o.vat),
    total: moneyWire(o.total),
    shipment: null,
    cancellable: isCancellable(o.status),
    created_at: iso(o.createdAtMs),
  };
}

export function orderGroupWire(g: OrderGroupRecord, stores: ReadonlyMap<string, StoreSummaryFacts>) {
  return {
    id: g.id,
    status: g.status.toLowerCase(),
    payment_method: g.paymentMethod,
    seller_orders: g.sellerOrders.map((o) => shopperSellerOrderWire(o, stores)),
    subtotal: moneyWire(g.subtotal),
    shipping_total: moneyWire(g.shipping),
    discount_total: moneyWire(g.discount),
    vat_total: moneyWire(g.vat),
    store_credit_applied: moneyWire(g.storeCredit),
    total_paid_or_due: moneyWire(g.total),
    payment_window_expires_at: null,
    created_at: iso(g.createdAtMs),
    updated_at: iso(g.updatedAtMs),
  };
}
