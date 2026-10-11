import { z } from "zod";
import type { InboxProcessedPort, SuppressionRepository } from "../domain/ports";
import { MARKETING_PURPOSE, type ExternalChannel } from "../domain/types";
import type { SendNotification, SendResult } from "./send-notification";

export const CONSUMER_NAME = "notifications";

export interface InboundEvent {
  /** Outbox message id (UUID). The dedupe key of inbox_processed. */
  readonly messageId: string;
  readonly type: string;
  readonly payload: unknown;
}

export type HandleResult =
  | { readonly kind: "processed"; readonly send: SendResult | null }
  | { readonly kind: "duplicate" }
  | { readonly kind: "ignored" }
  | { readonly kind: "invalid" };

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_\-.]+$/);

const OrderPaid = z.object({ order_group_id: Id, user_id: z.uuid() }).passthrough();
const RefundCompleted = z.object({ refund_id: Id, user_id: z.uuid() }).passthrough();
const ConsentChanged = z
  .object({
    user_id: z.uuid(),
    purpose: z.string().min(1).max(64),
    granted: z.boolean(),
  })
  .passthrough();
const WishlistAlertDue = z
  .object({
    alert: z.object({
      alertType: z.enum(["price_drop_verified", "back_in_size", "low_stock", "date_approaching"]),
      wishlistId: Id,
      userId: z.uuid(),
      dedupeKey: Id,
    }).passthrough(),
  })
  .passthrough();

const ALERT_TEMPLATE = {
  price_drop_verified: "wishlist_price_drop",
  back_in_size: "wishlist_back_in_size",
  low_stock: "wishlist_low_stock",
  date_approaching: "wishlist_date_approaching",
} as const;

/** Consumes outbox events idempotently (inbox_processed) and turns them into notification requests. */
export class HandleDomainEvent {
  constructor(
    private readonly processed: InboxProcessedPort,
    private readonly sender: SendNotification,
    private readonly suppressions: SuppressionRepository,
  ) {}

  async execute(event: InboundEvent): Promise<HandleResult> {
    if (!z.uuid().safeParse(event.messageId).success) return { kind: "invalid" };
    const known = ["order_group.paid", "refund.completed", "wishlist.alert_due", "consent.changed"];
    if (!known.includes(event.type)) return { kind: "ignored" };

    const outcome = await this.processed.runOnce(CONSUMER_NAME, event.messageId, () => this.dispatch(event));
    if (outcome.kind === "duplicate") return { kind: "duplicate" };
    return outcome.value;
  }

  private async dispatch(event: InboundEvent): Promise<HandleResult> {
    switch (event.type) {
      case "order_group.paid": {
        const p = OrderPaid.safeParse(event.payload);
        if (!p.success) return { kind: "invalid" };
        const send = await this.sender.execute({
          userId: p.data.user_id,
          templateKey: "order_confirmed",
          ref: p.data.order_group_id,
          payload: {},
          deepLink: `/orders/${p.data.order_group_id}`,
        });
        return { kind: "processed", send };
      }
      case "refund.completed": {
        const p = RefundCompleted.safeParse(event.payload);
        if (!p.success) return { kind: "invalid" };
        const send = await this.sender.execute({
          userId: p.data.user_id,
          templateKey: "refund_completed",
          ref: p.data.refund_id,
          payload: {},
        });
        return { kind: "processed", send };
      }
      case "wishlist.alert_due": {
        const p = WishlistAlertDue.safeParse(event.payload);
        if (!p.success) return { kind: "invalid" };
        const a = p.data.alert;
        const send = await this.sender.execute({
          userId: a.userId,
          templateKey: ALERT_TEMPLATE[a.alertType],
          ref: a.dedupeKey,
          payload: {},
          deepLink: `/wishlists/${a.wishlistId}`,
        });
        return { kind: "processed", send };
      }
      case "consent.changed": {
        const p = ConsentChanged.safeParse(event.payload);
        if (!p.success) return { kind: "invalid" };
        // Re-granting a marketing purpose lifts the unsubscribe suppression of its channel.
        if (p.data.granted) {
          for (const channel of ["push", "whatsapp", "email"] as const satisfies readonly ExternalChannel[]) {
            if (MARKETING_PURPOSE[channel] === p.data.purpose) {
              await this.suppressions.remove(p.data.user_id, channel, "UNSUBSCRIBED");
            }
          }
        }
        return { kind: "processed", send: null };
      }
      default:
        return { kind: "ignored" };
    }
  }
}
