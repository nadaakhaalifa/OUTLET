import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { PAYMENT_METHODS, REFUND_CHANNELS, REFUND_STATES, aggregateStatus, parseSubKey, subBalanceKey, type RefundState } from "../domain/bridge";
import type {
  AllocationLine,
  CommittedRefunds,
  IdPort,
  IntakeOutcome,
  LegTransition,
  RefundEvent,
  RefundLegRecord,
  RefundRecord,
  RefundStore,
  StoredEntry,
} from "../domain/ports";
import { aggregateOf, eventPayload } from "./events";

/** Raw SQL only, rows validated with Zod (same approach as the referrals adapter). */
export type RefundsDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();

const StoredEntrySchema = z.object({
  // Rows written before ids were persisted have neither: the codec falls back safely.
  id: z.string().default(""),
  requires: z.array(z.string()).default([]),
  kind: z.string(),
  idempotencyKey: z.string(),
  occurredAtMs: z.number(),
  ref: z.object({ type: z.string(), id: z.string() }),
  postings: z.array(z.object({ account: z.string(), amount: z.string().regex(/^-?\d+$/) })),
});
const LineSchema = z.object({
  orderLineId: z.string(),
  qty: z.number().int(),
  itemAmount: z.string(),
  lineGross: z.string().optional(),
  voucherShare: z.string(),
  deliveryFeeShare: z.string(),
  netAmount: z.string(),
});
const TenderRefSchema = z.object({
  psp: z.string().optional(),
  provider: z.string().optional(),
  courier: z.string().optional(),
});

const RefundRow = z.object({
  id: z.string(),
  user_id: z.string(),
  store_id: z.string(),
  seller_order_id: z.string(),
  return_id: z.string().nullable(),
  source: z.enum(["return", "cancellation", "admin"]),
  idempotency_key: z.string(),
  status: z.enum(["REQUESTED", "APPROVED", "PROCESSING", "COMPLETED", "FAILED", "MANUAL_REVIEW", "CANCELLED"]),
  amount: Big,
  item_total: Big,
  voucher_total: Big,
  delivery_fee_total: Big,
  allocation_lines: z.array(LineSchema),
  ledger_entry: StoredEntrySchema,
  ledger_posted_ms: Ms.nullable(),
  return_received_ms: Ms.nullable(),
  requested_ms: Ms,
  initiated_ms: Ms.nullable(),
  completed_ms: Ms.nullable(),
  version: z.number().int(),
});

const LegRow = z.object({
  id: z.string(),
  refund_id: z.string(),
  position: z.number().int(),
  tender_id: z.string(),
  method: z.enum(PAYMENT_METHODS),
  channel: z.enum(REFUND_CHANNELS),
  amount: Big,
  credit_sub: z.string().nullable(),
  tender_ref: TenderRefSchema,
  state: z.enum(REFUND_STATES),
  attempts: z.number().int(),
  next_ms: Ms.nullable(),
  provider_ref: z.string().nullable(),
  failure_code: z.string().nullable(),
  needs_payout_details: z.boolean(),
  verify_row: z.string().nullable(),
  note: z.string().nullable(),
});

const REFUND_COLS = sql`id::text as id, user_id::text as user_id, store_id::text as store_id,
  seller_order_id::text as seller_order_id, return_id::text as return_id, source, idempotency_key, status,
  amount::text as amount, item_total::text as item_total, voucher_total::text as voucher_total,
  delivery_fee_total::text as delivery_fee_total, allocation_lines, ledger_entry,
  floor(extract(epoch from ledger_posted_at) * 1000)::text as ledger_posted_ms,
  floor(extract(epoch from return_received_at) * 1000)::text as return_received_ms,
  floor(extract(epoch from requested_at) * 1000)::text as requested_ms,
  floor(extract(epoch from initiated_at) * 1000)::text as initiated_ms,
  floor(extract(epoch from completed_at) * 1000)::text as completed_ms, version`;

const LEG_COLS = sql`id::text as id, refund_id::text as refund_id, position, tender_id, method, channel,
  amount::text as amount, credit_sub, tender_ref, state, attempts,
  floor(extract(epoch from next_attempt_at) * 1000)::text as next_ms, provider_ref, failure_code,
  needs_payout_details, verify_row, note`;

const toLeg = (raw: unknown): RefundLegRecord => {
  const r = LegRow.parse(raw);
  const t = r.tender_ref;
  return {
    id: r.id,
    refundId: r.refund_id,
    position: r.position,
    tenderId: r.tender_id,
    method: r.method,
    channel: r.channel,
    amount: r.amount,
    creditSub: r.credit_sub === null ? null : parseSubKey(r.credit_sub),
    tender: {
      ...(t.psp === undefined ? {} : { psp: t.psp }),
      ...(t.provider === undefined ? {} : { provider: t.provider }),
      ...(t.courier === undefined ? {} : { courier: t.courier }),
    },
    state: r.state,
    attempts: r.attempts,
    nextAttemptAtMs: r.next_ms,
    providerRef: r.provider_ref,
    failureCode: r.failure_code,
    needsPayoutDetails: r.needs_payout_details,
    verify: r.verify_row,
    note: r.note,
  };
};

const toRefund = (raw: unknown, legs: readonly RefundLegRecord[]): RefundRecord => {
  const r = RefundRow.parse(raw);
  const e = r.ledger_entry;
  const entry: StoredEntry = {
    id: e.id,
    requires: e.requires,
    kind: e.kind,
    idempotencyKey: e.idempotencyKey,
    occurredAtMs: e.occurredAtMs,
    ref: e.ref,
    postings: e.postings.map((p) => ({ account: p.account, amount: BigInt(p.amount) })),
  };
  const lines: AllocationLine[] = r.allocation_lines.map((l) => ({
    orderLineId: l.orderLineId,
    qty: l.qty,
    itemAmount: BigInt(l.itemAmount),
    ...(l.lineGross === undefined ? {} : { lineGross: BigInt(l.lineGross) }),
    voucherShare: BigInt(l.voucherShare),
    deliveryFeeShare: BigInt(l.deliveryFeeShare),
    netAmount: BigInt(l.netAmount),
  }));
  return {
    id: r.id,
    userId: r.user_id,
    storeId: r.store_id,
    sellerOrderId: r.seller_order_id,
    returnId: r.return_id,
    source: r.source,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    amount: r.amount,
    itemTotal: r.item_total,
    voucherTotal: r.voucher_total,
    deliveryFeeTotal: r.delivery_fee_total,
    lines,
    entry,
    ledgerPostedAtMs: r.ledger_posted_ms,
    returnReceivedAtMs: r.return_received_ms,
    requestedAtMs: r.requested_ms,
    initiatedAtMs: r.initiated_ms,
    completedAtMs: r.completed_ms,
    legs,
    version: r.version,
  };
};

/**
 * Postgres adapter. One transaction per method under the `system` role (authorization lives in
 * the policy guard and the use cases; RLS stays on for every other role). Events are appended to
 * outbox_events and the inbox row is written in the SAME transaction as the state change.
 */
export class KyselyRefundStore implements RefundStore {
  constructor(
    private readonly db: RefundsDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: RefundsDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as RefundsDb);
    });
  }

  private async emit(trx: RefundsDb, events: readonly RefundEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'refund', ${UUID.test(agg) ? agg : this.ids.uuidV7()}::uuid, ${e.type},
                ${`refund:${agg}`}, ${JSON.stringify(eventPayload(e))}::jsonb)`.execute(trx);
    }
  }

  private async legsOf(trx: RefundsDb, refundId: string): Promise<RefundLegRecord[]> {
    const r = await sql<unknown>`
      select ${LEG_COLS} from refund_legs where refund_id = ${refundId}::uuid order by position`.execute(trx);
    return r.rows.map(toLeg);
  }

  async committedForSellerOrder(sellerOrderId: string): Promise<CommittedRefunds> {
    const empty: CommittedRefunds = { count: 0, byLine: new Map(), byTender: new Map(), idempotencyKeys: new Set(), fee: 0n };
    if (!UUID.test(sellerOrderId)) return empty;
    return this.tx(async (trx) => {
      const rows = await sql<{ id: string; idempotency_key: string; allocation_lines: unknown; fee: string }>`
        select id::text as id, idempotency_key, allocation_lines, delivery_fee_total::text as fee from refunds
        where seller_order_id = ${sellerOrderId}::uuid and status <> 'CANCELLED'`.execute(trx);
      const byLine = new Map<string, bigint>();
      const byTender = new Map<string, bigint>();
      const idempotencyKeys = new Set<string>();
      let fee = 0n;
      for (const r of rows.rows) {
        fee += BigInt(r.fee);
        idempotencyKeys.add(r.idempotency_key);
        for (const l of z.array(LineSchema).parse(r.allocation_lines)) {
          byLine.set(l.orderLineId, (byLine.get(l.orderLineId) ?? 0n) + BigInt(l.itemAmount));
        }
      }
      const legs = await sql<{ tender_id: string; amount: string }>`
        select l.tender_id, l.amount::text as amount from refund_legs l
        join refunds r on r.id = l.refund_id
        where r.seller_order_id = ${sellerOrderId}::uuid and r.status <> 'CANCELLED'`.execute(trx);
      for (const l of legs.rows) byTender.set(l.tender_id, (byTender.get(l.tender_id) ?? 0n) + BigInt(l.amount));
      return { count: rows.rows.length, byLine, byTender, idempotencyKeys, fee };
    });
  }

  async acknowledgeExisting(input: { consumer: string; messageId: string }): Promise<"exists" | "duplicate"> {
    return this.tx(async (trx) => {
      const seen = await sql<{ m: string }>`
        insert into inbox_processed (consumer, message_id) values (${input.consumer}, ${input.messageId}::uuid)
        on conflict do nothing returning message_id::text as m`.execute(trx);
      return seen.rows[0] === undefined ? "duplicate" : "exists";
    });
  }

  async intake(input: { consumer: string; messageId: string; refund: RefundRecord; expectedCommitted: number }): Promise<IntakeOutcome> {
    const rf = input.refund;
    return this.tx(async (trx) => {
      // Serialise intents per seller order: the capacity they were computed from must still hold.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`refund_intake:${rf.sellerOrderId}`}, 0))`.execute(trx);
      const dup = await sql<{ id: string }>`
        select id::text as id from refunds where idempotency_key = ${rf.idempotencyKey}`.execute(trx);
      if (dup.rows[0] === undefined) {
        const held = await sql<{ n: string }>`
          select count(*)::text as n from refunds
          where seller_order_id = ${rf.sellerOrderId}::uuid and status <> 'CANCELLED'`.execute(trx);
        if (Number(held.rows[0]?.n ?? "0") !== input.expectedCommitted) return "stale";
      }
      const seen = await sql<{ m: string }>`
        insert into inbox_processed (consumer, message_id) values (${input.consumer}, ${input.messageId}::uuid)
        on conflict do nothing returning message_id::text as m`.execute(trx);
      if (seen.rows[0] === undefined) return "duplicate";
      const entry = {
        ...rf.entry,
        postings: rf.entry.postings.map((p) => ({ account: p.account, amount: p.amount.toString() })),
      };
      const lines = rf.lines.map((l) => ({
        orderLineId: l.orderLineId,
        qty: l.qty,
        itemAmount: l.itemAmount.toString(),
        ...(l.lineGross === undefined ? {} : { lineGross: l.lineGross.toString() }),
        voucherShare: l.voucherShare.toString(),
        deliveryFeeShare: l.deliveryFeeShare.toString(),
        netAmount: l.netAmount.toString(),
      }));
      const ins = await sql<{ id: string }>`
        insert into refunds (id, user_id, store_id, seller_order_id, return_id, source, idempotency_key, status,
          amount, item_total, voucher_total, delivery_fee_total, allocation_lines, ledger_entry,
          return_received_at, requested_at)
        values (${rf.id}::uuid, ${rf.userId}::uuid, ${rf.storeId}::uuid, ${rf.sellerOrderId}::uuid,
          ${rf.returnId}::uuid, ${rf.source}, ${rf.idempotencyKey}, 'REQUESTED',
          ${rf.amount.toString()}::bigint, ${rf.itemTotal.toString()}::bigint, ${rf.voucherTotal.toString()}::bigint,
          ${rf.deliveryFeeTotal.toString()}::bigint, ${JSON.stringify(lines)}::jsonb, ${JSON.stringify(entry)}::jsonb,
          ${rf.returnReceivedAtMs === null ? null : iso(rf.returnReceivedAtMs)}::timestamptz,
          ${iso(rf.requestedAtMs)}::timestamptz)
        on conflict (idempotency_key) do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows[0] === undefined) return "exists";
      for (const l of rf.legs) {
        await sql`
          insert into refund_legs (id, refund_id, position, tender_id, method, channel, amount, credit_sub,
            tender_ref, state, attempts, needs_payout_details, verify_row, note)
          values (${l.id}::uuid, ${rf.id}::uuid, ${l.position}, ${l.tenderId}, ${l.method}, ${l.channel},
            ${l.amount.toString()}::bigint, ${l.creditSub === null ? null : subBalanceKey(l.creditSub)},
            ${JSON.stringify(l.tender)}::jsonb, 'REQUESTED', 0, ${l.needsPayoutDetails}, ${l.verify}, ${l.note})`.execute(trx);
      }
      await this.emit(trx, [
        { type: "refund.requested", refundId: rf.id, userId: rf.userId, amount: rf.amount, returnId: rf.returnId },
      ]);
      return "created";
    });
  }

  async reject(input: { consumer: string; messageId: string; returnId: string; reason: string }): Promise<"recorded" | "duplicate"> {
    return this.tx(async (trx) => {
      const seen = await sql<{ m: string }>`
        insert into inbox_processed (consumer, message_id) values (${input.consumer}, ${input.messageId}::uuid)
        on conflict do nothing returning message_id::text as m`.execute(trx);
      if (seen.rows[0] === undefined) return "duplicate";
      await this.emit(trx, [{ type: "refund.intent_rejected", returnId: input.returnId, reason: input.reason }]);
      return "recorded";
    });
  }

  async get(id: string): Promise<RefundRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${REFUND_COLS} from refunds where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toRefund(row, await this.legsOf(trx, id));
    });
  }

  async findByProviderRef(provider: string, providerRef: string): Promise<{ refundId: string; leg: RefundLegRecord } | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${LEG_COLS} from refund_legs
        where provider_ref = ${providerRef}
          and coalesce(tender_ref->>'psp', tender_ref->>'provider', tender_ref->>'courier') = ${provider}
        order by created_at limit 1`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      const leg = toLeg(row);
      return { refundId: leg.refundId, leg };
    });
  }

  async listForUser(
    userId: string,
    page: { after: { createdAtMs: number; id: string } | null; limit: number },
  ): Promise<readonly RefundRecord[]> {
    if (!UUID.test(userId)) return [];
    return this.tx(async (trx) => {
      const a = page.after;
      const r =
        a === null || !UUID.test(a.id)
          ? await sql<unknown>`
              select ${REFUND_COLS} from refunds where user_id = ${userId}::uuid
              order by requested_at desc, id desc limit ${page.limit}`.execute(trx)
          : await sql<unknown>`
              select ${REFUND_COLS} from refunds where user_id = ${userId}::uuid
                and (requested_at, id) < (${iso(a.createdAtMs)}::timestamptz, ${a.id}::uuid)
              order by requested_at desc, id desc limit ${page.limit}`.execute(trx);
      const out: RefundRecord[] = [];
      for (const row of r.rows) {
        const id = z.object({ id: z.string() }).parse(row).id;
        out.push(toRefund(row, await this.legsOf(trx, id)));
      }
      return out;
    });
  }

  async markLedgerPosted(refundId: string, nowMs: number): Promise<void> {
    if (!UUID.test(refundId)) return;
    await this.tx(async (trx) => {
      const upd = await sql<{ user_id: string }>`
        update refunds set ledger_posted_at = ${iso(nowMs)}::timestamptz, initiated_at = ${iso(nowMs)}::timestamptz,
          status = 'APPROVED', version = version + 1
        where id = ${refundId}::uuid and ledger_posted_at is null
        returning user_id::text as user_id`.execute(trx);
      const row = upd.rows[0];
      if (row === undefined) return;
      await sql`
        update refund_legs set state = 'LEDGER_POSTED' where refund_id = ${refundId}::uuid and state = 'REQUESTED'`.execute(trx);
      await this.emit(trx, [{ type: "refund.approved", refundId, userId: row.user_id }]);
    });
  }

  async transitionLeg(t: LegTransition): Promise<"applied" | "stale"> {
    if (!UUID.test(t.legId)) return "stale";
    return this.tx(async (trx) => {
      const owner = await sql<{ refund_id: string }>`
        select refund_id::text as refund_id from refund_legs where id = ${t.legId}::uuid`.execute(trx);
      const refundId = owner.rows[0]?.refund_id;
      if (refundId === undefined) return "stale";
      // Lock the refund first so concurrent legs aggregate one at a time.
      const head = await sql<{
        status: string;
        user_id: string;
        amount: string;
        return_id: string | null;
        seller_order_id: string;
        allocation_lines: unknown;
      }>`
        select status, user_id::text as user_id, amount::text as amount, return_id::text as return_id,
               seller_order_id::text as seller_order_id, allocation_lines
        from refunds where id = ${refundId}::uuid for update`.execute(trx);
      const before = head.rows[0];
      if (before === undefined) return "stale";
      const providerRef = t.providerRef === undefined ? sql`provider_ref` : sql`${t.providerRef}`;
      const upd = await sql<{ id: string }>`
        update refund_legs set state = ${t.to}, attempts = ${t.attempts},
          next_attempt_at = ${t.nextAttemptAtMs === null ? null : iso(t.nextAttemptAtMs)}::timestamptz,
          provider_ref = ${providerRef}, failure_code = ${t.failureCode}
        where id = ${t.legId}::uuid and state = ${t.from}
        returning id::text as id`.execute(trx);
      if (upd.rows[0] === undefined) return "stale";
      if (t.attempt !== undefined) {
        await sql`
          insert into refund_attempts (leg_id, attempt_no, outcome, code, at)
          values (${t.legId}::uuid, ${t.attempt.no}, ${t.attempt.outcome}, ${t.attempt.code}, ${iso(t.nowMs)}::timestamptz)
          on conflict (leg_id, attempt_no) do update set outcome = excluded.outcome, code = excluded.code, at = excluded.at`.execute(trx);
      }
      const states = await sql<{ state: string }>`
        select state from refund_legs where refund_id = ${refundId}::uuid`.execute(trx);
      const status = aggregateStatus(states.rows.map((s) => z.enum(REFUND_STATES).parse(s.state) as RefundState));
      await sql`
        update refunds set status = ${status}, version = version + 1,
          completed_at = case when ${status} = 'COMPLETED' then coalesce(completed_at, ${iso(t.nowMs)}::timestamptz) else null end
        where id = ${refundId}::uuid`.execute(trx);
      const events: RefundEvent[] = [];
      if (t.to === "FAILED") {
        events.push({ type: "refund.failed", refundId, legId: t.legId, code: t.failureCode ?? "unknown", attempts: t.attempts });
      }
      if (t.to === "MANUAL_REVIEW" && t.from !== "MANUAL_REVIEW") {
        events.push({ type: "refund.manual_review", refundId, legId: t.legId, code: t.failureCode ?? "unknown" });
      }
      if (status === "COMPLETED" && before.status !== "COMPLETED") {
        events.push({
          type: "refund.completed",
          refundId,
          userId: before.user_id,
          amount: BigInt(before.amount),
          returnId: before.return_id,
        });
        // Cumulative goods refunded per line over every COMPLETED refund of the seller order,
        // this one included (its status was written above, in this transaction).
        const done = await sql<{ allocation_lines: unknown }>`
          select allocation_lines from refunds
          where seller_order_id = ${before.seller_order_id}::uuid and status = 'COMPLETED'`.execute(trx);
        const cumulative = new Map<string, bigint>();
        for (const r of done.rows) {
          for (const l of z.array(LineSchema).parse(r.allocation_lines)) {
            cumulative.set(l.orderLineId, (cumulative.get(l.orderLineId) ?? 0n) + BigInt(l.itemAmount));
          }
        }
        for (const l of z.array(LineSchema).parse(before.allocation_lines)) {
          events.push({
            type: "order_line.refunded",
            refundId,
            sellerOrderId: before.seller_order_id,
            orderLineId: l.orderLineId,
            userId: before.user_id,
            lineGross: l.lineGross === undefined ? null : BigInt(l.lineGross),
            refundedGross: cumulative.get(l.orderLineId) ?? BigInt(l.itemAmount),
            delta: BigInt(l.itemAmount),
          });
        }
      }
      await this.emit(trx, events);
      return "applied";
    });
  }

  async listActionable(nowMs: number, limit: number): Promise<readonly string[]> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        select r.id::text as id from refunds r
        where r.status not in ('COMPLETED', 'CANCELLED')
          and (r.ledger_posted_at is null
            or exists (select 1 from refund_legs l where l.refund_id = r.id
                 and (l.state = 'LEDGER_POSTED'
                   or (l.state = 'FAILED' and (l.next_attempt_at is null or l.next_attempt_at <= ${iso(nowMs)}::timestamptz)))))
        order by r.requested_at, r.id limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.id);
    });
  }
}
