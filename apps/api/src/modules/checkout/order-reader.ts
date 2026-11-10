import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { ClientAction } from "@outlet/checkout";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import type { MoneyMinor, OrderGroupDetail, OrderGroupReaderPort, OrderGroupSummaryRow } from "./ports.js";

type Big = string | bigint;
interface GroupRow {
  id: string; status: string; currency: string; items_subtotal_minor: Big; discount_minor: Big; shipping_minor: Big; vat_minor: Big; store_credit_minor: Big; total_minor: Big;
  payment_method: string; placed_at: Date; paid_at: Date | null; payment_expires_at: Date | null;
}
interface SummaryRow { id: string; status: string; currency: string; total_minor: Big; store_count: string | number; placed_at: Date; created_at: Date }
interface SoRow { id: string; store_id: string; name_ar: string | null; status: string; items_subtotal_minor: Big; shipping_minor: Big; vat_minor: Big; total_minor: Big }
interface LineRow { id: string; seller_order_id: string; sku_id: string; title_ar_snapshot: string; qty: number; unit_price_minor: Big }

const m = (v: Big, currency: string): MoneyMinor => ({ amountMinor: BigInt(v), currency });

export class OrderGroupReader implements OrderGroupReaderPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  async list(userId: string, page: { readonly limit: number; readonly cursor?: string; readonly status?: string }): Promise<{ readonly items: readonly OrderGroupSummaryRow[]; readonly nextCursor: string | null }> {
    const after = page.cursor === undefined ? undefined : decodeCursor(page.cursor, 2);
    const rows = await withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) =>
      (
        await tx.query<SummaryRow>(
          `SELECT g.id, g.status, g.currency, g.total_minor, g.placed_at, g.created_at,
                  (SELECT count(*) FROM seller_orders so WHERE so.order_group_id = g.id) AS store_count
             FROM order_groups g
            WHERE g.user_id = $1 AND ($2::text IS NULL OR g.status = $2)
              AND ($3::timestamptz IS NULL OR (g.created_at, g.id) < ($3::timestamptz, $4::uuid))
            ORDER BY g.created_at DESC, g.id DESC LIMIT $5`,
          [userId, page.status ?? null, after?.[0] ?? null, after?.[1] ?? null, page.limit + 1],
        )
      ).rows,
    );
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((r) => ({ id: r.id, status: r.status, total: m(r.total_minor, r.currency), storeCount: Number(r.store_count), placedAt: r.placed_at })),
      nextCursor: rows.length > page.limit && last !== undefined ? encodeCursor(last.created_at.toISOString(), last.id) : null,
    };
  }

  async detail(userId: string, id: string): Promise<OrderGroupDetail | null> {
    return withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) => {
      const g = (
        await tx.query<GroupRow>(
          `SELECT id, status, currency, items_subtotal_minor, discount_minor, shipping_minor, vat_minor, store_credit_minor, total_minor, payment_method, placed_at, paid_at, payment_expires_at
             FROM order_groups WHERE id = $1`,
          [id],
        )
      ).rows[0];
      if (g === undefined) return null;
      const i = (await tx.query<{ status: string; client_action: ClientAction | null }>("SELECT status, client_action FROM payment_intents WHERE order_group_id = $1", [id])).rows[0];
      const sos = (
        await tx.query<SoRow>(
          `SELECT so.id, so.store_id, s.display_name_ar AS name_ar, so.status, so.items_subtotal_minor, so.shipping_minor, so.vat_minor, so.total_minor
             FROM seller_orders so LEFT JOIN catalog_public_stores s ON s.id = so.store_id WHERE so.order_group_id = $1 ORDER BY so.store_id`,
          [id],
        )
      ).rows;
      const lines = (
        await tx.query<LineRow>("SELECT id, seller_order_id, sku_id, title_ar_snapshot, qty, unit_price_minor FROM order_lines WHERE order_group_id = $1 ORDER BY sku_id", [id])
      ).rows;
      const c = g.currency;
      return {
        id: g.id,
        status: g.status,
        currency: c,
        itemsSubtotal: m(g.items_subtotal_minor, c),
        discount: m(g.discount_minor, c),
        shipping: m(g.shipping_minor, c),
        vat: m(g.vat_minor, c),
        storeCredit: m(g.store_credit_minor, c),
        total: m(g.total_minor, c),
        paymentMethod: g.payment_method,
        paymentStatus: i?.status ?? "NOT_REQUIRED",
        clientAction: i?.client_action ?? null,
        placedAt: g.placed_at,
        paidAt: g.paid_at,
        paymentExpiresAt: g.payment_expires_at,
        sellerOrders: sos.map((so) => ({
          id: so.id,
          storeId: so.store_id,
          storeNameAr: so.name_ar ?? "متجر",
          status: so.status,
          itemsSubtotal: m(so.items_subtotal_minor, c),
          shipping: m(so.shipping_minor, c),
          vat: m(so.vat_minor, c),
          total: m(so.total_minor, c),
          lines: lines.filter((l) => l.seller_order_id === so.id).map((l) => ({ id: l.id, skuId: l.sku_id, titleAr: l.title_ar_snapshot, qty: l.qty, unitPrice: m(l.unit_price_minor, c) })),
        })),
      };
    });
  }
}
