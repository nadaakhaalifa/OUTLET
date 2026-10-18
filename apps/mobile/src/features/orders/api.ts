import { ApiError, collectPages, dataOf, type schemas } from "../../services/api-client";
import { bilingual, guard, money, pick, toPortError, type AdapterContext } from "../../services/wire";
import type { OrderGroup, OrderGroupState, OrdersPort, SellerOrder, SellerOrderStatus, ShipmentInfo } from "./model";

const GROUP_STATE: Readonly<Record<schemas.OrderGroup["status"], OrderGroupState>> = {
  created: "pending_payment", reserved: "pending_payment", payment_pending: "pending_payment", paid: "paid", confirmed_cod: "confirmed_cod",
  fulfilling: "paid", completed: "paid", expired: "expired", failed: "failed", cancelled: "failed",
};
/** The wire has finer return states than the app's list view; collapse them without losing the happy path. */
const SELLER_STATUS: Readonly<Record<schemas.SellerOrder["status"], SellerOrderStatus>> = {
  PENDING_PAYMENT: "PENDING_PAYMENT", PAID: "PAID", CONFIRMED_COD: "CONFIRMED_COD", ACCEPTED: "ACCEPTED", PACKED: "PACKED",
  SHIPPED: "SHIPPED", OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY", DELIVERED: "DELIVERED", CLOSED: "CLOSED",
  RETURN_REQUESTED: "RETURN_REQUESTED", RETURN_PICKUP_SCHEDULED: "RETURN_REQUESTED", RETURN_IN_TRANSIT: "RETURN_REQUESTED",
  RETURN_RECEIVED: "RETURN_REQUESTED", RETURN_INSPECTED: "RETURN_REQUESTED", REFUNDED: "REFUNDED", RETURN_REJECTED: "DELIVERED",
  CANCELLED: "CANCELLED", REJECTED_BY_SELLER: "REJECTED_BY_SELLER", DELIVERY_FAILED: "DELIVERY_FAILED", RTO: "RTO",
  RETURNED_TO_SELLER: "RETURNED_TO_SELLER", DISPUTED: "DISPUTED",
};

/** GET /v1/me/orders, POST /v1/seller-orders/{id}/cancel. The e-receipt is not on SellerOrder yet (gap), so it is null. */
export class ApiOrdersPort implements OrdersPort {
  constructor(private readonly ctx: AdapterContext) {}

  private shipment(s: schemas.Shipment | null | undefined): ShipmentInfo | null {
    if (s === null || s === undefined) return null;
    return {
      courier: s.courier,
      awb: s.awb ?? "",
      events: s.events.map((e) => ({ status: e.status, label: e.description !== undefined ? bilingual(e.description) : { ar: e.status, en: e.status }, at: e.at })),
      etaAt: s.eta_max ?? null,
    };
  }

  list(): Promise<readonly OrderGroup[]> {
    return guard(async () => {
      const groups = await collectPages((cursor) => this.ctx.client.listMyOrders({ query: { limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }), 10);
      const lang = this.ctx.locale();
      return groups.map((g): OrderGroup => ({
        id: g.id,
        placedAt: g.created_at,
        state: GROUP_STATE[g.status],
        total: money(g.total_paid_or_due),
        sellerOrders: g.seller_orders.map((so): SellerOrder => ({
          id: so.id,
          storeName: pick(so.store.name, lang),
          status: SELLER_STATUS[so.status],
          lines: so.lines.map((l) => ({ id: l.id, title: pick(l.title, lang), qty: l.qty, unitPrice: money(l.unit_price) })),
          total: money(so.total),
          shipment: this.shipment(so.shipment),
          eReceipt: null,
          deliveredAt: so.shipment?.events.find((e) => e.status === "delivered")?.at ?? null,
        })),
      }));
    });
  }

  /** The wire requires a reason the port does not collect (gap): "changed_mind" is sent. */
  async cancel(sellerOrderId: string, idempotencyKey: string): Promise<{ readonly ok: boolean }> {
    try {
      dataOf(await this.ctx.client.cancelSellerOrder({ path: { sellerOrderId }, body: { reason: "changed_mind" } }, { idempotencyKey }));
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) return { ok: false };
      throw toPortError(e);
    }
  }
}
