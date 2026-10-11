import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  REFUND_PREFERENCES,
  REJECTION_REASONS,
  RETURN_METHODS,
  RETURN_REASONS,
  RETURN_RESOLUTIONS,
  RETURN_STATES,
  SHIPPING_PAYERS,
  money,
  type RefundAllocation,
} from "../domain/bridge";
import type {
  CreateOutcome,
  DisputeRecord,
  EvidenceRecord,
  Page,
  ReturnRecord,
  ReturnRepository,
  StandingRecord,
} from "../domain/ports";
import { decodeCursor, encodeCursor } from "../domain/cursor";

/** Raw SQL only, rows validated with Zod (same approach as the cart and inventory adapters). */
export type ReturnsDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = z.string().regex(/^\d+$/).transform((s) => BigInt(s));

const Snapshot = z.object({
  qtyOrdered: z.number().int(),
  unitPrice: Amount,
  discountAlloc: Amount,
  deliveryFeeAlloc: Amount,
});
const AllocLine = z.object({
  orderLineId: z.string(),
  qty: z.number().int(),
  itemAmount: Amount,
  voucherShare: Amount,
  deliveryFeeShare: Amount,
  netAmount: Amount,
});
const Alloc = z.object({
  lines: z.array(AllocLine),
  itemTotal: Amount,
  voucherTotal: Amount,
  deliveryFeeTotal: Amount,
  netTotal: Amount,
});

const ReturnRow = z.object({
  id: z.string(),
  user_id: z.string(),
  order_line_id: z.string(),
  seller_order_id: z.string(),
  store_id: z.string(),
  qty: z.number().int(),
  prior_qty: z.number().int(),
  reason: z.enum(RETURN_REASONS),
  resolution: z.enum(RETURN_RESOLUTIONS),
  exchange_sku_id: z.string().nullable(),
  refund_preference: z.enum(REFUND_PREFERENCES),
  method: z.enum(RETURN_METHODS),
  state: z.enum(RETURN_STATES),
  shipping_payer: z.enum(SHIPPING_PAYERS),
  delivered_ms: Ms,
  window_ends_ms: Ms,
  note: z.string().nullable(),
  received_ms: Ms.nullable(),
  inspection_due_ms: Ms.nullable(),
  inspected_ms: Ms.nullable(),
  inspection_note: z.string().nullable(),
  inspection_result: z.enum(["approved", "auto_approved", "rejected"]).nullable(),
  rejection_reason: z.enum(REJECTION_REASONS).nullable(),
  dispute_window_ends_ms: Ms.nullable(),
  delivery_fee_refundable: z.boolean(),
  line_snapshot: Snapshot,
  refund_intent: Alloc.nullable(),
  intent_published_ms: Ms.nullable(),
  idempotency_key: z.string(),
  version: z.number().int(),
  created_ms: Ms,
});
const EvidenceRow = z.object({
  return_id: z.string(),
  upload_id: z.string(),
  kind: z.enum(["shopper_photo", "inspection_photo", "dispute_photo"]),
  uploaded_by_type: z.enum(["shopper", "seller", "hub", "trust_safety"]),
  uploaded_by_id: z.string(),
  uploaded_ms: Ms,
});
const DisputeRow = z.object({
  id: z.string(),
  return_id: z.string(),
  status: z.enum(["OPEN", "UNDER_REVIEW", "RESOLVED_FOR_SHOPPER", "RESOLVED_FOR_SELLER"]),
  statement: z.string(),
  review_due_ms: Ms,
  decided_ms: Ms.nullable(),
  created_ms: Ms,
});
const StandingRow = z.object({
  user_id: z.string(),
  delivered_orders_6m: z.number().int(),
  returned_orders_6m: z.number().int(),
  rate_bps: z.number().int(),
  free_returns_removed: z.boolean(),
  notice_ms: Ms.nullable(),
  evaluated_ms: Ms,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));
const T = (col: string, alias: string): string => `floor(extract(epoch from ${col}) * 1000)::text as ${alias}`;

const RETURN_COLUMNS = sql.raw(`
  r.id::text as id, r.user_id::text as user_id, r.order_line_id::text as order_line_id,
  r.seller_order_id::text as seller_order_id, r.store_id::text as store_id, r.qty, r.prior_qty,
  r.reason, r.resolution, r.exchange_sku_id::text as exchange_sku_id, r.refund_preference, r.method,
  r.state, r.shipping_payer, ${T("r.delivered_at", "delivered_ms")}, ${T("r.window_ends_at", "window_ends_ms")},
  r.note, ${T("r.received_at", "received_ms")}, ${T("r.inspection_due_at", "inspection_due_ms")},
  ${T("r.inspected_at", "inspected_ms")}, r.inspection_note, r.inspection_result, r.rejection_reason,
  ${T("r.dispute_window_ends_at", "dispute_window_ends_ms")}, r.delivery_fee_refundable, r.line_snapshot,
  r.refund_intent, ${T("r.intent_published_at", "intent_published_ms")}, r.idempotency_key, r.version,
  ${T("r.created_at", "created_ms")}`);

const snapshotJson = (s: ReturnRecord["lineSnapshot"]): string =>
  JSON.stringify({
    qtyOrdered: s.qtyOrdered,
    unitPrice: s.unitPrice.amount.toString(),
    discountAlloc: s.discountAlloc.amount.toString(),
    deliveryFeeAlloc: s.deliveryFeeAlloc.amount.toString(),
  });

const allocJson = (a: RefundAllocation | null): string | null =>
  a === null
    ? null
    : JSON.stringify({
        lines: a.lines.map((l) => ({
          orderLineId: l.orderLineId,
          qty: l.qty,
          itemAmount: l.itemAmount.amount.toString(),
          voucherShare: l.voucherShare.amount.toString(),
          deliveryFeeShare: l.deliveryFeeShare.amount.toString(),
          netAmount: l.netAmount.amount.toString(),
        })),
        itemTotal: a.itemTotal.amount.toString(),
        voucherTotal: a.voucherTotal.amount.toString(),
        deliveryFeeTotal: a.deliveryFeeTotal.amount.toString(),
        netTotal: a.netTotal.amount.toString(),
      });

const OPEN_STATES: readonly string[] = [
  "REQUESTED",
  "PICKUP_SCHEDULED",
  "IN_TRANSIT",
  "RECEIVED",
  "APPROVED",
  "REJECTED",
  "DISPUTED",
];

type Fragment = ReturnType<typeof sql>;

/**
 * Postgres adapter over migration 0020. One `system`-role transaction per call (authorization is
 * the policy guard and the owner-derived resolvers; RLS stays on for every other role).
 * Concurrency: `save` is a compare-and-set on `returns.version`; `createIfCapacity` serialises per
 * order line with a transaction-scoped advisory lock so two requests can never exceed the line.
 */
export class KyselyReturnRepository implements ReturnRepository {
  constructor(private readonly db: ReturnsDb) {}

  private async tx<X>(run: (trx: ReturnsDb) => Promise<X>): Promise<X> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as ReturnsDb);
    });
  }

  private async hydrate(trx: ReturnsDb, rows: readonly unknown[]): Promise<ReturnRecord[]> {
    const parsed = rows.map((r) => ReturnRow.parse(r));
    if (parsed.length === 0) return [];
    const ids = parsed.map((p) => p.id);
    const ev = await sql<unknown>`
      select return_id::text as return_id, upload_id::text as upload_id, kind, uploaded_by_type,
             uploaded_by_id::text as uploaded_by_id, floor(extract(epoch from uploaded_at) * 1000)::text as uploaded_ms
        from return_evidence where return_id::text = any (${ids}::text[]) order by uploaded_at, id`.execute(trx);
    const ds = await sql<unknown>`
      select id::text as id, return_id::text as return_id, status, statement,
             floor(extract(epoch from review_due_at) * 1000)::text as review_due_ms,
             floor(extract(epoch from decided_at) * 1000)::text as decided_ms,
             floor(extract(epoch from created_at) * 1000)::text as created_ms
        from return_disputes where return_id::text = any (${ids}::text[])`.execute(trx);
    const evBy = new Map<string, EvidenceRecord[]>();
    for (const raw of ev.rows) {
      const e = EvidenceRow.parse(raw);
      const list = evBy.get(e.return_id) ?? [];
      list.push({
        uploadId: e.upload_id,
        kind: e.kind,
        uploadedByType: e.uploaded_by_type,
        uploadedById: e.uploaded_by_id,
        uploadedAtMs: e.uploaded_ms,
      });
      evBy.set(e.return_id, list);
    }
    const dBy = new Map<string, DisputeRecord>();
    for (const raw of ds.rows) {
      const d = DisputeRow.parse(raw);
      dBy.set(d.return_id, {
        id: d.id,
        returnId: d.return_id,
        status: d.status,
        statement: d.statement,
        reviewDueAtMs: d.review_due_ms,
        decidedAtMs: d.decided_ms,
        createdAtMs: d.created_ms,
      });
    }
    return parsed.map((p) => ({
      id: p.id,
      userId: p.user_id,
      orderLineId: p.order_line_id,
      sellerOrderId: p.seller_order_id,
      storeId: p.store_id,
      qty: p.qty,
      priorQty: p.prior_qty,
      reason: p.reason,
      resolution: p.resolution,
      exchangeSkuId: p.exchange_sku_id,
      refundPreference: p.refund_preference,
      method: p.method,
      state: p.state,
      shippingPayer: p.shipping_payer,
      deliveredAtMs: p.delivered_ms,
      windowEndsAtMs: p.window_ends_ms,
      note: p.note,
      receivedAtMs: p.received_ms,
      inspectionDueAtMs: p.inspection_due_ms,
      inspectedAtMs: p.inspected_ms,
      inspectionNote: p.inspection_note,
      inspectionResult: p.inspection_result,
      rejectionReason: p.rejection_reason,
      disputeWindowEndsAtMs: p.dispute_window_ends_ms,
      deliveryFeeRefundable: p.delivery_fee_refundable,
      lineSnapshot: {
        qtyOrdered: p.line_snapshot.qtyOrdered,
        unitPrice: money(p.line_snapshot.unitPrice),
        discountAlloc: money(p.line_snapshot.discountAlloc),
        deliveryFeeAlloc: money(p.line_snapshot.deliveryFeeAlloc),
      },
      refundIntent:
        p.refund_intent === null
          ? null
          : {
              currency: "EGP" as const,
              lines: p.refund_intent.lines.map((l) => ({
                orderLineId: l.orderLineId,
                qty: l.qty,
                itemAmount: money(l.itemAmount),
                voucherShare: money(l.voucherShare),
                deliveryFeeShare: money(l.deliveryFeeShare),
                netAmount: money(l.netAmount),
              })),
              itemTotal: money(p.refund_intent.itemTotal),
              voucherTotal: money(p.refund_intent.voucherTotal),
              deliveryFeeTotal: money(p.refund_intent.deliveryFeeTotal),
              netTotal: money(p.refund_intent.netTotal),
            },
      intentPublishedAtMs: p.intent_published_ms,
      idempotencyKey: p.idempotency_key,
      version: p.version,
      createdAtMs: p.created_ms,
      evidence: evBy.get(p.id) ?? [],
      dispute: dBy.get(p.id) ?? null,
    }));
  }

  private async one(trx: ReturnsDb, where: Fragment): Promise<ReturnRecord | null> {
    const r = await sql<unknown>`select ${RETURN_COLUMNS} from returns r where ${where} limit 1`.execute(trx);
    return (await this.hydrate(trx, r.rows))[0] ?? null;
  }

  async findById(id: string): Promise<ReturnRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx((trx) => this.one(trx, sql`r.id = ${id}::uuid`));
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<ReturnRecord | null> {
    if (!UUID.test(userId)) return null;
    return this.tx((trx) => this.one(trx, sql`r.user_id = ${userId}::uuid and r.idempotency_key = ${key}`));
  }

  private async insertEvidence(trx: ReturnsDb, returnId: string, rows: readonly EvidenceRecord[]): Promise<void> {
    for (const e of rows) {
      await sql`
        insert into return_evidence (return_id, upload_id, kind, uploaded_by_type, uploaded_by_id, uploaded_at)
        values (${returnId}::uuid, ${e.uploadId}::uuid, ${e.kind}, ${e.uploadedByType}, ${e.uploadedById}::uuid,
                ${iso(e.uploadedAtMs)}::timestamptz)
        on conflict (return_id, upload_id) do nothing`.execute(trx);
    }
  }

  async createIfCapacity(record: ReturnRecord, lineQty: number): Promise<CreateOutcome> {
    return this.tx(async (trx): Promise<CreateOutcome> => {
      await sql`select pg_advisory_xact_lock(hashtext(${record.orderLineId}))`.execute(trx);
      const dup = await this.one(trx, sql`r.user_id = ${record.userId}::uuid and r.idempotency_key = ${record.idempotencyKey}`);
      if (dup !== null) return { kind: "duplicate", record: dup };
      const sum = await sql<{ n: string }>`
        select coalesce(sum(qty), 0)::text as n from returns
         where order_line_id = ${record.orderLineId}::uuid and state <> 'CANCELLED'`.execute(trx);
      const committed = Number(sum.rows[0]?.n ?? "0");
      if (committed !== record.priorQty) return { kind: "conflict" };
      if (committed + record.qty > lineQty) return { kind: "over_capacity" };
      await sql`
        insert into returns (id, user_id, order_line_id, seller_order_id, store_id, qty, prior_qty, reason, resolution,
                             exchange_sku_id, refund_preference, method, state, shipping_payer, delivered_at, window_ends_at,
                             note, delivery_fee_refundable, line_snapshot, idempotency_key, version, created_at)
        values (${record.id}::uuid, ${record.userId}::uuid, ${record.orderLineId}::uuid, ${record.sellerOrderId}::uuid,
                ${record.storeId}::uuid, ${record.qty}, ${record.priorQty}, ${record.reason}, ${record.resolution},
                ${record.exchangeSkuId}::uuid, ${record.refundPreference}, ${record.method}, ${record.state},
                ${record.shippingPayer}, ${iso(record.deliveredAtMs)}::timestamptz, ${iso(record.windowEndsAtMs)}::timestamptz,
                ${record.note}, ${record.deliveryFeeRefundable}, ${snapshotJson(record.lineSnapshot)}::jsonb,
                ${record.idempotencyKey}, ${record.version}, ${iso(record.createdAtMs)}::timestamptz)`.execute(trx);
      await this.insertEvidence(trx, record.id, record.evidence);
      return { kind: "created", record };
    });
  }

  async committedQty(orderLineId: string): Promise<number> {
    if (!UUID.test(orderLineId)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select coalesce(sum(qty), 0)::text as n from returns
         where order_line_id = ${orderLineId}::uuid and state <> 'CANCELLED'`.execute(trx);
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  async exchangeCount(orderLineId: string): Promise<number> {
    if (!UUID.test(orderLineId)) return 0;
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from returns
         where order_line_id = ${orderLineId}::uuid and state <> 'CANCELLED' and resolution = 'exchange'`.execute(trx);
      return Number(r.rows[0]?.n ?? "0");
    });
  }

  async save(record: ReturnRecord, expectedVersion: number): Promise<boolean> {
    return this.tx(async (trx) => {
      const upd = await sql<{ id: string }>`
        update returns set
          state = ${record.state}, received_at = ${isoOrNull(record.receivedAtMs)}::timestamptz,
          inspection_due_at = ${isoOrNull(record.inspectionDueAtMs)}::timestamptz,
          inspected_at = ${isoOrNull(record.inspectedAtMs)}::timestamptz, inspection_note = ${record.inspectionNote},
          inspection_result = ${record.inspectionResult}, rejection_reason = ${record.rejectionReason},
          dispute_window_ends_at = ${isoOrNull(record.disputeWindowEndsAtMs)}::timestamptz,
          refund_intent = ${allocJson(record.refundIntent)}::jsonb,
          intent_published_at = ${isoOrNull(record.intentPublishedAtMs)}::timestamptz,
          version = ${record.version}
         where id = ${record.id}::uuid and version = ${expectedVersion}
        returning id::text as id`.execute(trx);
      if (upd.rows.length === 0) return false;
      await this.insertEvidence(trx, record.id, record.evidence);
      const d = record.dispute;
      if (d !== null) {
        await sql`
          insert into return_disputes (id, return_id, status, statement, review_due_at, decided_at, created_at)
          values (${d.id}::uuid, ${record.id}::uuid, ${d.status}, ${d.statement}, ${iso(d.reviewDueAtMs)}::timestamptz,
                  ${isoOrNull(d.decidedAtMs)}::timestamptz, ${iso(d.createdAtMs)}::timestamptz)
          on conflict (return_id) do update set status = excluded.status, decided_at = excluded.decided_at`.execute(trx);
      }
      return true;
    });
  }

  private async page(where: Fragment, cursor: string | null, limit: number): Promise<Page<ReturnRecord>> {
    const c = cursor === null ? null : decodeCursor(cursor);
    const after =
      c === null ? sql`true` : sql`(r.created_at, r.id) < (${iso(c.createdAtMs)}::timestamptz, ${c.id}::uuid)`;
    return this.tx(async (trx) => {
      const rows = await sql<unknown>`
        select ${RETURN_COLUMNS} from returns r where ${where} and ${after}
         order by r.created_at desc, r.id desc limit ${limit + 1}`.execute(trx);
      const all = await this.hydrate(trx, rows.rows);
      const items = all.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          all.length > limit && last !== undefined ? encodeCursor({ createdAtMs: last.createdAtMs, id: last.id }) : null,
      };
    });
  }

  async listForUser(userId: string, cursor: string | null, limit: number): Promise<Page<ReturnRecord>> {
    if (!UUID.test(userId)) return { items: [], nextCursor: null };
    return this.page(sql`r.user_id = ${userId}::uuid`, cursor, limit);
  }

  async listForStores(storeIds: readonly string[], cursor: string | null, limit: number): Promise<Page<ReturnRecord>> {
    const ids = storeIds.filter((s) => UUID.test(s));
    if (ids.length === 0) return { items: [], nextCursor: null };
    return this.page(sql`r.store_id::text = any (${ids}::text[])`, cursor, limit);
  }

  private async many(where: Fragment, limit: number): Promise<ReturnRecord[]> {
    return this.tx(async (trx) => {
      const rows = await sql<unknown>`
        select ${RETURN_COLUMNS} from returns r where ${where} order by r.created_at, r.id limit ${limit}`.execute(trx);
      return this.hydrate(trx, rows.rows);
    });
  }

  async listInspectionOverdue(nowMs: number, limit: number): Promise<readonly ReturnRecord[]> {
    return this.many(sql`r.state = 'RECEIVED' and r.inspection_due_at <= ${iso(nowMs)}::timestamptz`, limit);
  }

  async listDisputeWindowElapsed(nowMs: number, limit: number): Promise<readonly ReturnRecord[]> {
    return this.many(sql`r.state = 'REJECTED' and r.dispute_window_ends_at < ${iso(nowMs)}::timestamptz`, limit);
  }

  async listUnpublishedIntents(limit: number): Promise<readonly ReturnRecord[]> {
    return this.many(sql`r.state = 'APPROVED' and r.intent_published_at is null`, limit);
  }

  async hasOpenReturns(userId: string): Promise<boolean> {
    if (!UUID.test(userId)) return false;
    const states = [...OPEN_STATES];
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from returns
         where user_id = ${userId}::uuid and state = any (${states}::text[])`.execute(trx);
      return Number(r.rows[0]?.n ?? "0") > 0;
    });
  }

  async getStanding(userId: string): Promise<StandingRecord | null> {
    if (!UUID.test(userId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select user_id::text as user_id, delivered_orders_6m, returned_orders_6m, rate_bps, free_returns_removed,
               floor(extract(epoch from notice_sent_at) * 1000)::text as notice_ms,
               floor(extract(epoch from evaluated_at) * 1000)::text as evaluated_ms
          from returner_standing where user_id = ${userId}::uuid`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      const s = StandingRow.parse(row);
      return {
        userId: s.user_id,
        deliveredOrders: s.delivered_orders_6m,
        returnedOrders: s.returned_orders_6m,
        rateBps: s.rate_bps,
        freeReturnsRemoved: s.free_returns_removed,
        noticeSentAtMs: s.notice_ms,
        evaluatedAtMs: s.evaluated_ms,
      };
    });
  }

  async saveStanding(s: StandingRecord): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into returner_standing (user_id, delivered_orders_6m, returned_orders_6m, rate_bps, free_returns_removed,
                                       notice_sent_at, evaluated_at)
        values (${s.userId}::uuid, ${s.deliveredOrders}, ${s.returnedOrders}, ${s.rateBps}, ${s.freeReturnsRemoved},
                ${isoOrNull(s.noticeSentAtMs)}::timestamptz, ${iso(s.evaluatedAtMs)}::timestamptz)
        on conflict (user_id) do update set
          delivered_orders_6m = excluded.delivered_orders_6m, returned_orders_6m = excluded.returned_orders_6m,
          rate_bps = excluded.rate_bps, free_returns_removed = excluded.free_returns_removed,
          notice_sent_at = excluded.notice_sent_at, evaluated_at = excluded.evaluated_at`.execute(trx);
    });
  }
}
