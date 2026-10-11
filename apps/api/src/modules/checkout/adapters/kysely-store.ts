import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { isTerminal } from "../domain/bridge";
import type {
  CreateSagaResult,
  OutboxDraft,
  PaymentEventRecord,
  SagaRecord,
  SagaRepository,
} from "../domain/ports";
import { ClientActionSchema, FactsSchema, StoredSchema, fromJson, toJson } from "./serde";

/** Raw SQL only, rows validated with Zod (same approach as the orders and inventory adapters). */
export type CheckoutDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const MAX_DATE_MS = 253_402_300_799_999;
const iso = (ms: number): string => new Date(Math.min(Math.max(ms, 0), MAX_DATE_MS)).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ms = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;

const Row = z.object({
  order_group_id: z.string(),
  user_id: z.string(),
  idempotency_key: z.string(),
  request_hash: z.string(),
  cart_hash: z.string(),
  provider: z.string().nullable(),
  facts: z.unknown(),
  quote: z.unknown(),
  client_action: z.unknown(),
  version: z.number().int(),
  attempts: z.number().int(),
  next_wake_ms: Ms.nullable(),
  last_error: z.string().nullable(),
  stuck: z.boolean(),
  created_ms: Ms,
  updated_ms: Ms,
});
const COLS = sql.raw(`
  order_group_id::text as order_group_id, user_id::text as user_id, idempotency_key, request_hash, cart_hash,
  provider, facts, quote, client_action, version, attempts, ${ms("next_wake_at")} as next_wake_ms, last_error,
  (stuck_at is not null) as stuck, ${ms("created_at")} as created_ms, ${ms("updated_at")} as updated_ms`);

type Scope = { readonly kind: "system" } | { readonly kind: "customer"; readonly userId: string };

function hydrate(raw: unknown): SagaRecord {
  const r = Row.parse(raw);
  const facts = FactsSchema.parse(fromJson(r.facts));
  const stored = StoredSchema.parse(fromJson(r.quote));
  return {
    orderGroupId: r.order_group_id,
    userId: r.user_id,
    idempotencyKey: r.idempotency_key,
    requestHash: r.request_hash,
    cartHash: r.cart_hash,
    facts,
    stored,
    provider: r.provider,
    clientAction: r.client_action === null ? null : ClientActionSchema.parse(fromJson(r.client_action)),
    version: r.version,
    attempts: r.attempts,
    nextWakeAtMs: r.next_wake_ms,
    lastError: r.last_error,
    stuck: r.stuck,
    createdAtMs: r.created_ms,
    updatedAtMs: r.updated_ms,
  };
}

const TERMINAL_SQL = sql.raw(`('PLACED','FAILED','EXPIRED','CANCELLED','REFUNDED')`);

/**
 * Postgres adapter. One transaction per call: drops to `app_user`, sets the RLS identity (the saga
 * runs as `system`; owner reads run as that customer), and writes state and outbox rows together (A2.7).
 */
export class KyselySagaRepository implements SagaRepository {
  constructor(
    private readonly db: CheckoutDb,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async tx<T>(scope: Scope, run: (trx: CheckoutDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as CheckoutDb;
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

  private static async emit(trx: CheckoutDb, events: readonly OutboxDraft[]): Promise<void> {
    for (const e of events) {
      await sql`
        insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, 'order_group', ${e.aggregateId}::uuid,
                ${e.type}, ${`order_group:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
    }
  }

  private static async findBy(trx: CheckoutDb, where: ReturnType<typeof sql>): Promise<SagaRecord | null> {
    const r = await sql<unknown>`select ${COLS} from checkout_sagas where ${where} limit 1`.execute(trx);
    const row = r.rows[0];
    return row === undefined ? null : hydrate(row);
  }

  async create(record: SagaRecord, events: readonly OutboxDraft[]): Promise<CreateSagaResult> {
    return this.tx({ kind: "system" }, async (trx) => {
      const byKey = await KyselySagaRepository.findBy(
        trx,
        sql`user_id = ${record.userId}::uuid and idempotency_key = ${record.idempotencyKey}`,
      );
      if (byKey !== null) return { kind: "duplicate_key", existing: byKey } as const;
      const byCart = await KyselySagaRepository.findBy(
        trx,
        sql`user_id = ${record.userId}::uuid and cart_hash = ${record.cartHash} and status not in ${TERMINAL_SQL}`,
      );
      if (byCart !== null) return { kind: "duplicate_cart", existing: byCart } as const;
      const f = record.facts;
      await sql`
        insert into checkout_sagas (order_group_id, user_id, idempotency_key, request_hash, cart_hash, status, method,
                                    provider, currency, total_amount, credit_amount, external_amount, facts, quote,
                                    client_action, version, attempts, next_wake_at, last_error, stuck_at, created_at)
        values (${record.orderGroupId}::uuid, ${record.userId}::uuid, ${record.idempotencyKey}, ${record.requestHash},
                ${record.cartHash}, ${f.status}, ${f.method}, ${record.provider}, 'EGP',
                ${record.stored.quote.total.amount.toString()}::bigint, ${f.creditAmount.toString()}::bigint,
                ${f.externalDue.toString()}::bigint, ${toJson(f)}::jsonb, ${toJson(record.stored)}::jsonb,
                ${record.clientAction === null ? null : toJson(record.clientAction)}::jsonb, ${record.version},
                ${record.attempts},
                ${record.nextWakeAtMs === null ? null : iso(record.nextWakeAtMs)}::timestamptz, ${record.lastError},
                ${record.stuck ? iso(record.updatedAtMs) : null}::timestamptz, ${iso(record.createdAtMs)}::timestamptz)`.execute(trx);
      await KyselySagaRepository.emit(trx, events);
      return { kind: "created" } as const;
    });
  }

  get(orderGroupId: string): Promise<SagaRecord | null> {
    if (!UUID.test(orderGroupId)) return Promise.resolve(null);
    return this.tx({ kind: "system" }, (trx) =>
      KyselySagaRepository.findBy(trx, sql`order_group_id = ${orderGroupId}::uuid`),
    );
  }

  getForUser(orderGroupId: string, userId: string): Promise<SagaRecord | null> {
    if (!UUID.test(orderGroupId)) return Promise.resolve(null);
    // RLS enforces ownership; the explicit predicate keeps the intent readable.
    return this.tx({ kind: "customer", userId }, (trx) =>
      KyselySagaRepository.findBy(trx, sql`order_group_id = ${orderGroupId}::uuid and user_id = ${userId}::uuid`),
    );
  }

  findByKey(userId: string, idempotencyKey: string): Promise<SagaRecord | null> {
    return this.tx({ kind: "system" }, (trx) =>
      KyselySagaRepository.findBy(trx, sql`user_id = ${userId}::uuid and idempotency_key = ${idempotencyKey}`),
    );
  }

  async save(next: SagaRecord, expectedVersion: number, events: readonly OutboxDraft[]): Promise<boolean> {
    return this.tx({ kind: "system" }, async (trx) => {
      const f = next.facts;
      const r = await sql<{ n: string }>`
        update checkout_sagas set
          status = ${f.status}, provider = ${next.provider},
          credit_amount = ${f.creditAmount.toString()}::bigint, external_amount = ${f.externalDue.toString()}::bigint,
          facts = ${toJson(f)}::jsonb,
          client_action = ${next.clientAction === null ? null : toJson(next.clientAction)}::jsonb,
          version = ${next.version}, attempts = ${next.attempts},
          next_wake_at = ${next.nextWakeAtMs === null ? null : iso(next.nextWakeAtMs)}::timestamptz,
          last_error = ${next.lastError},
          stuck_at = ${next.stuck ? iso(next.updatedAtMs) : null}::timestamptz
        where order_group_id = ${next.orderGroupId}::uuid and version = ${expectedVersion}
        returning 1::text as n`.execute(trx);
      if (r.rows.length === 0) return false;
      await KyselySagaRepository.emit(trx, events);
      return true;
    });
  }

  async due(nowMs: number, limit: number): Promise<readonly SagaRecord[]> {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<unknown>`
        select ${COLS} from checkout_sagas
         where status not in ${TERMINAL_SQL} and stuck_at is null and next_wake_at is not null
           and next_wake_at <= ${iso(nowMs)}::timestamptz
         order by next_wake_at, order_group_id limit ${Math.max(1, Math.min(limit, 500))}`.execute(trx);
      return r.rows.map(hydrate).filter((s) => !isTerminal(s.facts.status));
    });
  }

  async recordPaymentEvent(e: PaymentEventRecord): Promise<"new" | "duplicate"> {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ id: string }>`
        insert into checkout_payment_events (id, provider, event_id, order_group_id, intent_id, kind, amount,
                                             signature_ok, reject_reason, body, received_at)
        values (${e.id}::uuid, ${e.provider}, ${e.eventId},
                ${e.orderGroupId !== null && UUID.test(e.orderGroupId) ? e.orderGroupId : null}::uuid, ${e.intentId},
                ${e.kind}, ${e.amount === null ? null : e.amount.toString()}::bigint, ${e.signatureOk},
                ${e.rejectReason}, ${e.body}, ${iso(e.receivedAtMs)}::timestamptz)
        on conflict (provider, event_id) do nothing
        returning id::text as id`.execute(trx);
      return r.rows.length === 0 ? "duplicate" : "new";
    });
  }

  async markPaymentEventApplied(provider: string, eventId: string, atMs: number): Promise<void> {
    await this.tx({ kind: "system" }, async (trx) => {
      await sql`update checkout_payment_events set applied_at = ${iso(atMs)}::timestamptz
                 where provider = ${provider} and event_id = ${eventId} and applied_at is null`.execute(trx);
    });
  }
}
