import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { ShippingError } from "../domain/errors.js";
import type { CourierEvent, CourierPort, CourierWebhookPort, DeliveryPort, PiiCipher } from "../domain/ports.js";
import { applyTracking } from "../domain/shipment-state.js";
import type { ShipmentStatus } from "../domain/shipment-state.js";

export const STALE_AFTER_MS = 48 * 3_600_000;
const SELLER_ACCESS_MS = 30 * 86_400_000;

export interface TrackingDeps {
  /** Connection as outlet_worker; every call binds job shipping.tracking. */
  readonly client: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  readonly courierCode: string;
  readonly courier: CourierPort;
  readonly webhook: CourierWebhookPort;
  readonly cipher: PiiCipher;
  readonly orders: DeliveryPort;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type EventOutcome = "applied" | "duplicate" | "ignored" | "failed";
export interface WebhookResult { readonly accepted: boolean; readonly outcomes: readonly { eventId: string; outcome: EventOutcome }[] }

interface ShipRow { id: string; store_id: string; user_id: string; seller_order_ids: string[]; status: ShipmentStatus; attempts: number; cod_amount_minor: string; courier: string; awb: string }
const SHIP_COLS = "id, store_id, user_id, seller_order_ids, status, attempts, cod_amount_minor::text AS cod_amount_minor, courier, awb";

abstract class Base {
  protected readonly outbox: OutboxWriter;
  protected readonly now: () => Date;
  protected readonly newId: () => string;
  constructor(protected readonly d: TrackingDeps) {
    this.outbox = d.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? (() => uuidv7());
  }
  protected tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.d.client, { kind: "worker", marketId: this.d.marketId, job: "shipping.tracking" }, fn);
  }
  protected emit(tx: Queryable, type: string, aggregateType: string, aggregateId: string, occurredAt: string, payload: Record<string, string | number>): Promise<unknown> {
    return this.outbox.append(tx, { id: this.newId(), type, aggregateType, aggregateId, marketId: this.d.marketId, occurredAt, visibility: "internal", payload: { ...payload, market_id: this.d.marketId, occurred_at: occurredAt } });
  }
}

/**
 * Courier tracking webhooks (job shipping.tracking). Verify -> store raw (dedup on courier event id) -> normalise -> apply the shipment machine.
 * Replays are no-ops: a processed or ignored raw row short-circuits, a failed one is retried. DELIVERED calls markDelivered (idempotent) BEFORE the
 * shipment commits, so a failure leaves the raw row `failed` and a redelivery finishes the job. The third failed attempt becomes RTO in one step.
 */
export class CourierWebhookProcessor extends Base {
  async handle(rawBody: string, headers: Readonly<Record<string, string>>): Promise<WebhookResult> {
    if (!this.d.webhook.verify(rawBody, headers)) {
      const now = this.now().toISOString();
      const body = await this.d.cipher.encrypt(rawBody, "courier_events_raw.body_ct");
      await this.tx((tx) => tx.query(
        `INSERT INTO courier_events_raw (id, market_id, courier_code, courier_event_id, signature_ok, body_ct, processing_status, received_at) VALUES ($1,$2,$3,$4,false,$5,'rejected',$6::timestamptz)`,
        [this.newId(), this.d.marketId, this.d.courierCode, `invalid:${this.newId()}`, body, now]));
      return { accepted: false, outcomes: [] };
    }
    let events: readonly CourierEvent[];
    try { events = this.d.webhook.parse(rawBody); } catch { throw new ShippingError("INVALID_INPUT", "malformed courier webhook body"); }
    const outcomes: { eventId: string; outcome: EventOutcome }[] = [];
    for (const e of events) outcomes.push({ eventId: e.eventId, outcome: await this.one(e) });
    return { accepted: true, outcomes };
  }

  private async one(e: CourierEvent): Promise<EventOutcome> {
    const rawId = this.newId();
    const body = await this.d.cipher.encrypt(JSON.stringify(e), "courier_events_raw.body_ct");
    const raw = await this.tx(async (tx) => {
      await tx.query(
        `INSERT INTO courier_events_raw (id, market_id, courier_code, courier_event_id, signature_ok, body_ct, received_at) VALUES ($1,$2,$3,$4,true,$5,$6::timestamptz) ON CONFLICT (courier_code, courier_event_id) DO NOTHING`,
        [rawId, this.d.marketId, this.d.courierCode, e.eventId, body, this.now().toISOString()]);
      return (await tx.query<{ id: string; processing_status: string }>("SELECT id, processing_status FROM courier_events_raw WHERE courier_code = $1 AND courier_event_id = $2", [this.d.courierCode, e.eventId])).rows[0];
    });
    if (raw === undefined) return "failed";
    if (raw.processing_status === "processed" || raw.processing_status === "ignored") return "duplicate";
    const finish = (status: string, reason: string | null, shipmentId: string | null): Promise<unknown> =>
      this.tx((tx) => tx.query("UPDATE courier_events_raw SET processing_status = $2, failure_reason = $3, shipment_id = $4, processed_at = $5::timestamptz WHERE id = $1", [raw.id, status, reason, shipmentId, this.now().toISOString()]));

    const norm = this.d.courier.normalise(e);
    if (norm === undefined) { await finish("ignored", "unknown_status", null); return "ignored"; }
    const peek = await this.tx(async (tx) => (await tx.query<ShipRow>(`SELECT ${SHIP_COLS} FROM shipments WHERE courier = $1 AND awb = $2`, [this.d.courierCode, e.awb])).rows[0]);
    if (peek === undefined) { await finish("ignored", "unknown_awb", null); return "ignored"; }
    let pre;
    try { pre = applyTracking({ status: peek.status, attempts: peek.attempts }, norm.status); } catch { await finish("ignored", "invalid_transition", peek.id); return "ignored"; }
    if (pre.kind === "duplicate") { await finish("ignored", "same_status", peek.id); return "ignored"; }
    const deliveredAt = new Date(norm.occurredAt);
    if (pre.state.status === "DELIVERED") {
      try { for (const so of peek.seller_order_ids) await this.d.orders.markDelivered(so, deliveredAt); } catch { await finish("failed", "mark_delivered_failed", peek.id); return "failed"; }
    }
    const done = await this.tx(async (tx) => {
      const s = (await tx.query<ShipRow>(`SELECT ${SHIP_COLS} FROM shipments WHERE id = $1 FOR UPDATE`, [peek.id])).rows[0];
      if (s === undefined) return "ignored" as const;
      let r;
      try { r = applyTracking({ status: s.status, attempts: s.attempts }, norm.status); } catch { return "ignored" as const; }
      if (r.kind === "duplicate") return "ignored" as const;
      const at = norm.occurredAt;
      const st = r.state.status;
      await tx.query(
        `UPDATE shipments SET status = $2, attempts = $3, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN $4::timestamptz ELSE delivered_at END, last_event_at = $4::timestamptz, version = version + 1, updated_at = $5::timestamptz WHERE id = $1`,
        [s.id, st, r.state.attempts, at, this.now().toISOString()]);
      const base = { shipment_id: s.id, store_id: s.store_id, user_id: s.user_id };
      if (st === "DELIVERED" || st === "RTO") {
        await tx.query("UPDATE delivery_snapshots SET seller_access_until = $2::timestamptz WHERE seller_order_id = ANY($1::uuid[]) AND seller_access_until IS NULL", [s.seller_order_ids, new Date(new Date(at).getTime() + SELLER_ACCESS_MS).toISOString()]);
      }
      if (st === "DELIVERED") {
        for (const so of s.seller_order_ids) await this.emit(tx, "seller_order.delivered", "seller_order", so, at, { seller_order_id: so, store_id: s.store_id, user_id: s.user_id });
        if (BigInt(s.cod_amount_minor) > 0n) await this.emit(tx, "shipment.cod_collected", "shipment", s.id, at, { ...base, courier: s.courier, amount_minor: s.cod_amount_minor });
      }
      if (st === "RTO") await this.emit(tx, "shipment.rto", "shipment", s.id, at, { ...base, attempts: r.state.attempts, seller_order_ids: s.seller_order_ids.join(",") });
      await tx.query("UPDATE courier_events_raw SET processing_status = 'processed', shipment_id = $2, processed_at = $3::timestamptz WHERE id = $1", [raw.id, s.id, this.now().toISOString()]);
      return "applied" as const;
    });
    if (done === "ignored") await finish("ignored", "invalid_transition", peek.id);
    return done;
  }
}

/** Poll trigger: in-flight shipments with no tracking event for more than 48 h get one `shipment.tracking_stale` event per silence. */
export class TrackingStaleScanner extends Base {
  async run(limit = 100): Promise<readonly string[]> {
    const at = this.now();
    const cutoff = new Date(at.getTime() - STALE_AFTER_MS).toISOString();
    return this.tx(async (tx) => {
      const rows = (await tx.query<ShipRow & { last_event_at: Date | string }>(
        `SELECT ${SHIP_COLS}, last_event_at FROM shipments WHERE market_id = $1 AND status IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY') AND last_event_at < $2::timestamptz
            AND (stale_notified_at IS NULL OR stale_notified_at < last_event_at) ORDER BY last_event_at, id LIMIT $3::int FOR UPDATE`, [this.d.marketId, cutoff, limit])).rows;
      for (const s of rows) {
        await tx.query("UPDATE shipments SET stale_notified_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1", [s.id, at.toISOString()]);
        await this.emit(tx, "shipment.tracking_stale", "shipment", s.id, at.toISOString(), { shipment_id: s.id, store_id: s.store_id, courier: s.courier, awb: s.awb, last_event_at: new Date(s.last_event_at).toISOString() });
      }
      return rows.map((r) => r.id);
    });
  }
}
