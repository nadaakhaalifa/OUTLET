import { z } from "zod";
import type { AccrueClosedLine, ApplyLineRefund } from "./commissions";
import type { AttributeOrder } from "./links";

export interface CreatorInboundEvent {
  readonly messageId: string;
  readonly type: string;
  readonly payload: unknown;
  /** Outbox occurred_at, used when the payload carries no time of its own. */
  readonly occurredAtMs?: number;
}

export type CreatorEventResult = "handled" | "duplicate" | "ignored" | "invalid";

/** Outbox event types this consumer owns (the relay routes by these). */
export const CREATOR_CONSUMED_EVENTS = ["order_line.closed", "order_line.refunded", "order_group.paid", "order_group.cod_confirmed"] as const;

/**
 * A message that cannot be settled yet and must be retried by the relay (backoff, DLQ after the
 * configured attempts). Thrown for a HELD attribution: the fraud gate could not run, so accruing
 * now would fail open (A-3). Acknowledging it would lose the commission.
 */
export class CreatorEventDeferredError extends Error {
  override readonly name = "CreatorEventDeferredError";
  constructor(readonly eventType: string) {
    super(`creator event ${eventType} deferred: attribution is held`);
  }
}

const Digits = z.string().regex(/^[0-9]{1,18}$/);
const Uuid = z.uuid();

const LineClosed = z.object({
  order_group_id: Uuid,
  order_line_id: Uuid,
  category_id: z.string().min(1).max(64).nullable().default(null),
  merchandise_gross: Digits,
  voucher_allocated: Digits,
  refunded_merchandise_gross: Digits,
  closed_at_ms: z.number().int().nonnegative(),
  // A-9: absent = unknown = the accrual defers (fail closed).
  return_window_ends_at_ms: z.number().int().nonnegative().nullable().default(null),
  open_returns: z.number().int().nonnegative().nullable().default(null),
});

const LineRefunded = z.object({
  order_line_id: Uuid,
  line_merchandise_gross: Digits.nullable(),
  refunded_merchandise_gross: Digits,
});

const GroupPlaced = z.object({
  order_group_id: Uuid,
  user_id: Uuid,
  paid_at_ms: z.number().int().nonnegative().optional(),
});

/**
 * Relay-facing consumer for the orders, refunds and checkout events. The relay wraps `handle` in
 * the inbox transaction (dedupe by message id); each use case is also idempotent on its own inbox
 * row, so a redelivery has one effect:
 *   order_line.closed        -> AccrueClosedLine   (claim-then-post, unique commission per line)
 *   order_line.refunded      -> ApplyLineRefund    (monotonic refunded base, no double clawback)
 *   order_group.paid / cod   -> AttributeOrder     (one attribution per order group)
 */
export class CreatorEventConsumer {
  constructor(
    private readonly accrue: Pick<AccrueClosedLine, "execute">,
    private readonly refund: Pick<ApplyLineRefund, "execute">,
    private readonly attribute: Pick<AttributeOrder, "execute">,
  ) {}

  async handle(e: CreatorInboundEvent): Promise<CreatorEventResult> {
    switch (e.type) {
      case "order_line.closed": {
        const p = LineClosed.safeParse(e.payload);
        if (!p.success) return "invalid";
        const r = await this.accrue.execute({
          messageId: e.messageId,
          orderGroupId: p.data.order_group_id,
          orderLineId: p.data.order_line_id,
          categoryId: p.data.category_id,
          merchandiseGross: BigInt(p.data.merchandise_gross),
          voucherAllocated: BigInt(p.data.voucher_allocated),
          refundedMerchandiseGross: BigInt(p.data.refunded_merchandise_gross),
          closedAtMs: p.data.closed_at_ms,
          returnWindowEndsAtMs: p.data.return_window_ends_at_ms,
          openReturns: p.data.open_returns,
        });
        if (r.kind === "deferred") throw new CreatorEventDeferredError(e.type);
        return r.kind === "duplicate" ? "duplicate" : "handled";
      }
      case "order_line.refunded": {
        const p = LineRefunded.safeParse(e.payload);
        // Without the line's gross value a proportional clawback cannot be computed: refuse, never guess.
        if (!p.success || p.data.line_merchandise_gross === null) return "invalid";
        const r = await this.refund.execute({
          messageId: e.messageId,
          orderLineId: p.data.order_line_id,
          lineMerchandiseGross: BigInt(p.data.line_merchandise_gross),
          refundedMerchandiseGross: BigInt(p.data.refunded_merchandise_gross),
        });
        return r.kind === "duplicate" ? "duplicate" : "handled";
      }
      case "order_group.paid":
      case "order_group.cod_confirmed": {
        const p = GroupPlaced.safeParse(e.payload);
        if (!p.success) return "invalid";
        const orderAtMs = p.data.paid_at_ms ?? e.occurredAtMs;
        if (orderAtMs === undefined) return "invalid";
        // Already idempotent on the order group (existing / voided / held are all stable answers).
        const r = await this.attribute.execute({ orderGroupId: p.data.order_group_id, buyerUserId: p.data.user_id, orderAtMs });
        // HELD (identity or referral check unavailable, A-3): retry through the relay's backoff so the
        // fraud gate runs once its inputs are back, rather than acknowledging an undecided order.
        if (r.kind === "held") throw new CreatorEventDeferredError(e.type);
        return "handled";
      }
      default:
        return "ignored";
    }
  }
}
