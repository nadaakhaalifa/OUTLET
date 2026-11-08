import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { z } from "zod";
import { SKU_LOCK_SQL } from "./pool.js";

export const RELEASE_REQUIRED_EVENT = "inventory.release_required";
export const COMMITTED_RELEASED_EVENT = "inventory.committed_released";
/** Inbox consumer names: one row per event id, one per seller order (a re-published event with a new id still releases once). */
export const RELEASE_REQUIRED_CONSUMER = "inventory.release_required";
export const RELEASE_REQUIRED_ORDER_CONSUMER = "inventory.release_required.seller_order";

const payload = z.object({
  seller_order_id: z.uuid(),
  store_id: z.uuid(),
  reservation_id: z.uuid().nullable().optional(),
  lines: z.array(z.object({ sku_id: z.uuid(), qty: z.number().int().positive() })).min(1),
});

export type ReleaseRequiredOutcome = "processed" | "duplicate";

export interface ReleaseRequiredDeps {
  /** Connection as outlet_app (ADR-0011): the transaction binds the store context of the event, exactly like ReservationService; no worker policy is needed. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * Consumer of `inventory.release_required` (emitted when a seller rejects or an order is cancelled after payment, so its units are CLAIMED).
 *
 * ADR-0005 decision: a CLAIMED unit row is terminal (unit machine: claimed has no transitions) and is archived, so this consumer does NOT
 * return rows to `available` and adds no `returned` state (that would need a CHECK change on inventory_units and a second machine). It lowers
 * `inventory_levels.committed` by the cancelled quantity instead, which frees `on_hand - committed`; the existing replenisher
 * (`InventoryService.replenish*`, outlet_app) then mints fresh available pool rows up to the cap. Consequences, by design:
 *   - fungible stock becomes sellable again after the next replenish run (not instantly);
 *   - a serialised one-off unit (defect card) is NOT re-listed automatically: its claimed row stays archived and the seller re-registers the
 *     returned piece, because its condition after a rejection is unknown.
 *
 * Idempotent: the inbox row (event id) and a second row (seller order id) are written in the same transaction as the decrement.
 * `committed` never goes below zero: a request larger than what is committed is clamped and reported with `clamped: true` on the emitted event.
 * Lock order follows the README: the per-SKU advisory lock first, then the level row.
 */
export class ReleaseRequiredConsumer {
  private readonly outbox: OutboxWriter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly d: ReleaseRequiredDeps) {
    this.outbox = d.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? (() => uuidv7());
  }

  async handle(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<ReleaseRequiredOutcome> {
    const p = payload.parse(event.payload);
    return withDbContext(this.d.client, { kind: "store", marketId: this.d.marketId, storeId: p.store_id }, async (tx) => {
      const byEvent = await this.once(tx, RELEASE_REQUIRED_CONSUMER, event.id);
      const byOrder = await this.once(tx, RELEASE_REQUIRED_ORDER_CONSUMER, p.seller_order_id);
      if (!byEvent || !byOrder) return "duplicate";
      // One request per SKU: sum quantities, deterministic order (lock ordering).
      const want = new Map<string, number>();
      for (const l of p.lines) want.set(l.sku_id, (want.get(l.sku_id) ?? 0) + l.qty);
      const released: { sku_id: string; location_id: string; qty: number }[] = [];
      let clamped = false;
      for (const skuId of [...want.keys()].sort()) {
        let remaining = want.get(skuId) ?? 0;
        await tx.query(SKU_LOCK_SQL, [skuId]);
        for (const loc of await this.locations(tx, p.reservation_id ?? null, skuId, p.store_id)) {
          if (remaining === 0) break;
          const lv = (await tx.query<{ committed: number }>("SELECT committed FROM inventory_levels WHERE sku_id = $1 AND location_id = $2 AND store_id = $3 FOR UPDATE", [skuId, loc.location_id, p.store_id])).rows[0];
          if (lv === undefined) continue;
          const take = Math.min(remaining, loc.cap ?? remaining);
          const dec = Math.min(take, lv.committed);
          if (dec > 0) {
            await tx.query("UPDATE inventory_levels SET committed = committed - $3, version = version + 1, updated_at = $4::timestamptz WHERE sku_id = $1 AND location_id = $2", [skuId, loc.location_id, dec, this.now().toISOString()]);
            released.push({ sku_id: skuId, location_id: loc.location_id, qty: dec });
          }
          if (dec < take) clamped = true;
          remaining -= dec;
        }
        if (remaining > 0) clamped = true;
      }
      const at = this.now().toISOString();
      await this.outbox.append(tx, {
        id: this.newId(), type: COMMITTED_RELEASED_EVENT, aggregateType: "seller_order", aggregateId: p.seller_order_id, marketId: this.d.marketId, occurredAt: at, visibility: "internal",
        payload: { seller_order_id: p.seller_order_id, store_id: p.store_id, market_id: this.d.marketId, released, clamped, occurred_at: at },
      });
      return "processed";
    });
  }

  private async once(tx: Queryable, consumer: string, messageId: string): Promise<boolean> {
    return (await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [consumer, messageId])).rows.length > 0;
  }

  /** The stock locations the order's claim drew from (reservation lines, capped at their qty); without a reservation, every level of the SKU. */
  private async locations(tx: Queryable, reservationId: string | null, skuId: string, storeId: string): Promise<readonly { location_id: string; cap: number | null }[]> {
    if (reservationId !== null) {
      const rl = (await tx.query<{ location_id: string; qty: number }>("SELECT location_id, qty FROM reservation_lines WHERE reservation_id = $1 AND sku_id = $2 AND store_id = $3 ORDER BY location_id", [reservationId, skuId, storeId])).rows;
      if (rl.length > 0) return rl.map((r) => ({ location_id: r.location_id, cap: r.qty }));
    }
    return (await tx.query<{ location_id: string }>("SELECT location_id FROM inventory_levels WHERE sku_id = $1 AND store_id = $2 ORDER BY location_id", [skuId, storeId])).rows.map((r) => ({ location_id: r.location_id, cap: null }));
  }
}
