import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { Clock } from "../../../platform/ports";
import { ClientActionSchema } from "../domain/schemas";
import type { JsonValue } from "../domain/card-data-guard";
import {
  type InboxRef,
  type IntentMutation,
  type MutateResult,
  type PaymentIntentRecord,
  type PaymentStore,
  type RawEventRecord,
  type RefundInsert,
  type RefundRecord,
  type SavedCardRecord,
  type SettleRefundResult,
} from "../domain/ports";
import {
  PAYMENT_INTENT_STATES,
  PAYMENT_METHOD_IDS,
  decideRefundApplication,
  type PaymentDomainEvent,
} from "../domain/seam";
import { draftsFor, type OutboxDraft } from "./event-outbox";

/** Raw SQL only, rows validated with Zod (same approach as the orders adapter). */
export type PaymentsDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const MAX_DATE_MS = 253_402_300_799_999;
const iso = (ms: number): string => new Date(Math.min(Math.max(ms, 0), MAX_DATE_MS)).toISOString();
const ms = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;

const IntentRow = z.object({
  id: z.string(),
  order_group_id: z.string(),
  user_id: z.string(),
  provider: z.string(),
  provider_ref: z.string().nullable(),
  method: z.enum(PAYMENT_METHOD_IDS),
  amount: Amount,
  currency: z.string(),
  status: z.enum(PAYMENT_INTENT_STATES),
  refunded_amount: Amount,
  client_action: z.unknown(),
  idempotency_key: z.string(),
  failure_code: z.string().nullable(),
  expires_ms: Ms,
  version: z.number().int(),
  created_ms: Ms,
  updated_ms: Ms,
});
const INTENT_COLS = sql.raw(`
  id::text as id, order_group_id::text as order_group_id, user_id::text as user_id, provider, provider_ref, method,
  amount::text as amount, currency, status, refunded_amount::text as refunded_amount, client_action,
  idempotency_key, failure_code, ${ms("expires_at")} as expires_ms, version,
  ${ms("created_at")} as created_ms, ${ms("updated_at")} as updated_ms`);

const RawRow = z.object({
  id: z.string(),
  provider: z.string(),
  event_id: z.string(),
  signature_ok: z.boolean(),
  reject_reason: z.string().nullable(),
  body: z.unknown(),
  body_sha256: z.string(),
  received_ms: Ms,
  processed_ms: Ms.nullable(),
  process_outcome: z.string().nullable(),
});
const RAW_COLS = sql.raw(`
  id::text as id, provider, event_id, signature_ok, reject_reason, body, body_sha256,
  ${ms("received_at")} as received_ms, ${ms("processed_at")} as processed_ms, process_outcome`);

const RefundRow = z.object({
  id: z.string(),
  intent_id: z.string(),
  idempotency_key: z.string(),
  amount: Amount,
  status: z.enum(["pending", "succeeded", "failed"]),
  provider_refund_ref: z.string().nullable(),
  failure_code: z.string().nullable(),
  reason: z.string(),
  created_ms: Ms,
});
const REFUND_COLS = sql.raw(`
  id::text as id, intent_id::text as intent_id, idempotency_key, amount::text as amount, status,
  provider_refund_ref, failure_code, reason, ${ms("created_at")} as created_ms`);

const CardRow = z.object({
  id: z.string(),
  user_id: z.string(),
  provider: z.string(),
  psp_token: z.string(),
  brand: z.string(),
  last4: z.string(),
  exp_month: z.number().int(),
  exp_year: z.number().int(),
  fingerprint: z.string(),
  created_ms: Ms,
});
const CARD_COLS = sql.raw(`
  id::text as id, user_id::text as user_id, provider, psp_token, brand, last4::text as last4,
  exp_month::int as exp_month, exp_year::int as exp_year, fingerprint, ${ms("created_at")} as created_ms`);

const toIntent = (raw: unknown): PaymentIntentRecord => {
  const r = IntentRow.parse(raw);
  const ca = r.client_action === null || r.client_action === undefined ? null : ClientActionSchema.parse(r.client_action);
  return {
    id: r.id,
    orderGroupId: r.order_group_id,
    userId: r.user_id,
    provider: r.provider,
    providerRef: r.provider_ref,
    method: r.method,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    refundedAmount: r.refunded_amount,
    clientAction: ca,
    idempotencyKey: r.idempotency_key,
    failureCode: r.failure_code,
    expiresAtMs: r.expires_ms,
    version: r.version,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
};
const toRaw = (raw: unknown): RawEventRecord => {
  const r = RawRow.parse(raw);
  return {
    id: r.id,
    provider: r.provider,
    eventId: r.event_id,
    signatureOk: r.signature_ok,
    rejectReason: r.reject_reason,
    body: r.body as JsonValue,
    bodySha256: r.body_sha256,
    receivedAtMs: r.received_ms,
    processedAtMs: r.processed_ms,
    processOutcome: r.process_outcome,
  };
};
const toRefund = (raw: unknown): RefundRecord => {
  const r = RefundRow.parse(raw);
  return {
    id: r.id,
    intentId: r.intent_id,
    idempotencyKey: r.idempotency_key,
    amount: r.amount,
    status: r.status,
    providerRefundRef: r.provider_refund_ref,
    failureCode: r.failure_code,
    reason: r.reason,
    createdAtMs: r.created_ms,
  };
};
const toCard = (raw: unknown): SavedCardRecord => {
  const r = CardRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    provider: r.provider,
    pspToken: r.psp_token,
    brand: r.brand,
    last4: r.last4,
    expMonth: r.exp_month,
    expYear: r.exp_year,
    fingerprint: r.fingerprint,
    createdAtMs: r.created_ms,
  };
};

type Scope = { readonly kind: "system" } | { readonly kind: "customer"; readonly userId: string };

/**
 * Postgres adapter. Each method is ONE transaction that drops to `app_user` and sets the RLS
 * identity; the state change, the inbox row, the raw-event mark and the outbox rows commit or roll
 * back together (A2.7). Customer-scoped reads run as `customer` so RLS, not only the WHERE
 * clause, enforces ownership.
 */
export class KyselyPaymentStore implements PaymentStore {
  constructor(
    private readonly db: PaymentsDb,
    private readonly clock: Clock,
    private readonly newId: () => string,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async tx<T>(scope: Scope, run: (trx: PaymentsDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as PaymentsDb;
      if (this.applicationRole !== null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(this.applicationRole)) throw new RangeError("invalid role name");
        await sql`SET LOCAL ROLE ${sql.id(this.applicationRole)}`.execute(t);
      }
      const role = scope.kind === "system" ? "system" : "customer";
      const userId = scope.kind === "system" ? "" : scope.userId;
      await sql`select set_config('app.role', ${role}, true), set_config('app.user_id', ${userId}, true),
                       set_config('app.store_ids', '', true)`.execute(t);
      return run(t);
    });
  }

  private static async elevate(trx: PaymentsDb): Promise<void> {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
  }

  private async writeOutbox(trx: PaymentsDb, drafts: readonly OutboxDraft[]): Promise<void> {
    for (const e of drafts) {
      await sql`
        insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, ${e.aggregateType}, ${e.aggregateId}::uuid,
                ${e.type}, ${`${e.aggregateType}:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
    }
  }

  private async emit(trx: PaymentsDb, events: readonly PaymentDomainEvent[], fallbackAggregateId: string): Promise<void> {
    await this.writeOutbox(trx, draftsFor(events, this.newId, this.clock.nowMs(), fallbackAggregateId));
  }

  /** Returns false when the message was already consumed (the insert conflicted). */
  private static async claimInbox(trx: PaymentsDb, inbox: InboxRef): Promise<boolean> {
    const r = await sql<{ consumer: string }>`
      insert into inbox_processed (consumer, message_id) values (${inbox.consumer}, ${inbox.messageId}::uuid)
      on conflict do nothing returning consumer`.execute(trx);
    return r.rows.length === 1;
  }

  private static async markRaw(trx: PaymentsDb, rawEventId: string, outcome: string, nowMs: number): Promise<void> {
    await sql`update payment_events_raw set processed_at = ${iso(nowMs)}::timestamptz, process_outcome = ${outcome}
              where id = ${rawEventId}::uuid and processed_at is null`.execute(trx);
  }

  // ---- intents ------------------------------------------------------------------------------
  async insertIntent(intent: PaymentIntentRecord, events: readonly PaymentDomainEvent[]) {
    return this.tx({ kind: "system" }, async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into payment_intents (id, order_group_id, user_id, provider, provider_ref, method, amount, currency,
                                     status, refunded_amount, client_action, idempotency_key, failure_code,
                                     expires_at, version, created_at, updated_at)
        values (${intent.id}::uuid, ${intent.orderGroupId}::uuid, ${intent.userId}::uuid, ${intent.provider},
                ${intent.providerRef}, ${intent.method}, ${intent.amount.toString()}::bigint, ${intent.currency},
                ${intent.status}, ${intent.refundedAmount.toString()}::bigint,
                ${intent.clientAction === null ? null : JSON.stringify(intent.clientAction)}::jsonb,
                ${intent.idempotencyKey}, ${intent.failureCode}, ${iso(intent.expiresAtMs)}::timestamptz,
                ${intent.version}, ${iso(intent.createdAtMs)}::timestamptz, ${iso(intent.updatedAtMs)}::timestamptz)
        on conflict (order_group_id) do nothing returning id::text as id`.execute(trx);
      if (ins.rows.length === 1) {
        await this.emit(trx, events, intent.id);
        return { kind: "inserted" as const, intent };
      }
      const cur = await sql<unknown>`select ${INTENT_COLS} from payment_intents
                                     where order_group_id = ${intent.orderGroupId}::uuid`.execute(trx);
      const row = cur.rows[0];
      if (row === undefined) throw new Error("payment intent vanished after conflict");
      return { kind: "exists" as const, intent: toIntent(row) };
    });
  }

  async getIntent(id: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`select ${INTENT_COLS} from payment_intents where id::text = ${id}`.execute(trx);
      return r.rows[0] === undefined ? null : toIntent(r.rows[0]);
    });
  }

  async getIntentByOrderGroup(orderGroupId: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`select ${INTENT_COLS} from payment_intents
                                   where order_group_id::text = ${orderGroupId}`.execute(trx);
      return r.rows[0] === undefined ? null : toIntent(r.rows[0]);
    });
  }

  async getIntentByProviderRef(provider: string, providerRef: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`select ${INTENT_COLS} from payment_intents
                                   where provider = ${provider} and provider_ref = ${providerRef}`.execute(trx);
      return r.rows[0] === undefined ? null : toIntent(r.rows[0]);
    });
  }

  async mutateIntent(input: {
    readonly intentId: string;
    readonly decide: (current: PaymentIntentRecord) => IntentMutation | null;
    readonly inbox?: InboxRef;
    readonly rawEventId?: string;
  }): Promise<MutateResult> {
    return this.tx({ kind: "system" }, async (trx) => {
      const locked = await sql<unknown>`select ${INTENT_COLS} from payment_intents
                                        where id::text = ${input.intentId} for update`.execute(trx);
      const row = locked.rows[0];
      if (row === undefined) return { kind: "not_found" as const };
      if (input.rawEventId !== undefined) {
        const raw = await sql<{ processed: boolean }>`
          select (processed_at is not null) as processed from payment_events_raw
          where id::text = ${input.rawEventId} for update`.execute(trx);
        if (raw.rows[0]?.processed === true) return { kind: "duplicate" as const };
      }
      if (input.inbox !== undefined && !(await KyselyPaymentStore.claimInbox(trx, input.inbox))) {
        return { kind: "duplicate" as const };
      }
      const cur = toIntent(row);
      const m = input.decide(cur);
      let next = cur;
      if (m !== null) {
        const p = m.patch;
        const sets = [
          sql`version = version + 1`,
          ...(p.provider !== undefined ? [sql`provider = ${p.provider}`] : []),
          ...(p.providerRef !== undefined ? [sql`provider_ref = ${p.providerRef}`] : []),
          ...(p.status !== undefined ? [sql`status = ${p.status}`] : []),
          ...(p.refundedAmount !== undefined ? [sql`refunded_amount = ${p.refundedAmount.toString()}::bigint`] : []),
          ...(p.clientAction !== undefined
            ? [sql`client_action = ${p.clientAction === null ? null : JSON.stringify(p.clientAction)}::jsonb`]
            : []),
          ...(p.failureCode !== undefined ? [sql`failure_code = ${p.failureCode}`] : []),
          ...(p.expiresAtMs !== undefined ? [sql`expires_at = ${iso(p.expiresAtMs)}::timestamptz`] : []),
        ];
        const upd = await sql<unknown>`
          update payment_intents set ${sql.join(sets, sql`, `)} where id::text = ${cur.id}
          returning ${INTENT_COLS}`.execute(trx);
        const u = upd.rows[0];
        if (u === undefined) throw new Error("payment intent update returned no row");
        next = toIntent(u);
        await this.emit(trx, m.events, cur.id);
      }
      if (input.rawEventId !== undefined) {
        await KyselyPaymentStore.markRaw(trx, input.rawEventId, m?.outcome ?? "noop", this.clock.nowMs());
      }
      return { kind: "applied" as const, intent: next, outcome: m?.outcome ?? "noop" };
    });
  }

  async listExpirable(nowMs: number, limit: number) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`
        select ${INTENT_COLS} from payment_intents
        where status in ('CREATED','REQUIRES_ACTION') and expires_at <= ${iso(nowMs)}::timestamptz
        order by expires_at, id limit ${limit}`.execute(trx);
      return r.rows.map(toIntent);
    });
  }

  // ---- raw events ---------------------------------------------------------------------------
  async recordRawEvent(rec: RawEventRecord, events: readonly PaymentDomainEvent[] = []) {
    return this.tx({ kind: "system" }, async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into payment_events_raw (id, provider, event_id, signature_ok, reject_reason, body, body_sha256, received_at)
        values (${rec.id}::uuid, ${rec.provider}, ${rec.eventId}, ${rec.signatureOk}, ${rec.rejectReason},
                ${JSON.stringify(rec.body)}::jsonb, ${rec.bodySha256}, ${iso(rec.receivedAtMs)}::timestamptz)
        on conflict (provider, event_id) do nothing returning id::text as id`.execute(trx);
      if (ins.rows.length === 0) return "duplicate" as const;
      await this.emit(trx, events, rec.id);
      if (rec.signatureOk) {
        await this.writeOutbox(trx, [
          {
            id: this.newId(),
            type: "payment.webhook_received",
            aggregateType: "payment_event",
            aggregateId: rec.id,
            occurredAtMs: this.clock.nowMs(),
            payload: { raw_event_id: rec.id, provider: rec.provider },
          },
        ]);
      }
      return "stored" as const;
    });
  }

  async getRawEvent(id: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`select ${RAW_COLS} from payment_events_raw where id::text = ${id}`.execute(trx);
      return r.rows[0] === undefined ? null : toRaw(r.rows[0]);
    });
  }

  async listUnprocessedEventIds(limit: number) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ id: string }>`
        select id::text as id from payment_events_raw
        where signature_ok and processed_at is null order by received_at, id limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.id);
    });
  }

  async settleRawEvent(input: {
    readonly rawEventId: string;
    readonly outcome: string;
    readonly events: readonly PaymentDomainEvent[];
    readonly inbox?: InboxRef;
  }) {
    return this.tx({ kind: "system" }, async (trx) => {
      const raw = await sql<{ processed: boolean }>`
        select (processed_at is not null) as processed from payment_events_raw
        where id::text = ${input.rawEventId} for update`.execute(trx);
      const row = raw.rows[0];
      if (row === undefined) return "not_found" as const;
      if (row.processed) return "duplicate" as const;
      if (input.inbox !== undefined && !(await KyselyPaymentStore.claimInbox(trx, input.inbox))) return "duplicate" as const;
      await this.emit(trx, input.events, input.rawEventId);
      await KyselyPaymentStore.markRaw(trx, input.rawEventId, input.outcome, this.clock.nowMs());
      return "settled" as const;
    });
  }

  // ---- refunds ------------------------------------------------------------------------------
  async insertRefund(rec: RefundRecord): Promise<RefundInsert> {
    return this.tx({ kind: "system" }, async (trx) => {
      const existing = await sql<unknown>`select ${REFUND_COLS} from payment_refunds
                                          where intent_id::text = ${rec.intentId} and idempotency_key = ${rec.idempotencyKey}`.execute(trx);
      if (existing.rows[0] !== undefined) return { kind: "exists" as const, refund: toRefund(existing.rows[0]) };
      // Lock the intent: concurrent refunds against one intent serialize here.
      const i = await sql<{ status: string; amount: string }>`
        select status, amount::text as amount from payment_intents where id::text = ${rec.intentId} for update`.execute(trx);
      const intent = i.rows[0];
      if (intent === undefined || (intent.status !== "SUCCEEDED" && intent.status !== "PARTIALLY_REFUNDED")) {
        return { kind: "not_refundable" as const };
      }
      const sum = await sql<{ committed: string }>`
        select coalesce(sum(amount), 0)::text as committed from payment_refunds
        where intent_id::text = ${rec.intentId} and status <> 'failed'`.execute(trx);
      const committed = BigInt(sum.rows[0]?.committed ?? "0");
      if (committed + rec.amount > BigInt(intent.amount)) return { kind: "exceeds_captured" as const };
      await sql`
        insert into payment_refunds (id, intent_id, idempotency_key, amount, status, provider_refund_ref, failure_code,
                                     reason, created_at)
        values (${rec.id}::uuid, ${rec.intentId}::uuid, ${rec.idempotencyKey}, ${rec.amount.toString()}::bigint,
                ${rec.status}, ${rec.providerRefundRef}, ${rec.failureCode}, ${rec.reason},
                ${iso(rec.createdAtMs)}::timestamptz)`.execute(trx);
      return { kind: "inserted" as const, refund: rec };
    });
  }

  async getRefundByKey(intentId: string, idempotencyKey: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`select ${REFUND_COLS} from payment_refunds
                                   where intent_id::text = ${intentId} and idempotency_key = ${idempotencyKey}`.execute(trx);
      return r.rows[0] === undefined ? null : toRefund(r.rows[0]);
    });
  }

  async getRefundByProviderRef(providerRefundRef: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`select ${REFUND_COLS} from payment_refunds
                                   where provider_refund_ref = ${providerRefundRef}`.execute(trx);
      return r.rows[0] === undefined ? null : toRefund(r.rows[0]);
    });
  }

  async findPendingRefunds(intentId: string, amount: bigint) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`
        select ${REFUND_COLS} from payment_refunds
        where intent_id::text = ${intentId} and status = 'pending' and provider_refund_ref is null
          and amount = ${amount.toString()}::bigint
        order by created_at, id limit 50`.execute(trx);
      return r.rows.map((row) => toRefund(row));
    });
  }

  async listPendingRefundsWithoutRef(limit: number) {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`
        select ${REFUND_COLS} from payment_refunds
        where status = 'pending' and provider_refund_ref is null
        order by created_at, id limit ${limit}`.execute(trx);
      return r.rows.map((row) => toRefund(row));
    });
  }

  async settleRefund(input: {
    readonly refundId: string;
    readonly outcome: "succeeded" | "failed";
    readonly providerRefundRef: string | null;
    readonly failureCode: string | null;
    readonly inbox?: InboxRef;
    readonly rawEventId?: string;
  }): Promise<SettleRefundResult> {
    return this.tx({ kind: "system" }, async (trx) => {
      const rr = await sql<unknown>`select ${REFUND_COLS} from payment_refunds
                                    where id::text = ${input.refundId} for update`.execute(trx);
      if (rr.rows[0] === undefined) return { kind: "not_found" as const };
      const refund = toRefund(rr.rows[0]);
      const ir = await sql<unknown>`select ${INTENT_COLS} from payment_intents
                                    where id::text = ${refund.intentId} for update`.execute(trx);
      if (ir.rows[0] === undefined) return { kind: "not_found" as const };
      const intent = toIntent(ir.rows[0]);
      if (input.inbox !== undefined && !(await KyselyPaymentStore.claimInbox(trx, input.inbox))) {
        return { kind: "duplicate" as const };
      }
      const nowMs = this.clock.nowMs();
      const mark = async (outcome: string): Promise<void> => {
        if (input.rawEventId !== undefined) await KyselyPaymentStore.markRaw(trx, input.rawEventId, outcome, nowMs);
      };
      if (refund.status !== "pending") {
        await mark("refund_already_settled");
        return { kind: "already_settled" as const, refund };
      }
      const ref = input.providerRefundRef ?? refund.providerRefundRef;
      const failure = input.outcome === "failed" ? input.failureCode : null;
      const upd = await sql<unknown>`
        update payment_refunds set status = ${input.outcome}, provider_refund_ref = ${ref}, failure_code = ${failure}
        where id::text = ${refund.id} returning ${REFUND_COLS}`.execute(trx);
      const settled = toRefund(upd.rows[0]);
      if (input.outcome === "failed") {
        await this.emit(
          trx,
          [
            {
              type: "payment.refund_failed",
              intentId: intent.id,
              orderGroupId: intent.orderGroupId,
              refundId: refund.id,
              reason: input.failureCode ?? "unknown",
            },
          ],
          intent.id,
        );
        await mark("refund_failed");
        return { kind: "applied" as const, refund: settled, intent };
      }
      const d = decideRefundApplication(intent, refund.amount);
      if (d.kind === "reject") {
        await this.emit(
          trx,
          [{ type: "payment.anomaly", intentId: intent.id, orderGroupId: intent.orderGroupId, anomaly: d.anomaly, detail: "refund" }],
          intent.id,
        );
        await mark("refund_anomaly");
        return { kind: "applied" as const, refund: settled, intent };
      }
      const iu = await sql<unknown>`
        update payment_intents set status = ${d.to}, refunded_amount = ${d.totalRefunded.toString()}::bigint,
                                   version = version + 1
        where id::text = ${intent.id} returning ${INTENT_COLS}`.execute(trx);
      const next = toIntent(iu.rows[0]);
      await this.emit(
        trx,
        [
          {
            type: "payment.refunded",
            intentId: intent.id,
            orderGroupId: intent.orderGroupId,
            refundId: refund.id,
            refundAmount: refund.amount,
            totalRefunded: d.totalRefunded,
            currency: intent.currency,
            full: d.full,
          },
        ],
        intent.id,
      );
      await mark("refund_succeeded");
      return { kind: "applied" as const, refund: settled, intent: next };
    });
  }

  // ---- saved cards --------------------------------------------------------------------------
  async upsertSavedCard(rec: SavedCardRecord, rawEventId?: string) {
    return this.tx({ kind: "system" }, async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into payment_methods (id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint, created_at)
        values (${rec.id}::uuid, ${rec.userId}::uuid, ${rec.provider}, ${rec.pspToken}, ${rec.brand}, ${rec.last4},
                ${rec.expMonth}, ${rec.expYear}, ${rec.fingerprint}, ${iso(rec.createdAtMs)}::timestamptz)
        on conflict (provider, psp_token) do nothing returning id::text as id`.execute(trx);
      let out: { kind: "inserted" | "exists"; card: SavedCardRecord };
      if (ins.rows.length === 1) {
        await this.writeOutbox(trx, [
          {
            id: this.newId(),
            type: "payment_method.saved",
            aggregateType: "payment_method",
            aggregateId: rec.id,
            occurredAtMs: this.clock.nowMs(),
            payload: { card_id: rec.id, brand: rec.brand },
          },
        ]);
        out = { kind: "inserted", card: rec };
      } else {
        const ex = await sql<unknown>`select ${CARD_COLS} from payment_methods
                                      where provider = ${rec.provider} and psp_token = ${rec.pspToken}`.execute(trx);
        if (ex.rows[0] === undefined) throw new Error("saved card vanished after conflict");
        out = { kind: "exists", card: toCard(ex.rows[0]) };
      }
      if (rawEventId !== undefined) await KyselyPaymentStore.markRaw(trx, rawEventId, "card_saved", this.clock.nowMs());
      return out;
    });
  }

  async listSavedCards(userId: string) {
    return this.tx({ kind: "customer", userId }, async (trx) => {
      const r = await sql<unknown>`select ${CARD_COLS} from payment_methods
                                   where user_id::text = ${userId} and deleted_at is null order by created_at, id`.execute(trx);
      return r.rows.map(toCard);
    });
  }

  async getSavedCard(id: string, userId: string) {
    return this.tx({ kind: "customer", userId }, async (trx) => {
      const r = await sql<unknown>`select ${CARD_COLS} from payment_methods
                                   where id::text = ${id} and user_id::text = ${userId} and deleted_at is null`.execute(trx);
      return r.rows[0] === undefined ? null : toCard(r.rows[0]);
    });
  }

  async deleteSavedCard(id: string, userId: string, nowMs: number) {
    return this.tx({ kind: "customer", userId }, async (trx) => {
      const own = await sql<{ id: string }>`select id::text as id from payment_methods
                                            where id::text = ${id} and user_id::text = ${userId} and deleted_at is null`.execute(trx);
      if (own.rows.length === 0) return false;
      await KyselyPaymentStore.elevate(trx);
      await sql`update payment_methods set deleted_at = ${iso(nowMs)}::timestamptz where id::text = ${id}`.execute(trx);
      return true;
    });
  }
}
