import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { z } from "zod";

export const REJECTED_INVENTORY_CONSUMER = "checkout.rejected_inventory_release";
export const INVENTORY_RELEASE_REQUIRED_EVENT = "inventory.release_required";

const payload = z.object({ seller_order_id: z.uuid(), user_id: z.uuid(), order_group_id: z.uuid(), store_id: z.uuid() });

export type ReleaseOutcome = "processed" | "duplicate";

/**
 * Inbox consumer of `seller_order.rejected` (at-least-once, idempotent). A rejected order was PAID, so its stock is a CLAIMED unit:
 * the reservation is one per order group (it may also hold other stores' lines) and a claimed unit cannot be un-claimed by
 * ReservationService (ADR-0005: claimed rows are archived, `committed` counts them). The consumer therefore does not touch inventory;
 * it emits `inventory.release_required` with the cancelled lines so the inventory module (or the owning seller's stock adjustment)
 * returns `committed`. The inbox row and the event commit together. Runs as outlet_worker in job shipping.tracking narrowed to the owner.
 */
export class RejectedOrderInventoryRelease {
  private readonly outbox: OutboxWriter;
  constructor(
    private readonly client: RoleSqlClient<"outlet_worker">,
    private readonly marketId: string,
    opts: { readonly outbox?: OutboxWriter; readonly now?: () => Date; readonly newId?: () => string } = {},
  ) {
    this.outbox = opts.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => uuidv7());
  }
  private readonly now: () => Date;
  private readonly newId: () => string;

  async handle(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<ReleaseOutcome> {
    const p = payload.parse(event.payload);
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "shipping.tracking", userId: p.user_id }, async (tx) => {
      const seen = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [REJECTED_INVENTORY_CONSUMER, event.id]);
      if (seen.rows.length === 0) return "duplicate";
      const g = (await tx.query<{ reservation_id: string | null }>("SELECT reservation_id FROM order_groups WHERE id = $1", [p.order_group_id])).rows[0];
      const lines = (await tx.query<{ sku_id: string; qty: number }>("SELECT sku_id, qty FROM order_lines WHERE seller_order_id = $1 ORDER BY id", [p.seller_order_id])).rows;
      const at = this.now().toISOString();
      await this.outbox.append(tx, {
        id: this.newId(), type: INVENTORY_RELEASE_REQUIRED_EVENT, aggregateType: "seller_order", aggregateId: p.seller_order_id, marketId: this.marketId, occurredAt: at, visibility: "internal",
        payload: {
          seller_order_id: p.seller_order_id, order_group_id: p.order_group_id, store_id: p.store_id, user_id: p.user_id, market_id: this.marketId, reservation_id: g?.reservation_id ?? null,
          lines: lines.map((l) => ({ sku_id: l.sku_id, qty: l.qty })), occurred_at: at,
        },
      });
      return "processed";
    });
  }
}
