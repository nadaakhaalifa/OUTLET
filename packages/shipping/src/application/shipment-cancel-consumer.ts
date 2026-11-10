import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import { CourierCancelError } from "../domain/ports.js";
import type { CourierPort } from "../domain/ports.js";
import { CANCELLABLE_SHIPMENT_STATUSES, transition } from "../domain/shipment-state.js";
import type { ShipmentStatus } from "../domain/shipment-state.js";

/** Emitted by OrderCancellation (same transaction as the seller order cancel) when the cancelled order has a live outbound shipment (M4). */
export const SHIPMENT_CANCEL_REQUIRED_EVENT = "shipment.cancel_required";
export const SHIPMENT_CANCELLED_EVENT = "shipment.cancelled";
export const SHIPMENT_CANCEL_ATTENTION_EVENT = "shipment.cancel_attention";
export const SHIPMENT_CANCEL_CONSUMER = "shipping.shipment_cancel";

const payload = z.object({ shipment_id: z.uuid(), seller_order_id: z.uuid() });
interface Row { id: string; store_id: string; courier: string; awb: string | null; status: ShipmentStatus; seller_order_ids: string[] }
const COLS = "id, store_id, courier, awb, status, seller_order_ids";

export interface ShipmentCancelDeps {
  /** outlet_worker; every call binds job shipping.tracking (the only job allowed to update shipments). */
  readonly client: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  readonly courier: Pick<CourierPort, "cancelShipment">;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * Inbox consumer of `shipment.cancel_required` (M4). Cancels the AWB at the courier and moves the shipment LABEL_PENDING / LABEL_READY ->
 * CANCELLED. At-least-once and idempotent: a CANCELLED shipment is a success; the courier answering `not_found` / `already_cancelled`
 * (CourierCancelError) is a success; any other courier failure throws (no inbox row, the relay redelivers). Permanent refusals are parked as
 * `shipment.cancel_attention {shipment_id, seller_order_id, reason}` in the inbox transaction: shipment not found, already handed to the
 * courier (a return, not a cancel), courier `not_cancellable`, or a shipment carrying other seller orders (needs a manual split).
 */
export class ShipmentCancelConsumer {
  private readonly outbox: OutboxWriter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  constructor(private readonly d: ShipmentCancelDeps) {
    this.outbox = d.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? (() => uuidv7());
  }

  async handle(event: { readonly id: string; readonly payload: Readonly<Record<string, unknown>> }): Promise<InboxOutcome> {
    if ((await this.tx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [SHIPMENT_CANCEL_CONSUMER, event.id]))).rows.length > 0) return "duplicate";
    const parsed = payload.safeParse(event.payload);
    if (!parsed.success) return this.finish(event.id, { attention: "invalid_payload", shipmentId: null, sellerOrderId: null });
    const { shipment_id: shipmentId, seller_order_id: sellerOrderId } = parsed.data;
    const row = (await this.tx((tx) => tx.query<Row>(`SELECT ${COLS} FROM shipments WHERE id = $1`, [shipmentId]))).rows[0];
    if (row === undefined) return this.finish(event.id, { attention: "shipment_not_found", shipmentId, sellerOrderId });
    if (row.status === "CANCELLED") return this.finish(event.id, { cancelled: null, shipmentId, sellerOrderId });
    if (!CANCELLABLE_SHIPMENT_STATUSES.includes(row.status)) return this.finish(event.id, { attention: "already_with_courier", shipmentId, sellerOrderId });
    if (row.seller_order_ids.length !== 1 || row.seller_order_ids[0] !== sellerOrderId) return this.finish(event.id, { attention: "multi_order_shipment", shipmentId, sellerOrderId });

    if (row.awb !== null) {
      try {
        await this.d.courier.cancelShipment(row.awb); // outside any transaction; infrastructure errors propagate for redelivery
      } catch (e) {
        if (!(e instanceof CourierCancelError)) throw e;
        if (e.code === "not_cancellable") return this.finish(event.id, { attention: "courier_not_cancellable", shipmentId, sellerOrderId });
      }
    }
    return this.finish(event.id, { cancelled: row, shipmentId, sellerOrderId });
  }

  /** One transaction: apply the shipment move (re-checked under lock), emit the result event, write the inbox row. */
  private finish(
    eventId: string,
    r: { shipmentId: string | null; sellerOrderId: string | null } & ({ attention: string } | { cancelled: Row | null }),
  ): Promise<InboxOutcome> {
    return this.tx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [SHIPMENT_CANCEL_CONSUMER, eventId]);
      if (ins.rows.length === 0) return "duplicate";
      const at = this.now().toISOString();
      const base = { shipment_id: r.shipmentId, seller_order_id: r.sellerOrderId, source_event_id: eventId };
      if ("attention" in r) {
        await this.emit(tx, SHIPMENT_CANCEL_ATTENTION_EVENT, r.shipmentId ?? eventId, at, { ...base, reason: r.attention });
        return "processed";
      }
      if (r.cancelled !== null && r.shipmentId !== null) {
        const s = (await tx.query<Row>(`SELECT ${COLS} FROM shipments WHERE id = $1 FOR UPDATE`, [r.shipmentId])).rows[0];
        if (s !== undefined && CANCELLABLE_SHIPMENT_STATUSES.includes(s.status)) {
          await tx.query("UPDATE shipments SET status = $2, version = version + 1, updated_at = $3::timestamptz WHERE id = $1", [s.id, transition({ status: s.status, attempts: 0 }, "CANCELLED").status, at]);
          await this.emit(tx, SHIPMENT_CANCELLED_EVENT, s.id, at, { ...base, store_id: s.store_id, courier: s.courier, awb: s.awb });
        } else if (s !== undefined && s.status !== "CANCELLED") {
          // picked up between the courier call and this transaction: the AWB is cancelled at the courier but the parcel moved; park it
          await this.emit(tx, SHIPMENT_CANCEL_ATTENTION_EVENT, s.id, at, { ...base, reason: "already_with_courier" });
        }
      }
      return "processed";
    });
  }

  private emit(tx: Queryable, type: string, aggregateId: string, at: string, p: Record<string, unknown>): Promise<unknown> {
    return this.outbox.append(tx, { id: this.newId(), type, aggregateType: "shipment", aggregateId, marketId: this.d.marketId, occurredAt: at, visibility: "internal", payload: { ...p, market_id: this.d.marketId, occurred_at: at } });
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "worker", marketId: this.d.marketId, job: "shipping.tracking" }, fn);
  }
}
