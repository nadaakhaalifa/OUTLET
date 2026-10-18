import { z } from "zod";
import type { OrderCommands } from "./commands";

export interface OrderInboundEvent {
  readonly messageId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAtMs?: number;
}

export type OrderEventResult = "handled" | "ignored" | "invalid";

/** Outbox event types this consumer owns (the relay routes by these). */
export const ORDER_CONSUMED_EVENTS = ["shipment.delivered"] as const;

/** The order has not reached SHIPPED yet (a courier event raced the dispatch): retry through the relay. */
export class OrderNotYetShippedError extends Error {
  override readonly name = "OrderNotYetShippedError";
  constructor(readonly sellerOrderId: string, readonly status: string) {
    super(`seller order ${sellerOrderId} is ${status}; delivery cannot be applied yet`);
  }
}

const Delivered = z.object({
  seller_order_id: z.uuid(),
  delivered_at: z.iso.datetime({ offset: true }).nullable().optional(),
});

const BEFORE_SHIPPED: ReadonlySet<string> = new Set(["PENDING_PAYMENT", "PAID", "CONFIRMED_COD", "ACCEPTED", "PACKED"]);

/**
 * Courier-confirmed delivery drives the seller order to DELIVERED (spec 20.1, B5: windows count from
 * the courier-confirmed `delivered_at`). The command key is the message id, so a redelivery is a
 * replay; an order already past DELIVERED is acknowledged as ignored.
 */
export class OrderDeliveryConsumer {
  constructor(private readonly commands: Pick<OrderCommands, "markDelivered">) {}

  async handle(e: OrderInboundEvent): Promise<OrderEventResult> {
    if (e.type !== "shipment.delivered") return "ignored";
    const p = Delivered.safeParse(e.payload);
    if (!p.success) return "invalid";
    const at = p.data.delivered_at === null || p.data.delivered_at === undefined ? e.occurredAtMs : Date.parse(p.data.delivered_at);
    if (at === undefined || !Number.isFinite(at)) return "invalid";
    const r = await this.commands.markDelivered({ sellerOrderId: p.data.seller_order_id, deliveredAtMs: at, commandKey: e.messageId });
    switch (r.kind) {
      case "ok":
        return "handled";
      case "not_found":
        return "ignored";
      case "invalid_transition":
        if (BEFORE_SHIPPED.has(r.from)) throw new OrderNotYetShippedError(p.data.seller_order_id, r.from);
        return "ignored";
      default:
        // conflict: a concurrent writer moved the order; the retry re-reads it.
        throw new Error(`order delivery not applied: ${r.kind}`);
    }
  }
}
