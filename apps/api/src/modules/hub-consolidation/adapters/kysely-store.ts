import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { LEG_STATES, moveLeg, type LegState } from "../domain/bridge";
import type {
  GroupRecord,
  HubEvent,
  HubRecord,
  HubStore,
  LegRecord,
  ParcelRecord,
  ReceiptRecord,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the reviews adapter. */
export type HubDb = Kysely<Record<string, never>>;

export interface IdPort {
  uuidV7(): string;
}

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();

const GroupRow = z.object({
  order_group_id: z.string(),
  user_id: z.string(),
  hub_id: z.string(),
  fee: Big,
  ship_together: z.boolean(),
  paid_ms: Ms,
});
const LegRow = z.object({
  seller_order_id: z.string(),
  order_group_id: z.string(),
  hub_id: z.string(),
  store_id: z.string(),
  state: z.enum(LEG_STATES),
  line_ids: z.array(z.string()),
  subtotal: Big,
  due_ms: Ms,
  consolidation_id: z.string().nullable(),
  version: z.number().int(),
});
const ParcelRow = z.object({
  id: z.string(),
  order_group_id: z.string(),
  hub_id: z.string(),
  seller_order_ids: z.array(z.string()),
  status: z.enum(["READY", "DISPATCHED"]),
  awb: z.string().nullable(),
  courier_code: z.string().nullable(),
  fee: Big,
  gco2e: Big.nullable(),
  factors_version: z.string().nullable(),
  created_ms: Ms,
  dispatched_ms: Ms.nullable(),
});
const ReceiptRow = z.object({
  id: z.string(),
  seller_order_id: z.string(),
  hub_id: z.string(),
  operator_id: z.string(),
  condition: z.enum(["ok", "damaged"]),
  scanned_ms: Ms,
});

const GROUP_COLS = sql`order_group_id::text as order_group_id, user_id::text as user_id, hub_id::text as hub_id,
  delivery_fee_piastres::text as fee, ship_together, ${EPOCH("paid_at")} as paid_ms`;
const LEG_COLS = sql`seller_order_id::text as seller_order_id, order_group_id::text as order_group_id,
  hub_id::text as hub_id, store_id::text as store_id, state, line_ids::text[] as line_ids,
  subtotal_piastres::text as subtotal, ${EPOCH("handoff_due_at")} as due_ms,
  consolidation_id::text as consolidation_id, version`;
const PARCEL_COLS = sql`id::text as id, order_group_id::text as order_group_id, hub_id::text as hub_id,
  seller_order_ids::text[] as seller_order_ids, status, awb, courier_code,
  shopper_fee_piastres::text as fee, gco2e_estimate::text as gco2e, co2e_factors_version as factors_version,
  ${EPOCH("created_at")} as created_ms, ${EPOCH("dispatched_at")} as dispatched_ms`;

const toGroup = (raw: unknown): GroupRecord => {
  const r = GroupRow.parse(raw);
  return { orderGroupId: r.order_group_id, userId: r.user_id, hubId: r.hub_id, deliveryFee: r.fee, shipTogether: r.ship_together, paidAtMs: r.paid_ms };
};
const toLeg = (raw: unknown): LegRecord => {
  const r = LegRow.parse(raw);
  return {
    sellerOrderId: r.seller_order_id,
    orderGroupId: r.order_group_id,
    hubId: r.hub_id,
    storeId: r.store_id,
    state: r.state,
    lineIds: r.line_ids,
    subtotal: r.subtotal,
    handoffDueAtMs: r.due_ms,
    consolidationId: r.consolidation_id,
    version: r.version,
  };
};
const toParcel = (raw: unknown): ParcelRecord => {
  const r = ParcelRow.parse(raw);
  return {
    id: r.id,
    orderGroupId: r.order_group_id,
    hubId: r.hub_id,
    sellerOrderIds: r.seller_order_ids,
    status: r.status,
    awb: r.awb,
    courierCode: r.courier_code,
    shopperFee: r.fee,
    gCo2e: r.gco2e,
    factorsVersion: r.factors_version,
    createdAtMs: r.created_ms,
    dispatchedAtMs: r.dispatched_ms,
  };
};

const aggregateOf = (e: HubEvent): { type: string; id: string } =>
  e.type === "hub.parcel_ready" || e.type === "hub.parcel_dispatched"
    ? { type: "hub_parcel", id: e.parcelId }
    : { type: "hub_leg", id: e.sellerOrderId };

/** Outbox payload: ids, enums and integers only (no recipient data). */
const payloadOf = (e: HubEvent): Record<string, string | number | boolean> => {
  switch (e.type) {
    case "hub.receipt_recorded":
      return { order_group_id: e.orderGroupId, seller_order_id: e.sellerOrderId, condition: e.condition };
    case "hub.leg_exception":
      return { order_group_id: e.orderGroupId, seller_order_id: e.sellerOrderId };
    case "hub.parcel_ready":
      return { order_group_id: e.orderGroupId, parcel_id: e.parcelId, leg_count: e.legCount, split: e.split };
    case "hub.parcel_dispatched":
      return { order_group_id: e.orderGroupId, parcel_id: e.parcelId, awb: e.awb, courier: e.courierCode, gco2e: e.gco2e };
  }
};

/** Postgres adapter: one transaction per method under the `system` role; outbox in the same tx. */
export class KyselyHubStore implements HubStore {
  constructor(
    private readonly db: HubDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: HubDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as HubDb);
    });
  }

  private async emit(trx: HubDb, events: readonly HubEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  async upsertHub(h: HubRecord): Promise<void> {
    await this.tx(async (trx) => {
      await sql`insert into hubs (id, name, governorate) values (${h.id}::uuid, ${h.name}, ${h.governorate})
        on conflict (id) do update set name = excluded.name, governorate = excluded.governorate`.execute(trx);
    });
  }

  async getHub(id: string): Promise<HubRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<{ id: string; name: string; governorate: string }>`
        select id::text as id, name, governorate from hubs where id = ${id}::uuid`.execute(trx);
      return r.rows[0] ?? null;
    });
  }

  async openGroup(group: GroupRecord, legs: readonly LegRecord[]): Promise<"opened" | "exists"> {
    return this.tx(async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into hub_order_groups (order_group_id, user_id, hub_id, delivery_fee_piastres, ship_together, paid_at)
        values (${group.orderGroupId}::uuid, ${group.userId}::uuid, ${group.hubId}::uuid,
                ${group.deliveryFee.toString()}::bigint, ${group.shipTogether}, ${iso(group.paidAtMs)}::timestamptz)
        on conflict (order_group_id) do nothing returning order_group_id::text as id`.execute(trx);
      if (ins.rows[0] === undefined) return "exists";
      for (const l of legs) {
        await sql`
          insert into hub_legs (seller_order_id, order_group_id, hub_id, store_id, state, line_ids,
            subtotal_piastres, handoff_due_at)
          values (${l.sellerOrderId}::uuid, ${l.orderGroupId}::uuid, ${l.hubId}::uuid, ${l.storeId}::uuid,
            ${l.state}, ${`{${l.lineIds.join(",")}}`}::uuid[], ${l.subtotal.toString()}::bigint,
            ${iso(l.handoffDueAtMs)}::timestamptz)`.execute(trx);
      }
      return "opened";
    });
  }

  async getGroup(id: string): Promise<GroupRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${GROUP_COLS} from hub_order_groups where order_group_id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toGroup(r.rows[0]);
    });
  }

  async getLeg(id: string): Promise<LegRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LEG_COLS} from hub_legs where seller_order_id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toLeg(r.rows[0]);
    });
  }

  async listLegs(orderGroupId: string): Promise<readonly LegRecord[]> {
    if (!UUID.test(orderGroupId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${LEG_COLS} from hub_legs where order_group_id = ${orderGroupId}::uuid
        order by seller_order_id`.execute(trx);
      return r.rows.map(toLeg);
    });
  }

  async getParcel(id: string): Promise<ParcelRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${PARCEL_COLS} from consolidated_shipments where id = ${id}::uuid`.execute(trx);
      return r.rows[0] === undefined ? null : toParcel(r.rows[0]);
    });
  }

  async listParcels(orderGroupId: string): Promise<readonly ParcelRecord[]> {
    if (!UUID.test(orderGroupId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${PARCEL_COLS} from consolidated_shipments
        where order_group_id = ${orderGroupId}::uuid order by created_at, id`.execute(trx);
      return r.rows.map(toParcel);
    });
  }

  async listParcelsPage(limit: number, after: { createdAtMs: number; id: string } | null): Promise<readonly ParcelRecord[]> {
    return this.tx(async (trx) => {
      const lim = Math.max(1, Math.min(limit, 101));
      const r =
        after === null
          ? await sql<unknown>`select ${PARCEL_COLS} from consolidated_shipments order by created_at desc, id desc limit ${lim}`.execute(trx)
          : await sql<unknown>`select ${PARCEL_COLS} from consolidated_shipments
              where (created_at, id) < (${new Date(after.createdAtMs).toISOString()}::timestamptz, ${after.id}::uuid)
              order by created_at desc, id desc limit ${lim}`.execute(trx);
      return r.rows.map(toParcel);
    });
  }

  async listLegsForStores(i: { storeIds: readonly string[]; orderGroupId: string | null; limit: number; afterId: string | null }): Promise<readonly LegRecord[]> {
    const stores = i.storeIds.filter((x) => UUID.test(x));
    if (stores.length === 0) return [];
    if (i.orderGroupId !== null && !UUID.test(i.orderGroupId)) return [];
    if (i.afterId !== null && !UUID.test(i.afterId)) return [];
    return this.tx(async (trx) => {
      const lim = Math.max(1, Math.min(i.limit, 101));
      const r = await sql<unknown>`select ${LEG_COLS} from hub_legs
        where store_id = any(${stores}::uuid[])
          and (${i.orderGroupId}::uuid is null or order_group_id = ${i.orderGroupId}::uuid)
          and (${i.afterId}::uuid is null or seller_order_id > ${i.afterId}::uuid)
        order by seller_order_id limit ${lim}`.execute(trx);
      return r.rows.map(toLeg);
    });
  }

  async getReceipt(sellerOrderId: string): Promise<ReceiptRecord | null> {
    if (!UUID.test(sellerOrderId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, seller_order_id::text as seller_order_id, hub_id::text as hub_id,
          operator_id::text as operator_id, condition, ${EPOCH("scanned_at")} as scanned_ms
        from hub_receipts where seller_order_id = ${sellerOrderId}::uuid`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      const p = ReceiptRow.parse(row);
      return {
        id: p.id,
        sellerOrderId: p.seller_order_id,
        hubId: p.hub_id,
        operatorId: p.operator_id,
        condition: p.condition,
        scannedAtMs: p.scanned_ms,
      };
    });
  }

  async recordReceipt(input: {
    receipt: ReceiptRecord;
    expectedVersion: number;
    next: LegState;
    events: readonly HubEvent[];
  }): Promise<"ok" | "duplicate" | "conflict"> {
    return this.tx(async (trx) => {
      const cur = await sql<{ state: LegState; version: number }>`
        select state, version from hub_legs where seller_order_id = ${input.receipt.sellerOrderId}::uuid for update`.execute(trx);
      const leg = cur.rows[0];
      if (leg === undefined || leg.version !== input.expectedVersion) return "conflict";
      const ins = await sql<{ id: string }>`
        insert into hub_receipts (id, seller_order_id, hub_id, operator_id, condition, scanned_at)
        values (${input.receipt.id}::uuid, ${input.receipt.sellerOrderId}::uuid, ${input.receipt.hubId}::uuid,
          ${input.receipt.operatorId}::uuid, ${input.receipt.condition}, ${iso(input.receipt.scannedAtMs)}::timestamptz)
        on conflict (seller_order_id) do nothing returning id::text as id`.execute(trx);
      if (ins.rows[0] === undefined) return "duplicate";
      const to = moveLeg(leg.state, input.next);
      await sql`update hub_legs set state = ${to}, version = version + 1, updated_at = now()
        where seller_order_id = ${input.receipt.sellerOrderId}::uuid`.execute(trx);
      await this.emit(trx, input.events);
      return "ok";
    });
  }

  async createParcel(input: {
    parcel: ParcelRecord;
    legs: readonly { sellerOrderId: string; expectedVersion: number }[];
    events: readonly HubEvent[];
  }): Promise<"ok" | "conflict"> {
    return this.tx(async (trx) => {
      const ids = [...input.legs].map((l) => l.sellerOrderId).sort();
      for (const id of ids) {
        const want = input.legs.find((l) => l.sellerOrderId === id);
        const r = await sql<{ state: string; version: number }>`
          select state, version from hub_legs where seller_order_id = ${id}::uuid for update`.execute(trx);
        const cur = r.rows[0];
        if (cur === undefined || cur.state !== "RECEIVED" || cur.version !== want?.expectedVersion) return "conflict";
      }
      const p = input.parcel;
      await sql`
        insert into consolidated_shipments (id, order_group_id, hub_id, seller_order_ids, status,
          shopper_fee_piastres, created_at)
        values (${p.id}::uuid, ${p.orderGroupId}::uuid, ${p.hubId}::uuid, ${`{${p.sellerOrderIds.join(",")}}`}::uuid[],
          'READY', ${p.shopperFee.toString()}::bigint, ${iso(p.createdAtMs)}::timestamptz)`.execute(trx);
      for (const id of ids) {
        await sql`update hub_legs set state = 'CONSOLIDATED', consolidation_id = ${p.id}::uuid,
          version = version + 1, updated_at = now() where seller_order_id = ${id}::uuid`.execute(trx);
      }
      await this.emit(trx, input.events);
      return "ok";
    });
  }

  async dispatchParcel(input: {
    parcelId: string;
    awb: string;
    courierCode: string;
    estimate: { gCo2e: bigint; factorsVersion: string };
    nowMs: number;
    events: readonly HubEvent[];
  }): Promise<"ok" | "not_ready" | "not_found"> {
    return this.tx(async (trx) => {
      const cur = await sql<{ status: string }>`
        select status from consolidated_shipments where id = ${input.parcelId}::uuid for update`.execute(trx);
      const row = cur.rows[0];
      if (row === undefined) return "not_found";
      if (row.status !== "READY") return "not_ready";
      await sql`update consolidated_shipments set status = 'DISPATCHED', awb = ${input.awb},
        courier_code = ${input.courierCode}, gco2e_estimate = ${input.estimate.gCo2e.toString()}::bigint,
        co2e_factors_version = ${input.estimate.factorsVersion}, dispatched_at = ${iso(input.nowMs)}::timestamptz
        where id = ${input.parcelId}::uuid`.execute(trx);
      await sql`update hub_legs set state = 'DISPATCHED', version = version + 1, updated_at = now()
        where consolidation_id = ${input.parcelId}::uuid and state = 'CONSOLIDATED'`.execute(trx);
      await this.emit(trx, input.events);
      return "ok";
    });
  }

  async groupsWithOpenLegs(limit: number): Promise<readonly GroupRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${GROUP_COLS} from hub_order_groups g
        where exists (select 1 from hub_legs l where l.order_group_id = g.order_group_id
                      and l.state in ('AT_HUB_EXPECTED', 'RECEIVED'))
        order by paid_at, order_group_id limit ${limit}`.execute(trx);
      return r.rows.map(toGroup);
    });
  }
}
