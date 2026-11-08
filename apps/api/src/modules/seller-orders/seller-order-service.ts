import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { OrderStateError, SELLER_ORDER, can, transition } from "@outlet/orders";
import type { SellerOrderState } from "@outlet/orders";
import type { OutboxWriter } from "@outlet/outbox";
import { authorize } from "@outlet/policy";
import type { Action, Principal } from "@outlet/policy";
import { buyerPiiVisible } from "@outlet/seller-accounts";
import type { StructuredAddress } from "@outlet/shipping";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { ProblemError, Problems } from "../../platform/problem.js";
import { ORDER_ACTIONS } from "./dto.js";
import type { RejectInput, SellerOrder, SellerOrderSummaryPage, SellerOrdersQuery, Shipment, ShipmentCreateInput } from "./dto.js";
import type { SellerOrdersServicesDeps } from "./ports.js";

type Big = string | bigint;
type Action4 = (typeof ORDER_ACTIONS)[number];

interface OrderRow {
  id: string; order_group_id: string; user_id: string; status: SellerOrderState; currency: string;
  items_subtotal_minor: Big; platform_discount_minor: Big; seller_discount_minor: Big; shipping_minor: Big; vat_minor: Big; total_minor: Big;
  commission_bp_snapshot: number; commission_minor: Big; accept_by: Date | null; dispatch_by: Date | null; delivered_at: Date | null;
  return_window_ends_at: Date | null; version: number; created_at: Date;
}
interface LineRow {
  id: string; sku_id: string; product_id: string; title_ar_snapshot: string; title_en_snapshot: string | null; condition_grade_snapshot: string; qty: number; unit_price_minor: Big;
  platform_discount_minor: Big; seller_discount_minor: Big; vat_rate_bp: number; vat_minor: Big; claim_type_snapshot: string; status: string;
}

/** Dispatch SLA from acceptance (master prompt 19: 48 h, configurable). Exposed as a field, not enforced yet. */
export const DISPATCH_SLA_MS = 48 * 60 * 60 * 1000;

const SELECT_ORDER = `SELECT id, order_group_id, user_id, status, currency, items_subtotal_minor, platform_discount_minor, seller_discount_minor, shipping_minor, vat_minor, total_minor,
  commission_bp_snapshot, commission_minor, accept_by, dispatch_by, delivered_at, return_window_ends_at, version, created_at FROM seller_orders`;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const money = (v: Big, currency: string): { amount_minor: string; currency: string } => ({ amount_minor: BigInt(v).toString(), currency });

export const maskPhone = (phone: string): string => (phone.length <= 5 ? "•".repeat(phone.length) : `${phone.slice(0, 3)}${"•".repeat(phone.length - 5)}${phone.slice(-2)}`);

const actionsOf = (status: SellerOrderState): Action4[] => ORDER_ACTIONS.filter((a) => can(SELLER_ORDER, status, a));

const wireAddress = (a: StructuredAddress): NonNullable<SellerOrder["delivery"]>["address"] => ({
  governorate_code: a.governorateCode, city_code: a.cityCode ?? null, district_code: a.districtCode ?? null, street: a.street, building: a.building,
  floor: a.floor ?? null, apartment: a.apartment ?? null, landmark: a.landmark ?? null,
});

export interface SellerOrderServiceDeps extends SellerOrdersServicesDeps {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly outbox: OutboxWriter;
}

/**
 * Seller-side order handling. Every statement runs in the store's own database context (RLS: a foreign order is invisible and
 * reads as 404). Each state change goes through the @outlet/orders SELLER_ORDER machine and writes its outbox event in the
 * same transaction. The shopper's user id never leaves this class.
 */
export class SellerOrderService {
  constructor(private readonly d: SellerOrderServiceDeps) {}

  private access(actor: Principal, action: Action, storeId: string): void {
    if (actor.kind !== "seller_staff") throw Problems.forbidden();
    const r = authorize(actor, action, { type: "order", storeId, marketId: this.d.marketId });
    if (r.effect === "deny") throw r.reason === "not_found" ? Problems.notFound() : Problems.forbidden();
  }

  private store<T>(storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "store", marketId: this.d.marketId, storeId }, fn);
  }

  async list(actor: Principal, storeId: string, q: SellerOrdersQuery): Promise<SellerOrderSummaryPage> {
    this.access(actor, "order.read", storeId);
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, 2);
    const rows = await this.store(storeId, async (tx) =>
      (
        await tx.query<OrderRow>(
          `${SELECT_ORDER}
            WHERE store_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz) AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
              AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
            ORDER BY created_at DESC, id DESC LIMIT $7`,
          [storeId, q.status ?? null, q.from ?? null, q.to ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
        )
      ).rows,
    );
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({ id: r.id, status: r.status, total: money(r.total_minor, r.currency), accept_by: iso(r.accept_by), dispatch_by: iso(r.dispatch_by), created_at: r.created_at.toISOString(), available_actions: actionsOf(r.status) })),
      next_cursor: rows.length > q.limit && last !== undefined ? encodeCursor(last.created_at.toISOString(), last.id) : null,
      server_time: this.d.now().toISOString(),
    };
  }

  async get(actor: Principal, storeId: string, id: string): Promise<SellerOrder> {
    this.access(actor, "order.read", storeId);
    const { o, lines } = await this.store(storeId, async (tx) => {
      const o = (await tx.query<OrderRow>(`${SELECT_ORDER} WHERE id = $1 AND store_id = $2`, [id, storeId])).rows[0];
      if (o === undefined) throw Problems.notFound();
      const lines = (
        await tx.query<LineRow>(
          `SELECT id, sku_id, product_id, title_ar_snapshot, title_en_snapshot, condition_grade_snapshot, qty, unit_price_minor, platform_discount_minor, seller_discount_minor, vat_rate_bp, vat_minor, claim_type_snapshot, status
             FROM order_lines WHERE seller_order_id = $1 ORDER BY id`,
          [id],
        )
      ).rows;
      return { o, lines };
    });
    const kind = await this.d.paymentKinds.kindOf({ userId: o.user_id, orderGroupId: o.order_group_id });
    const dv = await this.d.delivery.forSellerOrder({ storeId, sellerOrderId: id });
    const now = this.d.now();
    const visible = dv !== null && buyerPiiVisible({ orderState: o.status, sellerAccessUntil: dv.accessUntil, now });
    const c = o.currency;
    return {
      id: o.id, status: o.status, version: o.version,
      items_subtotal: money(o.items_subtotal_minor, c), seller_discount: money(o.seller_discount_minor, c), platform_discount: money(o.platform_discount_minor, c),
      shipping: money(o.shipping_minor, c), vat: money(o.vat_minor, c), total: money(o.total_minor, c),
      commission_bp_snapshot: o.commission_bp_snapshot, commission: money(o.commission_minor, c), payment_kind: kind,
      accept_by: iso(o.accept_by), dispatch_by: iso(o.dispatch_by), delivered_at: iso(o.delivered_at), return_window_ends_at: iso(o.return_window_ends_at),
      lines: lines.map((l) => ({
        id: l.id, sku_id: l.sku_id, product_id: l.product_id, title_ar_snapshot: l.title_ar_snapshot, title_en_snapshot: l.title_en_snapshot, condition_grade_snapshot: l.condition_grade_snapshot,
        qty: l.qty, unit_price: money(l.unit_price_minor, c), platform_discount: money(l.platform_discount_minor, c), seller_discount: money(l.seller_discount_minor, c),
        vat_rate_bp: l.vat_rate_bp, vat: money(l.vat_minor, c), claim_type_snapshot: l.claim_type_snapshot, status: l.status,
      })),
      delivery: visible ? { recipient_name: dv.recipientName, phone_masked: maskPhone(dv.phone), address: wireAddress(dv.address), access_until: iso(dv.accessUntil) } : null,
      available_actions: actionsOf(o.status),
      created_at: o.created_at.toISOString(), server_time: now.toISOString(),
    };
  }

  accept(actor: Principal, storeId: string, id: string): Promise<SellerOrder> {
    return this.move(actor, storeId, id, "accept", "seller_order.accepted", (now) => ({ dispatchBy: new Date(now.getTime() + DISPATCH_SLA_MS) }));
  }

  reject(actor: Principal, storeId: string, id: string, input: RejectInput): Promise<SellerOrder> {
    return this.move(actor, storeId, id, "reject", "seller_order.rejected", () => ({ cancelReason: input.reason_code }), { reason_code: input.reason_code, has_note: input.note !== undefined && input.note.length > 0 });
  }

  pack(actor: Principal, storeId: string, id: string): Promise<SellerOrder> {
    return this.move(actor, storeId, id, "pack", "seller_order.packed", () => ({}));
  }

  /**
   * Hands the parcel to the courier and moves PACKED to SHIPPED. The courier call is idempotent on the shipment id (= the seller
   * order id, Phase 1 is one shipment per order) and runs outside the database transaction, so no lock is held across the network.
   */
  async ship(actor: Principal, storeId: string, input: ShipmentCreateInput): Promise<Shipment> {
    this.access(actor, "order.fulfill", storeId);
    const id = input.seller_order_ids[0];
    if (id === undefined) throw Problems.validation([{ path: "/body/seller_order_ids", code: "too_small" }]);
    const o = await this.store(storeId, async (tx) => {
      const r = (await tx.query<OrderRow>(`${SELECT_ORDER} WHERE id = $1 AND store_id = $2`, [id, storeId])).rows[0];
      if (r === undefined) throw Problems.notFound();
      return r;
    });
    if (!can(SELLER_ORDER, o.status, "ship")) throw Problems.conflict("invalid-transition");
    const kind = await this.d.paymentKinds.kindOf({ userId: o.user_id, orderGroupId: o.order_group_id });
    if (kind === null) throw Problems.unavailable("payment-kind-unavailable");
    const dv = await this.d.delivery.forSellerOrder({ storeId, sellerOrderId: id });
    if (dv === null || !buyerPiiVisible({ orderState: o.status, sellerAccessUntil: dv.accessUntil, now: this.d.now() })) throw Problems.conflict("delivery-data-unavailable");
    const dims = input.length_mm !== undefined && input.width_mm !== undefined && input.height_mm !== undefined ? { lengthMm: input.length_mm, widthMm: input.width_mm, heightMm: input.height_mm } : undefined;
    let created;
    try {
      created = await this.d.courier.createShipment({
        shipmentId: id, courier: this.d.courierCode, serviceLevel: this.d.serviceLevel,
        parcels: [{ weightG: input.declared_weight_g, ...(dims === undefined ? {} : { dimsMm: dims }) }],
        destination: dv.address, codMinor: kind === "cod" ? BigInt(o.total_minor) : 0n,
      });
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      throw Problems.unavailable("courier-unavailable");
    }
    await this.move(actor, storeId, id, "ship", "seller_order.shipped", () => ({}), { awb: created.awb, courier: created.courier });
    return { id, seller_order_id: id, status: "CREATED", courier_code: created.courier, awb: created.awb, label_url: null, created_at: this.d.now().toISOString() };
  }

  private async move(
    actor: Principal, storeId: string, id: string, event: Action4, eventType: string,
    patch: (now: Date) => { dispatchBy?: Date; cancelReason?: string }, payload: Record<string, string | boolean> = {},
  ): Promise<SellerOrder> {
    this.access(actor, "order.fulfill", storeId);
    const now = this.d.now();
    await this.store(storeId, async (tx) => {
      const o = (await tx.query<OrderRow>(`${SELECT_ORDER} WHERE id = $1 AND store_id = $2 FOR UPDATE`, [id, storeId])).rows[0];
      if (o === undefined) throw Problems.notFound();
      let next: SellerOrderState;
      try {
        next = transition(SELLER_ORDER, o.status, event);
      } catch (e) {
        if (e instanceof OrderStateError) throw Problems.conflict("invalid-transition");
        throw e;
      }
      const p = patch(now);
      await tx.query(
        `UPDATE seller_orders SET status = $2, dispatch_by = COALESCE($3::timestamptz, dispatch_by), cancel_reason = COALESCE($4, cancel_reason), version = version + 1, updated_at = $5::timestamptz WHERE id = $1`,
        [id, next, p.dispatchBy?.toISOString() ?? null, p.cancelReason ?? null, now.toISOString()],
      );
      if (event === "reject") await tx.query("UPDATE order_lines SET status = 'cancelled' WHERE seller_order_id = $1 AND status = 'active'", [id]);
      await this.d.outbox.append(tx, {
        id: this.d.newId(), type: eventType, aggregateType: "seller_order", aggregateId: id, marketId: this.d.marketId, occurredAt: now.toISOString(), visibility: "internal",
        payload: { seller_order_id: id, user_id: o.user_id, market_id: this.d.marketId, occurred_at: now.toISOString(), order_group_id: o.order_group_id, store_id: storeId, from: o.status, to: next, total_minor: BigInt(o.total_minor).toString(), currency: o.currency, ...payload },
      });
    });
    return this.get(actor, storeId, id);
  }
}
