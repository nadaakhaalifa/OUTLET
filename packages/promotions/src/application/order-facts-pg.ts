import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { OrderFactsPort } from "./ports.js";

type Run = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

/**
 * OrderFactsPort over seller_orders: true only when the group has seller orders and EVERY one is CANCELLED or REJECTED_BY_SELLER.
 * In the seller-order machine (@outlet/orders) neither state is reachable from SHIPPED or later (cancel exists only up to PACKED, reject only
 * from PAID), so "all cancelled/rejected" also means "none reached SHIPPED"; any other status (a shipped, delivered, returned or still
 * open order) answers false, and so does an unknown group. A return or a partial refund never reaches here as true (refund-then-reuse block).
 *
 * `run` supplies the transaction and its row-level-security context; the composition root decides it (the facts are not shopper-scoped).
 */
export class PgOrderFacts implements OrderFactsPort {
  constructor(private readonly run: Run) {}

  /** Read-only worker context that already has a whole-market SELECT policy on seller_orders (job finance.reconcile, migration 0018). */
  static forWorker(client: RoleSqlClient<"outlet_worker">, marketId: string): PgOrderFacts {
    return new PgOrderFacts((fn) => withDbContext(client, { kind: "worker", marketId, job: "finance.reconcile" }, fn));
  }

  async wholeOrderCancelledBeforeShipping(orderGroupId: string): Promise<boolean> {
    const r = await this.run((tx) =>
      tx.query<{ total: string | number; dead: string | number }>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status IN ('CANCELLED', 'REJECTED_BY_SELLER')) AS dead FROM seller_orders WHERE order_group_id = $1`,
        [orderGroupId],
      ),
    );
    const row = r.rows[0];
    const total = Number(row?.total ?? 0);
    return total > 0 && Number(row?.dead ?? 0) === total;
  }
}
