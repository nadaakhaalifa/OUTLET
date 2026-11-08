import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { SELLER_ORDER, transition } from "@outlet/orders";
import type { SellerOrderState } from "@outlet/orders";
import type { OutboxEventInput } from "@outlet/outbox";
import { CheckoutError } from "../domain/errors.js";
import { windowEnd } from "../domain/cairo.js";
import { makeEnv } from "./env.js";
import type { Env, WorkerDeps } from "./env.js";

export const SELLER_ORDER_CLOSED_EVENT = "seller_order.closed";
export const RETURN_WINDOW_DAYS = 14;
/** Return states that still hold the order open (REJECTED, CANCELLED and CLOSED do not). */
const ACTIVE_RETURN_STATES = ["REQUESTED", "APPROVED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "ACCEPTED", "DISPUTED"];

export interface CloseResult {
  readonly closed: readonly string[];
  /** Due but held back by an active return or an open dispute. */
  readonly held: readonly string[];
  readonly failed: readonly string[];
}

interface DueRow { id: string; store_id: string; status: SellerOrderState; seller_net_minor: string }

/**
 * Worker job orders.close. Closes DELIVERED seller orders whose return window has ended and emits `seller_order.closed`
 * (the contract payouts consumes: amount_minor = seller_net minus what posted refunds already took from seller_pending).
 * markDelivered stamps delivered_at and the Cairo end-of-day window; courier webhooks will call it.
 */
export class OrderCloseJob {
  private readonly env: Env;
  constructor(private readonly d: WorkerDeps) {
    this.env = makeEnv(d);
  }

  private inTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "worker", marketId: this.env.marketId, job: "orders.close" }, fn);
  }

  /** SHIPPED / OUT_FOR_DELIVERY -> DELIVERED with delivered_at and return_window_ends_at = end of Cairo day, 14 days after delivery. Idempotent on DELIVERED. */
  async markDelivered(sellerOrderId: string, deliveredAt: Date): Promise<{ returnWindowEndsAt: Date }> {
    const env = this.env;
    return this.inTx(async (tx) => {
      const o = (await tx.query<{ status: SellerOrderState; return_window_ends_at: Date | string | null }>("SELECT status, return_window_ends_at FROM seller_orders WHERE id = $1 AND market_id = $2 FOR UPDATE", [sellerOrderId, env.marketId])).rows[0];
      if (o === undefined) throw new CheckoutError("not-found", "seller order not found");
      if (o.status === "DELIVERED" && o.return_window_ends_at !== null) return { returnWindowEndsAt: new Date(o.return_window_ends_at) };
      const next = transition(SELLER_ORDER, o.status, "deliver");
      const ends = windowEnd(deliveredAt, RETURN_WINDOW_DAYS);
      await tx.query(
        "UPDATE seller_orders SET status = $2, delivered_at = $3::timestamptz, return_window_ends_at = $4::timestamptz, version = version + 1, updated_at = $5::timestamptz WHERE id = $1",
        [sellerOrderId, next, deliveredAt.toISOString(), ends.toISOString(), env.now().toISOString()],
      );
      return { returnWindowEndsAt: ends };
    });
  }

  async run(limit = 100): Promise<CloseResult> {
    const env = this.env;
    const closed: string[] = [];
    const held: string[] = [];
    const failed: string[] = [];
    await this.inTx(async (tx) => {
      const due = (
        await tx.query<DueRow>(
          `SELECT id, store_id, status, seller_net_minor::text AS seller_net_minor FROM seller_orders
            WHERE market_id = $1 AND status = 'DELIVERED' AND return_window_ends_at <= $2::timestamptz
            ORDER BY return_window_ends_at, id LIMIT $3::int FOR UPDATE SKIP LOCKED`,
          [env.marketId, env.now().toISOString(), limit],
        )
      ).rows;
      for (const o of due) {
        await tx.query("SAVEPOINT close_one");
        try {
          const outcome = await this.closeOne(tx, o);
          (outcome === "closed" ? closed : held).push(o.id);
          await tx.query("RELEASE SAVEPOINT close_one");
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT close_one");
          failed.push(o.id);
        }
      }
    });
    return { closed, held, failed };
  }

  private async closeOne(tx: Queryable, o: DueRow): Promise<"closed" | "held"> {
    const env = this.env;
    const open = await tx.query(
      `SELECT 1 FROM return_requests WHERE seller_order_id = $1 AND status = ANY($2::text[])
       UNION ALL SELECT 1 FROM disputes d JOIN return_requests r ON r.id = d.return_request_id WHERE r.seller_order_id = $1 AND d.status IN ('OPEN', 'UNDER_REVIEW') LIMIT 1`,
      [o.id, ACTIVE_RETURN_STATES],
    );
    if (open.rows.length > 0) return "held";
    const refunded = (
      await tx.query<{ s: string }>(
        "SELECT COALESCE(SUM(seller_minor), 0)::text AS s FROM refunds WHERE seller_order_id = $1 AND seller_account = 'seller_pending' AND journal_entry_id IS NOT NULL",
        [o.id],
      )
    ).rows[0];
    const amount = BigInt(o.seller_net_minor) - BigInt(refunded?.s ?? "0");
    if (amount < 0n) throw new CheckoutError("invalid-state", "posted pending refunds exceed the seller net");
    const next = transition(SELLER_ORDER, o.status, "close");
    const at = env.now().toISOString();
    await tx.query("UPDATE seller_orders SET status = $2, closed_at = $3::timestamptz, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [o.id, next, at]);
    const e: OutboxEventInput = {
      id: env.newId(), type: SELLER_ORDER_CLOSED_EVENT, aggregateType: "seller_order", aggregateId: o.id, marketId: env.marketId, occurredAt: at, visibility: "internal",
      payload: { seller_order_id: o.id, store_id: o.store_id, market_id: env.marketId, amount_minor: amount.toString(), closed_at: at },
    };
    await env.outbox.append(tx, e);
    return "closed";
  }
}
