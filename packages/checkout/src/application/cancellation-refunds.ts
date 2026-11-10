import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import { SELLER_ORDER_CANCELLED_EVENT } from "./cancellation.js";

export const CANCELLATION_REFUND_CONSUMER = "checkout.cancellation_refund";
export const SELLER_ORDER_REJECTED_EVENT = "seller_order.rejected";
export const REFUND_ATTENTION_EVENT = "refund.attention";

/**
 * Structurally @outlet/returns RefundService.createForCancellation (finance.refunds worker). Idempotent per seller order.
 * Contract: a NON-retryable domain refusal throws an Error named "ReturnsError" (inconsistent snapshot, not found, ...).
 */
export interface CancellationRefundPort {
  createForCancellation(input: { readonly userId: string; readonly orderGroupId: string; readonly reason: "cancellation" | "seller_rejected" }): Promise<readonly unknown[]>;
}

const payload = z.object({ order_group_id: z.uuid(), user_id: z.uuid() });

/** Domain refusals and malformed payloads fail the same way on every redelivery: park them for finance instead of looping. */
const permanent = (e: unknown): e is Error => e instanceof z.ZodError || (e instanceof Error && e.name === "ReturnsError");

/**
 * Inbox consumer of `seller_order.cancelled` (OrderCancellation, accept timeout) and `seller_order.rejected` (seller rejection): asks the
 * refunds module to create the refund of every cancelled / rejected seller order of the group that has none yet. At-least-once: the inbox row
 * is written only AFTER the port succeeded, so an infrastructure failure leaves the event for redelivery; a duplicate run is harmless (refund
 * key per seller order). M1: a permanent refusal (ReturnsError, ZodError) is recorded instead: `refund.attention {order_group_id,
 * seller_order_id?, error}` is emitted in the same transaction as the inbox row and the event counts as processed (finance resolves it).
 * Other event types are ignored (processed, no effect). Runs as outlet_worker, job finance.refunds (allowed to emit refund events).
 */
export class CancellationRefundConsumer {
  private readonly outbox: OutboxWriter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(
    private readonly client: RoleSqlClient<"outlet_worker">,
    private readonly marketId: string,
    private readonly refunds: CancellationRefundPort,
    opts: { readonly outbox?: OutboxWriter; readonly now?: () => Date; readonly newId?: () => string } = {},
  ) {
    this.outbox = opts.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => uuidv7());
  }

  async handle(event: { readonly id: string; readonly type: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<InboxOutcome> {
    const seen = await this.inTx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [CANCELLATION_REFUND_CONSUMER, event.id]));
    if (seen.rows.length > 0) return "duplicate";
    const reason = event.type === SELLER_ORDER_CANCELLED_EVENT ? "cancellation" : event.type === SELLER_ORDER_REJECTED_EVENT ? "seller_rejected" : null;
    let failure: { readonly error: string; readonly groupId: string | null; readonly sellerOrderId: string | null } | null = null;
    if (reason !== null) {
      try {
        const p = payload.parse(event.payload);
        await this.refunds.createForCancellation({ userId: p.user_id, orderGroupId: p.order_group_id, reason });
      } catch (e) {
        if (!permanent(e)) throw e; // infrastructure: no inbox row, the relay redelivers
        const code = e instanceof z.ZodError ? "invalid_payload" : "code" in e && typeof e.code === "string" ? e.code : e.name;
        const id = (k: string): string | null => {
          const v = event.payload[k];
          return typeof v === "string" && z.uuid().safeParse(v).success ? v : null;
        };
        failure = { error: code, groupId: id("order_group_id"), sellerOrderId: id("seller_order_id") };
      }
    }
    return this.inTx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [CANCELLATION_REFUND_CONSUMER, event.id]);
      if (ins.rows.length === 0) return "duplicate";
      if (failure !== null) {
        await this.outbox.append(tx, {
          id: this.newId(), type: REFUND_ATTENTION_EVENT, aggregateType: "order_group", aggregateId: failure.groupId ?? event.id, marketId: this.marketId, occurredAt: this.now().toISOString(), visibility: "internal",
          payload: { order_group_id: failure.groupId, ...(failure.sellerOrderId === null ? {} : { seller_order_id: failure.sellerOrderId }), error: failure.error, source_event_id: event.id },
        });
      }
      return "processed";
    });
  }

  private inTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "finance.refunds" }, fn);
  }
}
