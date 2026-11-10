import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { createHash } from "node:crypto";
import { ShippingError } from "../domain/errors.js";
import { MAX_WEBHOOK_BYTES } from "../domain/ports.js";
import type { CourierEvent, CourierPort, CourierWebhookPort, DeliveryPort, PiiCipher } from "../domain/ports.js";
import { applyTracking } from "../domain/shipment-state.js";
import type { ShipmentStatus } from "../domain/shipment-state.js";

export const STALE_AFTER_MS = 48 * 3_600_000;
const SELLER_ACCESS_MS = 30 * 86_400_000;
const SELLER_ACCESS_TERMINAL: ReadonlySet<string> = new Set(["DELIVERED", "RTO", "CANCELLED", "RETURNED_TO_SELLER"]);
const isStale = (last: Date | string | null, occurredAt: string): boolean => last !== null && new Date(occurredAt).getTime() < new Date(last).getTime();

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

interface ShipRow { id: string; store_id: string; user_id: string; seller_order_ids: string[]; status: ShipmentStatus; attempts: number; cod_amount_minor: string; courier: string; awb: string; last_event_at: Date | string | null }
const SHIP_COLS = "id, store_id, user_id, seller_order_ids, status, attempts, cod_amount_minor::text AS cod_amount_minor, courier, awb, last_event_at";

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
    const bytes = Buffer.byteLength(rawBody, "utf8");
    // C5: oversize bodies are refused before any hashing, parsing or storage.
    if (bytes > MAX_WEBHOOK_BYTES) throw new ShippingError("INVALID_INPUT", "webhook body too large");
    if (!this.d.webhook.verify(rawBody, headers, this.now())) {
      // C5: an unauthenticated body is attacker-controlled: keep only its digest and size (one row per distinct digest), never the content.
      const sha = createHash("sha256").update(rawBody).digest("hex");
      await this.tx((tx) => tx.query(
        `INSERT INTO courier_events_raw (id, market_id, courier_code, courier_event_id, signature_ok, body_ct, body_sha256, body_bytes, processing_status, received_at)
         VALUES ($1,$2,$3,$4,false,NULL,$5,$6,'rejected',$7::timestamptz) ON CONFLICT (courier_code, courier_event_id) DO NOTHING`,
        [this.newId(), this.d.marketId, this.d.courierCode, `invalid:${sha}`, sha, bytes, this.now().toISOString()]));
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
    const body = await this.d.cipher.encrypt(JSON.stringify(e), `courier_events_raw.body_ct:${rawId}`);
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
    // C4: an event older than the last applied one is out of order (a late delivery_failed must not trigger a premature RTO).
    if (isStale(peek.last_event_at, norm.occurredAt)) { await finish("ignored", "stale_order", peek.id); return "ignored"; }
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
      if (isStale(s.last_event_at, norm.occurredAt)) return "stale" as const;
      const at = norm.occurredAt;
      const st = r.state.status;
      await tx.query(
        `UPDATE shipments SET status = $2, attempts = $3, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN $4::timestamptz ELSE delivered_at END, last_event_at = $4::timestamptz, version = version + 1, updated_at = $5::timestamptz WHERE id = $1`,
        [s.id, st, r.state.attempts, at, this.now().toISOString()]);
      const base = { shipment_id: s.id, store_id: s.store_id, user_id: s.user_id };
      if (SELLER_ACCESS_TERMINAL.has(st)) {
        // C3: shorten (never extend) the seller window to 30 days after the terminal event.
        await tx.query("UPDATE delivery_snapshots SET seller_access_until = LEAST(COALESCE(seller_access_until, $2::timestamptz), $2::timestamptz) WHERE seller_order_id = ANY($1::uuid[])", [s.seller_order_ids, new Date(new Date(at).getTime() + SELLER_ACCESS_MS).toISOString()]);
      }
      if (st === "DELIVERED") {
        for (const so of s.seller_order_ids) await this.emit(tx, "seller_order.delivered", "seller_order", so, at, { seller_order_id: so, store_id: s.store_id, user_id: s.user_id });
        if (BigInt(s.cod_amount_minor) > 0n) await this.emit(tx, "shipment.cod_collected", "shipment", s.id, at, { ...base, courier: s.courier, amount_minor: s.cod_amount_minor });
      }
      if (st === "RTO") await this.emit(tx, "shipment.rto", "shipment", s.id, at, { ...base, attempts: r.state.attempts, seller_order_ids: s.seller_order_ids.join(",") });
      await tx.query("UPDATE courier_events_raw SET processing_status = 'processed', shipment_id = $2, processed_at = $3::timestamptz WHERE id = $1", [raw.id, s.id, this.now().toISOString()]);
      return "applied" as const;
    });
    if (done === "stale") { await finish("ignored", "stale_order", peek.id); return "ignored"; }
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

/**
 * Retention for delivery snapshots (C3, job shipping.tracking): once seller_access_until has passed, the five ciphertext columns are nulled
 * and pseudonymised_at stamped. Idempotent; the owning row (ids, area, timestamps) stays for the order record.
 */
export class SnapshotRetention extends Base {
  async purgeExpiredSnapshots(now: Date = this.now(), limit = 500): Promise<number> {
    return this.tx(async (tx) => (await tx.query(
      `UPDATE delivery_snapshots SET recipient_name_ct = NULL, phone_ct = NULL, phone_masked_ct = NULL, address_ct = NULL, pin_ct = NULL, pseudonymised_at = $1::timestamptz
        WHERE seller_order_id IN (SELECT seller_order_id FROM delivery_snapshots WHERE market_id = $2 AND pseudonymised_at IS NULL AND seller_access_until <= $1::timestamptz ORDER BY seller_access_until LIMIT $3::int)
        RETURNING seller_order_id`, [now.toISOString(), this.d.marketId, limit])).rows.length);
  }
}
