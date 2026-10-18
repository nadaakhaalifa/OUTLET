import { sql } from "kysely";
import { z } from "zod";
import type { DeletionSnapshot } from "../domain/bridge";
import type { BlockersPort } from "../domain/ports";
import type { PrivacyDb } from "./kysely-store";
import { inSystemTx, isUuid } from "./subject-tables";

/**
 * Seller-order states that still owe the shopper something: not yet closed, refunded or cancelled.
 * DELIVERED counts as open until the return window closes it (CLOSED), so a deletion cannot race a
 * statutory return (CPL 181/2018, 14 days).
 */
const OPEN_ORDER_STATES = [
  "PENDING_PAYMENT",
  "PAID",
  "CONFIRMED_COD",
  "ACCEPTED",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "DELIVERY_FAILED",
  "RTO",
] as const;
const OPEN_RETURN_STATES = ["REQUESTED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "APPROVED"] as const;
const OPEN_DISPUTE_STATES = ["OPEN", "UNDER_REVIEW"] as const;

const Count = z.string().regex(/^\d+$/).transform((s) => Number(s));
const Row = z.object({ orders: Count, returns: Count, disputes: Count, credit: z.string().regex(/^\d+$/).transform((s) => BigInt(s)) });

/**
 * Deletion blockers from the orders, returns, disputes and store-credit tables (read-only,
 * system role). Fails closed: a database error propagates and the deletion request is not created.
 */
export class KyselyDeletionBlockers implements BlockersPort {
  constructor(private readonly db: PrivacyDb) {}

  async snapshot(userId: string): Promise<DeletionSnapshot> {
    if (!isUuid(userId)) return { openOrders: 0, openReturns: 0, openDisputes: 0, storeCreditMinor: 0n };
    return inSystemTx(this.db, true, async (trx) => {
      const r = await sql`
        select
          (select count(*) from seller_orders where user_id = ${userId}::uuid and status in (${sql.join(OPEN_ORDER_STATES)}))::text as orders,
          (select count(*) from returns where user_id = ${userId}::uuid and state in (${sql.join(OPEN_RETURN_STATES)}))::text as returns,
          ((select count(*) from return_disputes d join returns r on r.id = d.return_id
              where r.user_id = ${userId}::uuid and d.status in (${sql.join(OPEN_DISPUTE_STATES)}))
           + (select count(*) from seller_orders where user_id = ${userId}::uuid and status = 'DISPUTED'))::text as disputes,
          (select coalesce(sum(remaining), 0) from credit_lots
              where user_id = ${userId}::uuid and (expires_at is null or expires_at > now()))::text as credit`.execute(trx);
      const row = Row.parse(r.rows[0]);
      return { openOrders: row.orders, openReturns: row.returns, openDisputes: row.disputes, storeCreditMinor: row.credit };
    });
  }
}
