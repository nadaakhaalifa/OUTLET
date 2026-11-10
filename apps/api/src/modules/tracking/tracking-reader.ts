import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { ShipmentRow, TrackingReaderPort } from "./services.js";

interface Row { id: string; seller_order_ids: string[]; courier: string; awb: string | null; status: string; attempts: number; delivered_at: Date | null; last_event_at: Date | null }

export class TrackingReader implements TrackingReaderPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  async forOrderGroup(userId: string, orderGroupId: string): Promise<readonly ShipmentRow[] | null> {
    return withDbContext(this.client, { kind: "user", marketId: this.marketId, userId }, async (tx) => {
      const g = (await tx.query<{ id: string }>("SELECT id FROM order_groups WHERE id = $1", [orderGroupId])).rows[0];
      if (g === undefined) return null;
      const rows = (
        await tx.query<Row>(
          `SELECT id, seller_order_ids, courier, awb, status, attempts, delivered_at, last_event_at FROM shipments
            WHERE direction = 'outbound' AND seller_order_ids && ARRAY(SELECT id FROM seller_orders WHERE order_group_id = $1) ORDER BY created_at, id`,
          [orderGroupId],
        )
      ).rows;
      return rows.map((r): ShipmentRow => ({
        id: r.id, sellerOrderIds: r.seller_order_ids, courier: r.courier, awb: r.awb, status: r.status, attempts: r.attempts,
        deliveredAt: r.delivered_at === null ? null : new Date(r.delivered_at), lastEventAt: r.last_event_at === null ? null : new Date(r.last_event_at),
      }));
    });
  }
}
