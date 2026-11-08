import { contextClient } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { InboxProcessor } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import { PayoutsError } from "../domain/errors.js";
import type { ConsumedEvent } from "./availability-mover.js";
import type { FinanceDeps } from "./shared.js";

export const DISPUTE_OPENED_CONSUMER = "payouts.dispute_opened";
export const DISPUTE_RESOLVED_CONSUMER = "payouts.dispute_resolved";
export const DISPUTE_OPENED_EVENT = "dispute.opened";
export const DISPUTE_RESOLVED_EVENT = "dispute.resolved";

/** Payload of `dispute.opened` and `dispute.resolved` (B2). The returns module emits it; payouts owns the contract. */
export const DisputeEventPayload = z.object({
  seller_order_id: z.uuid(),
  store_id: z.uuid(),
  market_id: z.string().min(1),
  dispute_id: z.uuid(),
});
export type DisputeEventPayload = z.infer<typeof DisputeEventPayload>;

/**
 * Turns dispute events into payout holds (reason 'dispute', scoped to the disputed seller order, source_ref = dispute id) so the accrual
 * of a disputed order is never paid out while the dispute is open; eligibility already honours holds. Runs through the inbox: a redelivery
 * is a no-op. Re-emission of the same dispute under a new message id is absorbed by the unique (reason, source_ref) key, and a `resolved`
 * that arrives before its `opened` leaves an already-released tombstone so the late `opened` cannot hold the order forever.
 */
export class DisputeHolds {
  constructor(private readonly deps: FinanceDeps) {}

  private inbox(marketId: string): InboxProcessor {
    return new InboxProcessor(contextClient(this.deps.client, { kind: "worker", marketId, job: "finance.payouts" }));
  }

  private parse(e: ConsumedEvent): DisputeEventPayload {
    const p = DisputeEventPayload.safeParse(e.payload);
    if (!p.success) throw new PayoutsError("INVALID_INPUT", `${e.type} payload is invalid`);
    if (p.data.market_id !== e.marketId) throw new PayoutsError("INVALID_INPUT", `${e.type} market does not match the event`);
    return p.data;
  }

  async onDisputeOpened(e: ConsumedEvent): Promise<InboxOutcome> {
    const p = this.parse(e);
    return this.inbox(e.marketId).process(DISPUTE_OPENED_CONSUMER, e.id, (tx) => this.insert(tx, p, null));
  }

  async onDisputeResolved(e: ConsumedEvent): Promise<InboxOutcome> {
    const p = this.parse(e);
    return this.inbox(e.marketId).process(DISPUTE_RESOLVED_CONSUMER, e.id, async (tx) => {
      const now = this.deps.now();
      const r = await tx.query("UPDATE payout_holds SET released_at = $2::timestamptz WHERE reason = 'dispute' AND source_ref = $1 AND released_at IS NULL RETURNING id", [p.dispute_id, now.toISOString()]);
      if (r.rows.length === 0) await this.insert(tx, p, now);
    });
  }

  private async insert(tx: Queryable, p: DisputeEventPayload, releasedAt: Date | null): Promise<void> {
    const now = this.deps.now();
    await tx.query(
      `INSERT INTO payout_holds (id, store_id, market_id, reason, seller_order_id, source_ref, starts_at, released_at)
       VALUES ($1, $2, $3, 'dispute', $4, $5, $6::timestamptz, $7::timestamptz) ON CONFLICT (source_ref) WHERE reason = 'dispute' DO NOTHING`,
      [uuidv7(), p.store_id, p.market_id, p.seller_order_id, p.dispute_id, now.toISOString(), releasedAt === null ? null : releasedAt.toISOString()],
    );
  }
}
