import { z } from "zod";
import type { CancelAllForUser, CloseOnPurchase } from "./lifecycle";
import type { HandlePriceChange } from "./evaluate";

export interface AutoBuyInboundEvent {
  readonly messageId: string;
  readonly type: string;
  readonly payload: unknown;
}

export type AutoBuyEventResult = "handled" | "ignored" | "invalid";

const DeletionCompleted = z.object({ user_id: z.uuid() });

/** Outbox event types this consumer owns (the relay routes by these). */
export const AUTO_BUY_CONSUMED_EVENTS = [
  "price.changed",
  "privacy.deletion_completed",
  "order_group.paid",
  "order_group.cod_confirmed",
  "payment_method.removed",
] as const;

const GroupPlaced = z.object({
  user_id: z.uuid(),
  /** Comma-joined SKU ids of the placed order (checkout payload extension). */
  sku_ids: z.string().max(4096).optional(),
});
const MethodRemoved = z.object({ user_id: z.uuid(), card_id: z.string().min(1).max(128) });

/**
 * Relay-facing consumer. The relay wraps `handle` in the inbox transaction (dedupe by message id);
 * both use cases are also idempotent on their own, so a redelivery is a no-op:
 *   price.changed               -> HandlePriceChange (unique (mandate, price_event) claim)
 *   privacy.deletion_completed  -> CancelAllForUser(account_deleted)
 *   order_group.paid / cod_confirmed -> CloseOnPurchase per SKU (rule closed when bought normally)
 *   payment_method.removed      -> CancelAllForUser(card_removed) for every armed rule of the user
 *     (spec edge case "user deletes card: all rules cancelled"; the mandate's psp_token_ref is not
 *     known to equal the payments card id, so the rule set is not narrowed by token)
 * An `order_group.paid` from before the payload carried `sku_ids` is acknowledged as ignored.
 */
export class AutoBuyEventConsumer {
  constructor(
    private readonly priceChange: Pick<HandlePriceChange, "execute">,
    private readonly cancelAll: Pick<CancelAllForUser, "execute">,
    private readonly closeOnPurchase?: Pick<CloseOnPurchase, "execute">,
  ) {}

  async handle(e: AutoBuyInboundEvent): Promise<AutoBuyEventResult> {
    if (e.type === "price.changed") {
      const r = await this.priceChange.execute(e.payload);
      return r.kind === "invalid" ? "invalid" : "handled";
    }
    if (e.type === "privacy.deletion_completed") {
      const p = DeletionCompleted.safeParse(e.payload);
      if (!p.success) return "invalid";
      await this.cancelAll.execute(p.data.user_id, "account_deleted");
      return "handled";
    }
    if (e.type === "order_group.paid" || e.type === "order_group.cod_confirmed") {
      if (this.closeOnPurchase === undefined) return "ignored";
      const p = GroupPlaced.safeParse(e.payload);
      if (!p.success) return "invalid";
      if (p.data.sku_ids === undefined || p.data.sku_ids === "") return "ignored";
      const skus = [...new Set(p.data.sku_ids.split(",").filter((x) => z.uuid().safeParse(x).success))];
      for (const sku of skus) await this.closeOnPurchase.execute(p.data.user_id, sku);
      return "handled";
    }
    if (e.type === "payment_method.removed") {
      const p = MethodRemoved.safeParse(e.payload);
      if (!p.success) return "invalid";
      await this.cancelAll.execute(p.data.user_id, "card_removed", null);
      return "handled";
    }
    return "ignored";
  }
}
