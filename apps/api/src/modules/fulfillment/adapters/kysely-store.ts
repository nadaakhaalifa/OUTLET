import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { SHIPMENT_STATES, money, shipmentMachine, type CodStatus } from "../domain/bridge";
import type {
  AwbJob,
  FulfillmentRepository,
  LabelStatus,
  OutboxEvent,
  RawDelivery,
  RawStatus,
  RecordRawResult,
  RemittanceRecord,
  ShipmentEventRecord,
  ShipmentRecord,
  ShipmentUpdate,
} from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the cart and inventory adapters). */
export type FulfillmentDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const COD_STATUSES = ["NONE", "PENDING", "COLLECTED", "REMITTED", "MISMATCH"] as const;

const ShipmentRow = z.object({
  id: z.string(),
  store_id: z.string(),
  seller_order_id: z.string(),
  courier_code: z.string(),
  awb: z.string().nullable(),
  status: z.enum(SHIPMENT_STATES),
  attempts_made: z.number().int(),
  cod_amount: Amount.nullable(),
  cod_status: z.enum(COD_STATUSES),
  label_status: z.enum(["PENDING", "READY", "FAILED"]),
  parcel_weight_g: z.number().int(),
  pieces: z.number().int(),
  picked_ms: Ms.nullable(),
  delivered_ms: Ms.nullable(),
  version: z.number().int(),
  created_ms: Ms,
});

const EventRow = z.object({
  id: z.string(),
  shipment_id: z.string(),
  courier_event_id: z.string(),
  kind: z.string(),
  outcome: z.enum(["APPLIED", "IGNORED_STALE", "IGNORED_INVALID"]),
  from_status: z.enum(SHIPMENT_STATES),
  to_status: z.enum(SHIPMENT_STATES),
  reason_code: z.string().nullable(),
  occurred_ms: Ms,
  recorded_ms: Ms,
});

const JobRow = z.object({
  shipment_id: z.string(),
  status: z.enum(["PENDING", "DONE", "DEAD"]),
  attempts: z.number().int(),
  next_ms: Ms,
  last_error_code: z.string().nullable(),
});

const RemittanceHead = z.object({
  id: z.string(),
  courier_code: z.string(),
  courier_ref: z.string(),
  remittance_date: z.string(),
  total_amount: Amount,
  status: z.enum(["RECEIVED", "MATCHED", "PARTIALLY_MATCHED", "MISMATCH"]),
  received_ms: Ms,
});
const RemittanceLine = z.object({
  awb: z.string(),
  shipment_id: z.string().nullable(),
  collected_amount: Amount,
  fee_amount: Amount,
  match_status: z.enum(["MATCHED", "AMOUNT_DIFF", "UNKNOWN_AWB", "NOT_COD"]),
});

const iso = (ms: number): string => new Date(ms).toISOString();

const SHIPMENT_COLS = sql.raw(`
  id::text as id, store_id::text as store_id, seller_order_id::text as seller_order_id, courier_code, awb,
  status, attempts_made, cod_amount::text as cod_amount, cod_status, label_status, parcel_weight_g, pieces,
  floor(extract(epoch from picked_up_at) * 1000)::text as picked_ms,
  floor(extract(epoch from delivered_at) * 1000)::text as delivered_ms,
  version, floor(extract(epoch from created_at) * 1000)::text as created_ms`);

function toShipment(raw: unknown): ShipmentRecord {
  const r = ShipmentRow.parse(raw);
  return {
    id: r.id,
    storeId: r.store_id,
    sellerOrderId: r.seller_order_id,
    courierCode: r.courier_code,
    awb: r.awb,
    state: shipmentMachine.parseState(r.status),
    attemptsMade: r.attempts_made,
    codAmount: r.cod_amount === null ? null : money(r.cod_amount),
    codStatus: r.cod_status satisfies CodStatus,
    labelStatus: r.label_status satisfies LabelStatus,
    parcelWeightG: r.parcel_weight_g,
    pieces: r.pieces,
    pickedUpAtMs: r.picked_ms,
    deliveredAtMs: r.delivered_ms,
    version: r.version,
    createdAtMs: r.created_ms,
  };
}

const isUnique = (e: unknown, constraint?: string): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; constraint?: unknown };
  if (err.code !== "23505") return false;
  return constraint === undefined || err.constraint === constraint || err.constraint === undefined;
};

/**
 * Postgres adapter. Each call is one transaction under the `system` DB role (authorization is the
 * policy guard and the store-derived resolver; RLS stays on for every other role). Outbox events
 * are inserted in the same transaction as the state change (A2.7). Shipment writes are
 * compare-and-set on `shipments.version`. The AWB queue holds no lease between `dueJobs` and
 * `completeAwb`: one worker per courier is assumed, and a double attempt is safe because createAwb is
 * idempotent by shipment id and `completeAwb` is idempotent (a lease column is a listed gap).
 */
export class KyselyFulfillmentRepository implements FulfillmentRepository {
  constructor(private readonly db: FulfillmentDb) {}

  private async tx<T>(run: (trx: FulfillmentDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as FulfillmentDb);
    });
  }

  private async writeOutbox(trx: FulfillmentDb, events: readonly OutboxEvent[], nowIso: string): Promise<void> {
    for (const e of events) {
      await sql`
        insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${e.id}::uuid, ${nowIso}::timestamptz, 'shipment', ${e.aggregateId}::uuid, ${e.type},
                ${e.aggregateId}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
    }
  }

  async createShipment(
    s: ShipmentRecord,
    job: { readonly nextAttemptAtMs: number },
    outbox: readonly OutboxEvent[],
  ): Promise<"created" | "live_shipment_exists"> {
    try {
      return await this.tx(async (trx) => {
        await sql`
          insert into shipments (id, store_id, seller_order_id, seller_order_ids, courier_code, status, attempts_made,
                                 cod_amount, cod_status, label_status, parcel_weight_g, pieces, version, created_at)
          values (${s.id}::uuid, ${s.storeId}::uuid, ${s.sellerOrderId}::uuid, array[${s.sellerOrderId}::uuid],
                  ${s.courierCode}, ${s.state}, ${s.attemptsMade},
                  ${s.codAmount === null ? null : s.codAmount.amount.toString()}::bigint, ${s.codStatus},
                  ${s.labelStatus}, ${s.parcelWeightG}, ${s.pieces}, ${s.version}, ${iso(s.createdAtMs)}::timestamptz)`.execute(trx);
        await sql`
          insert into courier_awb_jobs (shipment_id, status, attempts, next_attempt_at, created_at)
          values (${s.id}::uuid, 'PENDING', 0, ${iso(job.nextAttemptAtMs)}::timestamptz, ${iso(s.createdAtMs)}::timestamptz)`.execute(trx);
        await this.writeOutbox(trx, outbox, iso(s.createdAtMs));
        return "created" as const;
      });
    } catch (e) {
      if (isUnique(e)) return "live_shipment_exists";
      throw e;
    }
  }

  async getShipment(id: string): Promise<ShipmentRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${SHIPMENT_COLS} from shipments where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toShipment(row);
    });
  }

  async findByAwb(courierCode: string, awb: string): Promise<ShipmentRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${SHIPMENT_COLS} from shipments where courier_code = ${courierCode} and awb = ${awb}`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toShipment(row);
    });
  }

  async findLiveBySellerOrder(sellerOrderId: string): Promise<ShipmentRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${SHIPMENT_COLS} from shipments
         where seller_order_id = ${sellerOrderId}::uuid
           and status not in ('CANCELLED', 'LOST', 'RETURNED_TO_SELLER')`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toShipment(row);
    });
  }

  async listEvents(shipmentId: string): Promise<readonly ShipmentEventRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, shipment_id::text as shipment_id, courier_event_id, kind, outcome, from_status,
               to_status, reason_code,
               floor(extract(epoch from occurred_at) * 1000)::text as occurred_ms,
               floor(extract(epoch from recorded_at) * 1000)::text as recorded_ms
          from shipment_events where shipment_id = ${shipmentId}::uuid order by occurred_at, seq`.execute(trx);
      return r.rows.map((raw): ShipmentEventRecord => {
        const e = EventRow.parse(raw);
        return {
          id: e.id,
          shipmentId: e.shipment_id,
          courierEventId: e.courier_event_id,
          kind: e.kind,
          outcome: e.outcome,
          fromStatus: e.from_status,
          toStatus: e.to_status,
          reasonCode: e.reason_code,
          occurredAtMs: e.occurred_ms,
          recordedAtMs: e.recorded_ms,
        };
      });
    });
  }

  async recordRaw(raw: RawDelivery): Promise<RecordRawResult> {
    return this.tx(async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into courier_events_raw (id, courier_code, courier_event_id, awb, body, received_at)
        values (${raw.id}::uuid, ${raw.courierCode}, ${raw.courierEventId}, ${raw.awb}, ${raw.body},
                ${iso(raw.receivedAtMs)}::timestamptz)
        on conflict (courier_code, courier_event_id) do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows.length > 0) return "new" as const;
      const cur = await sql<{ processing_status: RawStatus }>`
        select processing_status from courier_events_raw
         where courier_code = ${raw.courierCode} and courier_event_id = ${raw.courierEventId}`.execute(trx);
      const status = cur.rows[0]?.processing_status;
      return status === "RECEIVED" || status === "UNMATCHED" ? ("redelivered" as const) : ("duplicate" as const);
    });
  }

  async markRaw(courierCode: string, courierEventId: string, status: RawStatus, atMs: number): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        update courier_events_raw set processing_status = ${status}, processed_at = ${iso(atMs)}::timestamptz
         where courier_code = ${courierCode} and courier_event_id = ${courierEventId}`.execute(trx);
    });
  }

  async listUnmatchedRaw(courierCode: string, awb: string): Promise<readonly { courierEventId: string; body: string }[]> {
    return this.tx(async (trx) => {
      const r = await sql<{ courier_event_id: string; body: string }>`
        select courier_event_id, body from courier_events_raw
         where courier_code = ${courierCode} and awb = ${awb} and processing_status = 'UNMATCHED'
         order by received_at, id`.execute(trx);
      return r.rows.map((x) => ({ courierEventId: x.courier_event_id, body: x.body }));
    });
  }

  async applyTracking(input: {
    readonly shipmentId: string;
    readonly expectedVersion: number;
    readonly next: ShipmentRecord;
    readonly event: ShipmentEventRecord;
    readonly courierCode: string;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"ok" | "version_conflict" | "duplicate_event"> {
    const { next, event } = input;
    try {
      return await this.tx(async (trx) => {
        const locked = await sql<{ version: number }>`
          select version from shipments where id = ${input.shipmentId}::uuid for update`.execute(trx);
        if (locked.rows[0]?.version !== input.expectedVersion) return "version_conflict" as const;
        const dup = await sql`
          select 1 from shipment_events
           where shipment_id = ${input.shipmentId}::uuid and courier_event_id = ${event.courierEventId}`.execute(trx);
        if (dup.rows.length > 0) {
          await sql`
            update courier_events_raw set processing_status = 'PROCESSED', processed_at = ${iso(event.recordedAtMs)}::timestamptz
             where courier_code = ${input.courierCode} and courier_event_id = ${event.courierEventId}`.execute(trx);
          return "duplicate_event" as const;
        }
        await sql`
          insert into shipment_events (id, shipment_id, courier_event_id, kind, outcome, from_status, to_status,
                                       reason_code, occurred_at, recorded_at)
          values (${event.id}::uuid, ${event.shipmentId}::uuid, ${event.courierEventId}, ${event.kind}, ${event.outcome},
                  ${event.fromStatus}, ${event.toStatus}, ${event.reasonCode},
                  ${iso(event.occurredAtMs)}::timestamptz, ${iso(event.recordedAtMs)}::timestamptz)`.execute(trx);
        if (next.version !== input.expectedVersion) {
          await sql`
            update shipments
               set status = ${next.state}, attempts_made = ${next.attemptsMade}, cod_status = ${next.codStatus},
                   picked_up_at = ${next.pickedUpAtMs === null ? null : iso(next.pickedUpAtMs)}::timestamptz,
                   delivered_at = ${next.deliveredAtMs === null ? null : iso(next.deliveredAtMs)}::timestamptz,
                   version = ${next.version}
             where id = ${input.shipmentId}::uuid`.execute(trx);
        }
        await sql`
          update courier_events_raw set processing_status = 'PROCESSED', processed_at = ${iso(event.recordedAtMs)}::timestamptz
           where courier_code = ${input.courierCode} and courier_event_id = ${event.courierEventId}`.execute(trx);
        await this.writeOutbox(trx, input.outbox, iso(event.recordedAtMs));
        return "ok" as const;
      });
    } catch (e) {
      if (isUnique(e)) return "duplicate_event";
      throw e;
    }
  }

  async dueJobs(nowMs: number, limit: number): Promise<readonly AwbJob[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select shipment_id::text as shipment_id, status, attempts,
               floor(extract(epoch from next_attempt_at) * 1000)::text as next_ms, last_error_code
          from courier_awb_jobs
         where status = 'PENDING' and next_attempt_at <= ${iso(nowMs)}::timestamptz
         order by next_attempt_at, shipment_id limit ${limit}`.execute(trx);
      return r.rows.map((raw): AwbJob => {
        const j = JobRow.parse(raw);
        return { shipmentId: j.shipment_id, attempts: j.attempts };
      });
    });
  }

  async completeAwb(input: {
    readonly shipmentId: string;
    readonly awb: string;
    readonly nowMs: number;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"ok" | "awb_conflict" | "not_found"> {
    try {
      return await this.tx(async (trx) => {
        const cur = await sql<{ status: string; courier_code: string }>`
          select status, courier_code from shipments where id = ${input.shipmentId}::uuid for update`.execute(trx);
        const row = cur.rows[0];
        if (row === undefined) return "not_found" as const;
        await sql`
          update shipments
             set awb = ${input.awb}, label_status = 'READY', version = version + 1,
                 status = case when status = 'LABEL_PENDING' then 'LABEL_CREATED' else status end
           where id = ${input.shipmentId}::uuid`.execute(trx);
        await sql`
          update courier_awb_jobs set status = 'DONE', attempts = attempts + 1, last_error_code = null
           where shipment_id = ${input.shipmentId}::uuid`.execute(trx);
        await this.writeOutbox(trx, input.outbox, iso(input.nowMs));
        return "ok" as const;
      });
    } catch (e) {
      if (isUnique(e)) return "awb_conflict";
      throw e;
    }
  }

  async failAwb(input: {
    readonly shipmentId: string;
    readonly attempts: number;
    readonly nextAttemptAtMs: number | null;
    readonly errorCode: string;
    readonly nowMs: number;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<void> {
    await this.tx(async (trx) => {
      if (input.nextAttemptAtMs === null) {
        await sql`
          update courier_awb_jobs set status = 'DEAD', attempts = ${input.attempts}, last_error_code = ${input.errorCode}
           where shipment_id = ${input.shipmentId}::uuid`.execute(trx);
        await sql`
          update shipments set label_status = 'FAILED', version = version + 1 where id = ${input.shipmentId}::uuid`.execute(trx);
      } else {
        await sql`
          update courier_awb_jobs
             set attempts = ${input.attempts}, last_error_code = ${input.errorCode},
                 next_attempt_at = ${iso(input.nextAttemptAtMs)}::timestamptz
           where shipment_id = ${input.shipmentId}::uuid`.execute(trx);
      }
      await this.writeOutbox(trx, input.outbox, iso(input.nowMs));
    });
  }

  async getJob(shipmentId: string) {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select shipment_id::text as shipment_id, status, attempts,
               floor(extract(epoch from next_attempt_at) * 1000)::text as next_ms, last_error_code
          from courier_awb_jobs where shipment_id = ${shipmentId}::uuid`.execute(trx);
      const raw = r.rows[0];
      if (raw === undefined) return null;
      const j = JobRow.parse(raw);
      return { status: j.status, attempts: j.attempts, nextAttemptAtMs: j.next_ms, lastErrorCode: j.last_error_code };
    });
  }

  async requeueDead(shipmentId: string, nowMs: number): Promise<boolean> {
    return this.tx(async (trx) => {
      const r = await sql`
        update courier_awb_jobs
           set status = 'PENDING', attempts = 0, last_error_code = null, next_attempt_at = ${iso(nowMs)}::timestamptz
         where shipment_id = ${shipmentId}::uuid and status = 'DEAD'
        returning 1`.execute(trx);
      if (r.rows.length === 0) return false;
      await sql`
        update shipments set label_status = 'PENDING', version = version + 1 where id = ${shipmentId}::uuid`.execute(trx);
      return true;
    });
  }

  async recordRemittance(input: {
    readonly remittance: RemittanceRecord;
    readonly updates: readonly ShipmentUpdate[];
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"recorded" | "duplicate" | "version_conflict"> {
    const rem = input.remittance;
    try {
      return await this.tx(async (trx) => {
        const exists = await sql`
          select 1 from cod_remittances where courier_code = ${rem.courierCode} and courier_ref = ${rem.courierRef}`.execute(trx);
        if (exists.rows.length > 0) return "duplicate" as const;
        for (const u of input.updates) {
          const v = await sql<{ version: number }>`
            select version from shipments where id = ${u.shipmentId}::uuid for update`.execute(trx);
          if (v.rows[0]?.version !== u.expectedVersion) return "version_conflict" as const;
        }
        await sql`
          insert into cod_remittances (id, courier_code, courier_ref, remittance_date, total_amount, status, received_at)
          values (${rem.id}::uuid, ${rem.courierCode}, ${rem.courierRef}, ${rem.remittanceDate}::date,
                  ${rem.total.amount.toString()}::bigint, ${rem.status}, ${iso(rem.receivedAtMs)}::timestamptz)`.execute(trx);
        for (const l of rem.lines) {
          await sql`
            insert into cod_remittance_lines (remittance_id, awb, shipment_id, collected_amount, fee_amount, match_status)
            values (${rem.id}::uuid, ${l.awb}, ${l.shipmentId}::uuid, ${l.collected.amount.toString()}::bigint,
                    ${l.fee.amount.toString()}::bigint, ${l.match})`.execute(trx);
        }
        for (const u of input.updates) {
          await sql`
            update shipments set status = ${u.next.state}, cod_status = ${u.next.codStatus}, version = ${u.next.version}
             where id = ${u.shipmentId}::uuid`.execute(trx);
        }
        await this.writeOutbox(trx, input.outbox, iso(rem.receivedAtMs));
        return "recorded" as const;
      });
    } catch (e) {
      if (isUnique(e)) return "duplicate";
      throw e;
    }
  }

  async findRemittance(courierCode: string, courierRef: string): Promise<RemittanceRecord | null> {
    return this.tx(async (trx) => {
      const h = await sql<unknown>`
        select id::text as id, courier_code, courier_ref, remittance_date::text as remittance_date,
               total_amount::text as total_amount, status,
               floor(extract(epoch from received_at) * 1000)::text as received_ms
          from cod_remittances where courier_code = ${courierCode} and courier_ref = ${courierRef}`.execute(trx);
      const head = h.rows[0];
      if (head === undefined) return null;
      const r = RemittanceHead.parse(head);
      const ls = await sql<unknown>`
        select awb, shipment_id::text as shipment_id, collected_amount::text as collected_amount,
               fee_amount::text as fee_amount, match_status
          from cod_remittance_lines where remittance_id = ${r.id}::uuid order by awb`.execute(trx);
      return {
        id: r.id,
        courierCode: r.courier_code,
        courierRef: r.courier_ref,
        remittanceDate: r.remittance_date,
        total: money(r.total_amount),
        status: r.status,
        receivedAtMs: r.received_ms,
        lines: ls.rows.map((raw) => {
          const l = RemittanceLine.parse(raw);
          return {
            awb: l.awb,
            shipmentId: l.shipment_id,
            collected: money(l.collected_amount),
            fee: money(l.fee_amount),
            match: l.match_status,
          };
        }),
      };
    });
  }
}
