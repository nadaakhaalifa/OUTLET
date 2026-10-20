import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type {
  BudgetEvent,
  BudgetRecord,
  BudgetStore,
  BudgetTx,
  CommitmentRecord,
  CycleRecord,
  GoalRecord,
  IdPort,
  SpendEventRecord,
  UnlockRequestRecord,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the reviews and sizing adapters. */
export type BudgetDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array).transform((v) => new Uint8Array(v));
const CapMode = z.enum(["off", "soft", "hard"]);

const BudgetRow = z.object({
  user_id: z.string(),
  amount: Bytes,
  per_category: Bytes.nullable(),
  payday: z.number().int(),
  cap_mode: CapMode,
  hold_ms: Ms.nullable(),
  version: z.number().int(),
  created_ms: Ms,
  updated_ms: Ms,
});
const CycleRow = z.object({
  user_id: z.string(),
  start_ms: Ms,
  end_ms: Ms,
  spent: Bytes,
  refunded: Bytes,
  refund_received: Bytes,
  rolled_ms: Ms,
  updated_ms: Ms,
});
const EventRow = z.object({
  user_id: z.string(),
  event_key: z.string(),
  kind: z.enum(["placed", "refund", "cod_refusal"]),
  placed_ms: Ms,
  occurred_ms: Ms,
  detail: Bytes,
});
const CommitmentRow = z.object({
  user_id: z.string(),
  provider: z.string(),
  source: z.enum(["provider", "user"]),
  starts_ms: Ms,
  ends_ms: Ms,
  monthly: Bytes,
});
const GoalRow = z.object({ id: z.string(), user_id: z.string(), title: Bytes, target_amount: Bytes, target_date: z.string().nullable() });
const UnlockRow = z.object({ id: z.string(), user_id: z.string(), requested_ms: Ms, unlock_ms: Ms });

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const iso = (ms: number): string => new Date(ms).toISOString();
const buf = (b: Uint8Array): Buffer => Buffer.from(b);

const BUDGET_COLS = sql`user_id::text as user_id, amount, per_category, payday::int as payday, cap_mode,
  ${EPOCH_MS("hold_until")} as hold_ms, version::int as version, ${EPOCH_MS("created_at")} as created_ms,
  ${EPOCH_MS("updated_at")} as updated_ms`;
const CYCLE_COLS = sql`user_id::text as user_id, ${EPOCH_MS("cycle_start")} as start_ms, ${EPOCH_MS("cycle_end")} as end_ms,
  spent, refunded, refund_received, ${EPOCH_MS("rolled_at")} as rolled_ms, ${EPOCH_MS("updated_at")} as updated_ms`;
const EVENT_COLS = sql`user_id::text as user_id, event_key, kind, ${EPOCH_MS("order_placed_at")} as placed_ms,
  ${EPOCH_MS("occurred_at")} as occurred_ms, detail`;

const aggregateOf = (e: BudgetEvent): string => e.userId;

/** Outbox payload: ids and enums only. No amounts, no category names, no store ids. */
const payloadOf = (e: BudgetEvent): Record<string, string | number | boolean | null> => {
  switch (e.type) {
    case "budget.set":
      return { user_id: e.userId, cap_mode: e.capMode, has_categories: e.hasCategories };
    case "budget.cycle_rolled":
      return { user_id: e.userId, cycle_start: iso(e.cycleStartMs) };
    case "budget.cap_unlock_requested":
      return { user_id: e.userId, unlock_at: iso(e.unlockAtMs) };
    case "budget.data_purged":
      return { user_id: e.userId, reason: e.reason };
  }
};

/**
 * Postgres adapter. One transaction per call under the `system` role (authorization is the
 * policy guard; RLS stays on for every other role). `run` takes a transaction advisory lock on
 * the user so concurrent orders serialize on the cap check; `read` is a READ ONLY transaction so
 * the database itself guarantees the affordability filter cannot write.
 */
export class KyselyBudgetStore implements BudgetStore {
  constructor(
    private readonly db: BudgetDb,
    private readonly ids: IdPort,
  ) {}

  private bind(trx: BudgetDb, userId: string): BudgetTx {
    const uid = sql`${userId}::uuid`;
    const ids = this.ids;
    return {
      async getBudget() {
        const r = await sql<unknown>`select ${BUDGET_COLS} from budgets where user_id = ${uid}`.execute(trx);
        const row = r.rows[0];
        if (row === undefined) return null;
        const p = BudgetRow.parse(row);
        return {
          userId: p.user_id,
          amountEnc: p.amount,
          perCategoryEnc: p.per_category,
          payday: p.payday,
          capMode: p.cap_mode,
          holdUntilMs: p.hold_ms,
          version: p.version,
          createdAtMs: p.created_ms,
          updatedAtMs: p.updated_ms,
        } satisfies BudgetRecord;
      },
      async putBudget(r) {
        await sql`
          insert into budgets (user_id, amount, per_category, payday, cap_mode, hold_until, version, created_at, updated_at)
          values (${uid}, ${buf(r.amountEnc)}, ${r.perCategoryEnc === null ? null : buf(r.perCategoryEnc)}, ${r.payday},
                  ${r.capMode}, ${r.holdUntilMs === null ? null : iso(r.holdUntilMs)}::timestamptz, ${r.version},
                  ${iso(r.createdAtMs)}::timestamptz, ${iso(r.updatedAtMs)}::timestamptz)
          on conflict (user_id) do update set amount = excluded.amount, per_category = excluded.per_category,
            payday = excluded.payday, cap_mode = excluded.cap_mode, hold_until = excluded.hold_until,
            version = excluded.version, updated_at = excluded.updated_at`.execute(trx);
      },
      async getCycle(startMs) {
        const r = await sql<unknown>`select ${CYCLE_COLS} from budget_cycles
          where user_id = ${uid} and cycle_start = ${iso(startMs)}::timestamptz`.execute(trx);
        const row = r.rows[0];
        return row === undefined ? null : toCycle(CycleRow.parse(row));
      },
      async putCycle(c) {
        const r = await sql<{ inserted: boolean }>`
          insert into budget_cycles (user_id, cycle_start, cycle_end, spent, refunded, refund_received, rolled_at, updated_at)
          values (${uid}, ${iso(c.startMs)}::timestamptz, ${iso(c.endMs)}::timestamptz, ${buf(c.spentEnc)},
                  ${buf(c.refundedEnc)}, ${buf(c.refundReceivedEnc)}, ${iso(c.rolledAtMs)}::timestamptz, ${iso(c.updatedAtMs)}::timestamptz)
          on conflict (user_id, cycle_start) do update set cycle_end = excluded.cycle_end, spent = excluded.spent,
            refunded = excluded.refunded, refund_received = excluded.refund_received, updated_at = excluded.updated_at
          returning (xmax = 0) as inserted`.execute(trx);
        return r.rows[0]?.inserted === true ? "inserted" : "updated";
      },
      async listSpendEvents(sinceMs) {
        const r = await sql<unknown>`select ${EVENT_COLS} from budget_spend_events
          where user_id = ${uid} and (order_placed_at >= ${iso(sinceMs)}::timestamptz or occurred_at >= ${iso(sinceMs)}::timestamptz)
          order by occurred_at, event_key limit 5000`.execute(trx);
        return r.rows.map((x) => {
          const p = EventRow.parse(x);
          return { userId: p.user_id, key: p.event_key, kind: p.kind, orderPlacedAtMs: p.placed_ms, occurredAtMs: p.occurred_ms, detailEnc: p.detail } satisfies SpendEventRecord;
        });
      },
      async insertSpendEvent(e) {
        const r = await sql<{ k: string }>`
          insert into budget_spend_events (user_id, event_key, kind, order_placed_at, occurred_at, detail)
          values (${uid}, ${e.key}, ${e.kind}, ${iso(e.orderPlacedAtMs)}::timestamptz, ${iso(e.occurredAtMs)}::timestamptz, ${buf(e.detailEnc)})
          on conflict (user_id, event_key) do nothing returning event_key as k`.execute(trx);
        return r.rows.length > 0 ? "inserted" : "exists";
      },
      async deleteSpendEvent(key) {
        const r = await sql<{ k: string }>`delete from budget_spend_events where user_id = ${uid} and event_key = ${key} returning event_key as k`.execute(trx);
        return r.rows.length > 0;
      },
      async listCommitments() {
        const r = await sql<unknown>`select user_id::text as user_id, provider, source, ${EPOCH_MS("starts_at")} as starts_ms,
          ${EPOCH_MS("ends_at")} as ends_ms, monthly from installment_commitments where user_id = ${uid}
          order by source, provider, starts_at`.execute(trx);
        return r.rows.map((x) => {
          const p = CommitmentRow.parse(x);
          return { userId: p.user_id, provider: p.provider, source: p.source, startsAtMs: p.starts_ms, endsAtMs: p.ends_ms, monthlyEnc: p.monthly } satisfies CommitmentRecord;
        });
      },
      async replaceCommitments(source, records) {
        await sql`delete from installment_commitments where user_id = ${uid} and source = ${source}`.execute(trx);
        for (const c of records) {
          await sql`insert into installment_commitments (user_id, provider, source, starts_at, ends_at, monthly)
            values (${uid}, ${c.provider}, ${c.source}, ${iso(c.startsAtMs)}::timestamptz, ${iso(c.endsAtMs)}::timestamptz, ${buf(c.monthlyEnc)})
            on conflict do nothing`.execute(trx);
        }
      },
      async listGoals() {
        const r = await sql<unknown>`select id::text as id, user_id::text as user_id, title, target_amount, target_date::text as target_date
          from savings_goals where user_id = ${uid} order by created_at, id`.execute(trx);
        return r.rows.map((x) => {
          const p = GoalRow.parse(x);
          return { id: p.id, userId: p.user_id, titleEnc: p.title, targetAmountEnc: p.target_amount, targetDate: p.target_date } satisfies GoalRecord;
        });
      },
      async insertUnlockRequest(r) {
        await sql`insert into budget_unlock_requests (id, user_id, requested_at, unlock_at)
          values (${r.id}::uuid, ${uid}, ${iso(r.requestedAtMs)}::timestamptz, ${iso(r.unlockAtMs)}::timestamptz)`.execute(trx);
      },
      async latestUnlockRequest() {
        const r = await sql<unknown>`select id::text as id, user_id::text as user_id, ${EPOCH_MS("requested_at")} as requested_ms,
          ${EPOCH_MS("unlock_at")} as unlock_ms from budget_unlock_requests where user_id = ${uid}
          order by requested_at desc limit 1`.execute(trx);
        const row = r.rows[0];
        if (row === undefined) return null;
        const p = UnlockRow.parse(row);
        return { id: p.id, userId: p.user_id, requestedAtMs: p.requested_ms, unlockAtMs: p.unlock_ms } satisfies UnlockRequestRecord;
      },
      async listCycles(limit) {
        const r = await sql<unknown>`select ${CYCLE_COLS} from budget_cycles where user_id = ${uid}
          order by cycle_start desc limit ${limit}`.execute(trx);
        return r.rows.map((x) => toCycle(CycleRow.parse(x)));
      },
      async deleteAll() {
        let touched = 0;
        for (const table of ["budget_unlock_requests", "savings_goals", "installment_commitments", "budget_spend_events", "budget_cycles", "budgets"] as const) {
          const r = await sql<{ n: string }>`with d as (
            delete from ${sql.table(table)} where user_id = ${uid} returning 1) select count(*)::text as n from d`.execute(trx);
          if (Number(r.rows[0]?.n ?? 0) > 0) touched += 1;
        }
        return touched;
      },
      async emit(events) {
        for (const e of events) {
          await sql`
            insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
            values (${ids.uuidV7()}::uuid, 'budget', ${aggregateOf(e)}::uuid, ${e.type},
                    ${`budget:${aggregateOf(e)}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
        }
      },
    };
  }

  async run<T>(userId: string, fn: (tx: BudgetTx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`budget:${userId}`}, 0))`.execute(trx);
      return fn(this.bind(trx as unknown as BudgetDb, userId));
    });
  }

  async read<T>(userId: string, fn: (tx: BudgetTx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return fn(this.bind(trx as unknown as BudgetDb, userId));
    });
  }

  async usersWithBudget(after: string | null, limit: number): Promise<readonly string[]> {
    const r = await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return sql<{ id: string }>`select user_id::text as id from budgets
        where (${after}::uuid is null or user_id > ${after}::uuid) order by user_id limit ${limit}`.execute(trx);
    });
    return r.rows.map((x) => x.id);
  }
}

const toCycle = (p: z.infer<typeof CycleRow>): CycleRecord => ({
  userId: p.user_id,
  startMs: p.start_ms,
  endMs: p.end_ms,
  spentEnc: p.spent,
  refundedEnc: p.refunded,
  refundReceivedEnc: p.refund_received,
  rolledAtMs: p.rolled_ms,
  updatedAtMs: p.updated_ms,
});
