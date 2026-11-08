import { withDbContext } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { PaymentKind, PaymentKindPort } from "./ports.js";

/**
 * Reads the payment method of one order group under the buyer's own user context (order_groups is user-owned; the store
 * context cannot see it). The ids come from a seller order the store already owns, never from the request.
 */
export class PgPaymentKind implements PaymentKindPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  async kindOf(input: { readonly userId: string; readonly orderGroupId: string }): Promise<PaymentKind | null> {
    const r = await withDbContext(this.client, { kind: "user", marketId: this.marketId, userId: input.userId }, (tx) =>
      tx.query<{ payment_method: string }>("SELECT payment_method FROM order_groups WHERE id = $1", [input.orderGroupId]),
    );
    const method = r.rows[0]?.payment_method;
    if (method === undefined) return null;
    return method === "cod" ? "cod" : "prepaid";
  }
}
