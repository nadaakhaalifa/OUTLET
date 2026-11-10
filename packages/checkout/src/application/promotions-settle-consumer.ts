import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import type { PromotionsPort } from "../ports.js";

export const PROMOTIONS_SETTLE_EVENT = "promotions.settle_requested";
export const PROMOTIONS_SETTLE_CONSUMER = "checkout.promotions_settle";
/** Same event type OrderCancellation uses for a failed release / reinstate; here `action` is "confirm". */
export const PROMOTIONS_SETTLE_ATTENTION = "promotions.settle_attention";

const payload = z.object({ order_group_id: z.uuid(), user_id: z.uuid() });

/**
 * Confirms the vouchers of a paid / COD-confirmed group. At-least-once delivery; VoucherService.confirm is idempotent (and skips a group that
 * is already CANCELLED) and the inbox row is written only after it succeeded, so an infrastructure failure leaves the event for redelivery.
 * Inbox reads and writes run as outlet_worker, job `checkout.settle` (migration 0031). The confirm itself runs wherever the PromotionsPort was
 * composed: VoucherService is on outlet_app in the shopper's user context (finding 11), never on this worker connection.
 * A malformed payload fails the same way on every delivery: it is parked (inbox row + `promotions.settle_attention {order_group_id, action,
 * error}` in one transaction) instead of looping, like the refund and shipment-cancel consumers.
 */
export class PromotionsSettleConsumer {
  private readonly outbox: OutboxWriter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(
    private readonly client: RoleSqlClient<"outlet_worker">,
    private readonly marketId: string,
    private readonly promotions: Pick<PromotionsPort, "confirm">,
    opts: { readonly outbox?: OutboxWriter; readonly now?: () => Date; readonly newId?: () => string } = {},
  ) {
    this.outbox = opts.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => uuidv7());
  }

  async handle(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<InboxOutcome> {
    const seen = await this.tx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [PROMOTIONS_SETTLE_CONSUMER, event.id]));
    if (seen.rows.length > 0) return "duplicate";
    const p = payload.safeParse(event.payload);
    if (!p.success) return this.finish(event, "invalid_payload");
    await this.promotions.confirm(p.data.user_id, p.data.order_group_id); // throws: no inbox row, the relay redelivers
    return this.finish(event, null);
  }

  private finish(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }, attention: string | null): Promise<InboxOutcome> {
    return this.tx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [PROMOTIONS_SETTLE_CONSUMER, event.id]);
      if (ins.rows.length === 0) return "duplicate";
      if (attention !== null) {
        const g = event.payload.order_group_id;
        const groupId = typeof g === "string" && z.uuid().safeParse(g).success ? g : null;
        await this.outbox.append(tx, {
          id: this.newId(), type: PROMOTIONS_SETTLE_ATTENTION, aggregateType: "order_group", aggregateId: groupId ?? event.id, marketId: this.marketId, occurredAt: this.now().toISOString(), visibility: "internal",
          payload: { order_group_id: groupId, action: "confirm", error: attention, source_event_id: event.id },
        });
      }
      return "processed";
    });
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "checkout.settle" }, fn);
  }
}
