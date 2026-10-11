import { sql, type Kysely, type RawBuilder } from "kysely";
import { z } from "zod";
import type { Clock } from "../../../platform/ports";
import { PAYOUT_STATES } from "../domain/bridge";
import {
  type ApplyResult,
  type AttemptLog,
  type HoldReason,
  type ListPage,
  type ListQuery,
  type NewPayout,
  type OutboxEventDraft,
  type PayoutLineRecord,
  type PayoutMovement,
  type PayoutRecord,
  type PayoutScope,
  type PayoutState,
  type PayoutStore,
  type TransitionCommand,
} from "../domain/ports";

/** Raw SQL only, rows validated with Zod (same approach as the orders adapter). */
export type PayoutsDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Amount = Int.transform((s) => BigInt(s));
const MAX_DATE_MS = 253_402_300_799_999;
const iso = (ms: number): string => new Date(Math.min(Math.max(ms, 0), MAX_DATE_MS)).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOLD = z.enum([
  "no_bank_details",
  "iban_name_mismatch",
  "name_check_unavailable",
  "risk_review",
  "exceeds_ledger_balance",
  "open_dispute",
  "manual_hold",
]);

const Row = z.object({
  id: z.string(),
  store_id: z.string(),
  cycle_key: z.string(),
  cutoff_ms: Ms,
  status: z.enum(PAYOUT_STATES),
  amount: Amount,
  eligible_total: Amount,
  netted_total: Amount,
  carry_forward: Amount,
  line_count: z.number().int(),
  account_token: z.string().nullable(),
  iban_last4: z.string().nullable(),
  hold_reason: HOLD.nullable(),
  approval_id: z.string().nullable(),
  approved_by: z.string().nullable(),
  approved_ms: Ms.nullable(),
  ledger_ref: z.string().nullable(),
  provider_ref: z.string().nullable(),
  attempts: z.number().int(),
  failure_code: z.string().nullable(),
  sent_ms: Ms.nullable(),
  settled_ms: Ms.nullable(),
  version: z.number().int(),
  created_ms: Ms,
  updated_ms: Ms,
});
const LineRow = z.object({
  payout_id: z.string(),
  source_type: z.enum(["seller_order", "clawback"]),
  source_id: z.string(),
  amount: Amount,
});

const ms = (col: string): string => `floor(extract(epoch from ${col}) * 1000)::text`;
const COLS = sql.raw(`
  id::text as id, store_id::text as store_id, cycle_key, ${ms("cutoff_at")} as cutoff_ms, status,
  amount::text as amount, eligible_total::text as eligible_total, netted_total::text as netted_total,
  carry_forward::text as carry_forward, line_count, account_token, iban_last4, hold_reason,
  approval_id::text as approval_id, approved_by::text as approved_by, ${ms("approved_at")} as approved_ms,
  ledger_ref, provider_ref, attempts, failure_code, ${ms("sent_at")} as sent_ms, ${ms("settled_at")} as settled_ms,
  version, ${ms("created_at")} as created_ms, ${ms("updated_at")} as updated_ms`);

/**
 * Postgres adapter. Reads run as the caller's RLS identity (seller stores or finance staff).
 * Writes run as `system` after the use case has authorised the action; state, lines, history,
 * attempts and outbox events are written in ONE transaction (A2.7).
 */
export class KyselyPayoutStore implements PayoutStore {
  constructor(
    private readonly db: PayoutsDb,
    private readonly clock: Clock,
    private readonly applicationRole: string | null = "app_user",
  ) {}

  private async tx<T>(scope: PayoutScope, run: (trx: PayoutsDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      const t = trx as unknown as PayoutsDb;
      if (this.applicationRole !== null) {
        if (!/^[a-z_][a-z0-9_]*$/.test(this.applicationRole)) throw new RangeError("invalid role name");
        await sql`SET LOCAL ROLE ${sql.id(this.applicationRole)}`.execute(t);
      }
      const role = scope.kind === "system" ? "system" : scope.kind === "seller" ? "seller" : scope.role;
      const userId = scope.kind === "system" ? "" : scope.userId;
      const stores = scope.kind === "seller" ? scope.storeIds.join(",") : "";
      await sql`select set_config('app.role', ${role}, true), set_config('app.user_id', ${userId}, true),
                       set_config('app.store_ids', ${stores}, true)`.execute(t);
      return run(t);
    });
  }

  private static async hydrate(trx: PayoutsDb, rows: readonly z.output<typeof Row>[]): Promise<PayoutRecord[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const ls = await sql<unknown>`
      select payout_id::text as payout_id, source_type, source_id, amount::text as amount
        from payout_lines where payout_id::text = any (${ids}::text[]) order by id`.execute(trx);
    const lines = new Map<string, PayoutLineRecord[]>();
    for (const raw of ls.rows) {
      const l = LineRow.parse(raw);
      lines.set(l.payout_id, [...(lines.get(l.payout_id) ?? []), { sourceType: l.source_type, sourceId: l.source_id, amount: l.amount }]);
    }
    return rows.map((r) => ({
      id: r.id,
      storeId: r.store_id,
      cycleKey: r.cycle_key,
      cutoffAtMs: r.cutoff_ms,
      status: r.status,
      amount: r.amount,
      eligibleTotal: r.eligible_total,
      nettedTotal: r.netted_total,
      carryForward: r.carry_forward,
      lineCount: r.line_count,
      accountToken: r.account_token,
      ibanLast4: r.iban_last4,
      holdReason: r.hold_reason as HoldReason | null,
      approvalId: r.approval_id,
      approvedBy: r.approved_by,
      approvedAtMs: r.approved_ms,
      ledgerRef: r.ledger_ref,
      providerRef: r.provider_ref,
      attempts: r.attempts,
      failureCode: r.failure_code,
      sentAtMs: r.sent_ms,
      settledAtMs: r.settled_ms,
      version: r.version,
      createdAtMs: r.created_ms,
      updatedAtMs: r.updated_ms,
      lines: lines.get(r.id) ?? [],
    }));
  }

  private static async load(trx: PayoutsDb, where: RawBuilder<unknown>): Promise<PayoutRecord[]> {
    const r = await sql<unknown>`select ${COLS} from payouts where ${where}`.execute(trx);
    return KyselyPayoutStore.hydrate(trx, r.rows.map((x) => Row.parse(x)));
  }

  private static async insertEvent(trx: PayoutsDb, e: OutboxEventDraft): Promise<void> {
    await sql`
      insert into outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, ordering_key, payload)
      values (${e.id}::uuid, ${iso(e.occurredAtMs)}::timestamptz, 'payout', ${e.aggregateId}::uuid, ${e.type},
              ${`payout:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(trx);
  }

  async create(n: NewPayout): Promise<{ kind: "created" | "duplicate"; payout: PayoutRecord }> {
    return this.tx({ kind: "system" }, async (trx) => {
      const ins = await sql<{ id: string }>`
        insert into payouts (id, store_id, cycle_key, cutoff_at, status, amount, eligible_total, netted_total,
                             carry_forward, line_count, account_token, iban_last4, version, created_at, updated_at)
        values (${n.id}::uuid, ${n.storeId}::uuid, ${n.cycleKey}, ${iso(n.cutoffAtMs)}::timestamptz, 'SCHEDULED',
                ${n.amount.toString()}::bigint, ${n.eligibleTotal.toString()}::bigint, ${n.nettedTotal.toString()}::bigint,
                ${n.carryForward.toString()}::bigint, ${n.lines.length}, ${n.accountToken}, ${n.ibanLast4}, 0,
                ${iso(n.nowMs)}::timestamptz, ${iso(n.nowMs)}::timestamptz)
        on conflict (store_id, cycle_key) where status <> 'CANCELLED' do nothing
        returning id::text as id`.execute(trx);
      if (ins.rows.length === 0) {
        const [existing] = await KyselyPayoutStore.load(
          trx,
          sql`store_id = ${n.storeId}::uuid and cycle_key = ${n.cycleKey} and status <> 'CANCELLED'`,
        );
        if (existing === undefined) throw new Error("payout vanished after conflict");
        return { kind: "duplicate" as const, payout: existing };
      }
      for (const l of n.lines) {
        await sql`
          insert into payout_lines (payout_id, store_id, source_type, source_id, amount, active)
          values (${n.id}::uuid, ${n.storeId}::uuid, ${l.sourceType}, ${l.sourceId}, ${l.amount.toString()}::bigint, true)`.execute(trx);
      }
      await KyselyPayoutStore.insertEvent(trx, n.event);
      const [created] = await KyselyPayoutStore.load(trx, sql`id = ${n.id}::uuid`);
      if (created === undefined) throw new Error("payout vanished after insert");
      return { kind: "created" as const, payout: created };
    });
  }

  async get(id: string, scope: PayoutScope): Promise<PayoutRecord | null> {
    if (!UUID.test(id)) return null;
    return this.tx(scope, async (trx) => (await KyselyPayoutStore.load(trx, sql`id = ${id}::uuid`))[0] ?? null);
  }

  async locate(id: string): Promise<{ storeId: string } | null> {
    if (!UUID.test(id)) return null;
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ store_id: string }>`select store_id::text as store_id from payouts where id = ${id}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : { storeId: row.store_id };
    });
  }

  async list(q: ListQuery): Promise<ListPage> {
    return this.tx(q.scope, async (trx) => {
      const parts: RawBuilder<unknown>[] = [sql`true`];
      if (q.scope.kind === "seller") {
        const stores = q.scope.storeIds.filter((s) => UUID.test(s));
        if (stores.length === 0) return { items: [], next: null };
        parts.push(sql`store_id::text = any (${stores}::text[])`);
      }
      if (q.storeId !== undefined) {
        if (!UUID.test(q.storeId)) return { items: [], next: null };
        parts.push(sql`store_id = ${q.storeId}::uuid`);
      }
      if (q.status !== undefined) parts.push(sql`status = ${q.status}`);
      if (q.cycleKey !== undefined) parts.push(sql`cycle_key = ${q.cycleKey}`);
      if (q.after !== null) {
        parts.push(sql`(created_at, id) < (${iso(q.after.createdAtMs)}::timestamptz, ${q.after.id}::uuid)`);
      }
      const where = sql.join(parts, sql` and `);
      const r = await sql<unknown>`
        select ${COLS} from payouts where ${where} order by created_at desc, id desc limit ${q.limit + 1}`.execute(trx);
      const rows = r.rows.map((x) => Row.parse(x));
      const page = rows.slice(0, q.limit);
      const items = await KyselyPayoutStore.hydrate(trx, page);
      const last = page[page.length - 1];
      return {
        items,
        next: rows.length > q.limit && last !== undefined ? { createdAtMs: last.created_ms, id: last.id } : null,
      };
    });
  }

  async activeSellerOrderIds(storeId: string): Promise<ReadonlySet<string>> {
    if (!UUID.test(storeId)) return new Set();
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ source_id: string }>`
        select source_id from payout_lines
         where store_id = ${storeId}::uuid and active and source_type = 'seller_order'`.execute(trx);
      return new Set(r.rows.map((x) => x.source_id));
    });
  }

  async appliedClawbacks(storeId: string): Promise<ReadonlyMap<string, bigint>> {
    if (!UUID.test(storeId)) return new Map();
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ source_id: string; total: string }>`
        select source_id, sum(amount)::text as total from payout_lines
         where store_id = ${storeId}::uuid and active and source_type = 'clawback' group by source_id`.execute(trx);
      return new Map(r.rows.map((x) => [x.source_id, BigInt(x.total)] as const));
    });
  }

  async movements(storeId: string): Promise<readonly PayoutMovement[]> {
    if (!UUID.test(storeId)) return [];
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ id: string; payout_id: string; event: string; amount: string; at_ms: string }>`
        select h.id::text as id, h.payout_id::text as payout_id, h.event, p.amount::text as amount,
               ${sql.raw(ms("h.occurred_at"))} as at_ms
          from payout_status_history h join payouts p on p.id = h.payout_id
         where h.store_id = ${storeId}::uuid and h.event in ('SEND', 'BANK_REJECTED')
         order by h.occurred_at, h.ctid`.execute(trx);
      return r.rows.map((x) => ({
        id: x.id,
        payoutId: x.payout_id,
        kind: x.event === "SEND" ? ("payout" as const) : ("payout_reversal" as const),
        amount: BigInt(x.amount),
        atMs: Number(x.at_ms),
      }));
    });
  }

  async hasCommand(payoutId: string, commandKey: string): Promise<boolean> {
    if (!UUID.test(payoutId)) return false;
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql`select 1 from payout_status_history
                           where payout_id = ${payoutId}::uuid and command_key = ${commandKey}`.execute(trx);
      return r.rows.length > 0;
    });
  }

  async apply(c: TransitionCommand): Promise<ApplyResult> {
    if (!UUID.test(c.payoutId)) return { kind: "not_found" };
    return this.tx({ kind: "system" }, async (trx) => {
      const locked = await sql<{ version: number; status: string; store_id: string }>`
        select version, status, store_id::text as store_id from payouts where id = ${c.payoutId}::uuid for update`.execute(trx);
      const head = locked.rows[0];
      if (head === undefined) return { kind: "not_found" as const };
      const reload = async (): Promise<PayoutRecord> => {
        const [p] = await KyselyPayoutStore.load(trx, sql`id = ${c.payoutId}::uuid`);
        if (p === undefined) throw new Error("payout vanished");
        return p;
      };
      const prior = await sql`select 1 from payout_status_history
                               where payout_id = ${c.payoutId}::uuid and command_key = ${c.commandKey}`.execute(trx);
      if (prior.rows.length > 0) return { kind: "replayed" as const, payout: await reload() };
      if (head.version !== c.expectedVersion || head.status !== c.from) return { kind: "conflict" as const };

      const t = c.patch;
      const set: RawBuilder<unknown>[] = [sql`status = ${c.to}`, sql`version = version + 1`];
      if (t.holdReason !== undefined) set.push(sql`hold_reason = ${t.holdReason}`);
      if (t.approvalId !== undefined) set.push(sql`approval_id = ${t.approvalId}::uuid`);
      if (t.approvedBy !== undefined) set.push(sql`approved_by = ${t.approvedBy}::uuid`);
      if (t.approvedAtMs !== undefined) set.push(sql`approved_at = ${t.approvedAtMs === null ? null : iso(t.approvedAtMs)}::timestamptz`);
      if (t.ledgerRef !== undefined) set.push(sql`ledger_ref = ${t.ledgerRef}`);
      if (t.providerRef !== undefined) set.push(sql`provider_ref = ${t.providerRef}`);
      if (t.attempts !== undefined) set.push(sql`attempts = ${t.attempts}`);
      if (t.failureCode !== undefined) set.push(sql`failure_code = ${t.failureCode}`);
      if (t.sentAtMs !== undefined) set.push(sql`sent_at = ${t.sentAtMs === null ? null : iso(t.sentAtMs)}::timestamptz`);
      if (t.settledAtMs !== undefined) set.push(sql`settled_at = ${t.settledAtMs === null ? null : iso(t.settledAtMs)}::timestamptz`);
      await sql`update payouts set ${sql.join(set, sql`, `)}
                 where id = ${c.payoutId}::uuid and version = ${c.expectedVersion}`.execute(trx);

      await sql`
        insert into payout_status_history (id, payout_id, store_id, from_status, to_status, event, actor_type, actor_id,
                                           reason_code, command_key, occurred_at)
        values (${c.historyId}::uuid, ${c.payoutId}::uuid, ${head.store_id}::uuid, ${c.from}, ${c.to}, ${c.event},
                ${c.actorType}, ${c.actorId}::uuid, ${c.reasonCode}, ${c.commandKey}, ${iso(c.nowMs)}::timestamptz)`.execute(trx);
      if (c.releaseLines) {
        await sql`update payout_lines set active = false where payout_id = ${c.payoutId}::uuid and active`.execute(trx);
      }
      if (c.attempt !== undefined) {
        await sql`
          insert into payout_attempts (payout_id, attempt_no, outcome, code, provider_ref, at)
          values (${c.payoutId}::uuid, ${c.attempt.attemptNo}, ${c.attempt.outcome}, ${c.attempt.code},
                  ${c.attempt.providerRef}, ${iso(c.attempt.atMs)}::timestamptz)`.execute(trx);
      }
      for (const e of c.events) await KyselyPayoutStore.insertEvent(trx, e);
      return { kind: "applied" as const, payout: await reload() };
    });
  }

  async recordAttempt(payoutId: string, a: AttemptLog): Promise<void> {
    if (!UUID.test(payoutId)) return;
    await this.tx({ kind: "system" }, async (trx) => {
      await sql`
        insert into payout_attempts (payout_id, attempt_no, outcome, code, provider_ref, at)
        values (${payoutId}::uuid, ${Math.max(1, a.attemptNo)}, ${a.outcome}, ${a.code}, ${a.providerRef},
                ${iso(a.atMs)}::timestamptz)`.execute(trx);
      if (a.providerRef !== null) {
        await sql`update payouts set provider_ref = ${a.providerRef} where id = ${payoutId}::uuid`.execute(trx);
      }
    });
  }

  async listIdsByStatus(status: PayoutState, limit: number): Promise<readonly string[]> {
    return this.tx({ kind: "system" }, async (trx) => {
      const r = await sql<{ id: string }>`
        select id::text as id from payouts where status = ${status} order by created_at, id limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.id);
    });
  }

  /** Test hook, same as the in-memory store. */
  now(): number {
    return this.clock.nowMs();
  }
}


