import { InboxProcessor } from "@outlet/outbox";
import type { InboxOutcome, SqlClient } from "@outlet/outbox";
import { z } from "zod";
import type { PromotionsPort } from "../ports.js";

export const PROMOTIONS_SETTLE_EVENT = "promotions.settle_requested";
export const PROMOTIONS_SETTLE_CONSUMER = "checkout.promotions_settle";

const payload = z.object({ order_group_id: z.uuid(), user_id: z.uuid() });

/**
 * Confirms the vouchers of a paid / COD-confirmed group. At-least-once delivery; VoucherService.confirm is idempotent and the inbox row is
 * written only after it succeeded, so a failing confirm leaves the event for redelivery.
 */
export class PromotionsSettleConsumer {
  private readonly inbox: InboxProcessor;
  constructor(private readonly db: SqlClient, private readonly promotions: PromotionsPort) {
    this.inbox = new InboxProcessor(db);
  }

  async handle(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<InboxOutcome> {
    const p = payload.parse(event.payload);
    const seen = await this.db.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [PROMOTIONS_SETTLE_CONSUMER, event.id]);
    if (seen.rows.length > 0) return "duplicate";
    await this.promotions.confirm(p.user_id, p.order_group_id);
    return this.inbox.process(PROMOTIONS_SETTLE_CONSUMER, event.id, () => Promise.resolve());
  }
}
