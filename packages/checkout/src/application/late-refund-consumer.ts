import { InboxProcessor } from "@outlet/outbox";
import type { InboxOutcome, SqlClient } from "@outlet/outbox";
import { CURRENCIES, money } from "@outlet/money";
import { z } from "zod";
import { CheckoutError } from "../domain/errors.js";
import type { RefundPort } from "../ports.js";

export const LATE_REFUND_CONSUMER = "checkout.late_refund";

const payload = z.object({
  order_group_id: z.uuid(),
  payment_intent_id: z.uuid(),
  amount_minor: z.string().regex(/^\d+$/),
  currency: z.enum(CURRENCIES),
  idempotency_key: z.string().min(1),
});

/**
 * C4: the single owner of the late-payment refund request. Consumes the outbox event `order_group.late_payment_refund` (at-least-once)
 * and calls RefundPort with the event's idempotency key (`late_refund:{group}`), so a redelivery or a retry never double-refunds.
 * The network call is outside any transaction; the inbox row is written only AFTER the port accepted, so a failing or rejecting port
 * leaves the event unprocessed for the relay to redeliver (the group stays REFUND_PENDING and the ledger already owes the money).
 */
export class LateRefundConsumer {
  private readonly inbox: InboxProcessor;
  constructor(private readonly db: SqlClient, private readonly refunds: RefundPort) {
    this.inbox = new InboxProcessor(db);
  }

  async handle(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<InboxOutcome> {
    const p = payload.parse(event.payload);
    const seen = await this.db.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [LATE_REFUND_CONSUMER, event.id]);
    if (seen.rows.length > 0) return "duplicate";
    const res = await this.refunds.requestRefund({
      orderGroupId: p.order_group_id, paymentIntentId: p.payment_intent_id, amount: money(BigInt(p.amount_minor), p.currency), reason: "late_payment_unavailable", idempotencyKey: p.idempotency_key,
    });
    if (!res.accepted) throw new CheckoutError("psp-unavailable", "the refund provider did not accept the late-payment refund; the event will be redelivered");
    return this.inbox.process(LATE_REFUND_CONSUMER, event.id, () => Promise.resolve());
  }
}
