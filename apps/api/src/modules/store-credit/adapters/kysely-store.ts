import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  EXPIRING_PLATFORM_KINDS,
  parseSubKey,
  planLotSpend,
  subBalanceKey,
  type CreditLot,
  type Money,
} from "../domain/bridge";
import type {
  CreditReason,
  CreditTxn,
  CreditTxnKind,
  HoldLine,
  HoldRecord,
  NewLot,
  PlaceHoldResult,
  StoreCreditStore,
} from "../domain/ports";

export type StoreCreditDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();

const LotRow = z.object({
  id: z.string(),
  user_id: z.string(),
  sub_key: z.string(),
  granted: Big,
  remaining: Big,
  held: Big,
  expires_ms: Ms.nullable(),
  created_ms: Ms,
});
const HoldRow = z.object({
  id: z.string(),
  user_id: z.string(),
  ref: z.string(),
  status: z.enum(["held", "captured", "released"]),
  amount: Big,
  expires_ms: Ms,
  order_entry_key: z.string().nullable(),
  created_ms: Ms,
  resolved_ms: Ms.nullable(),
});
const HoldLineRow = z.object({ lot_id: z.string(), sub_key: z.string(), amount: Big });
const TxnRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(["credit_added", "credit_used", "credit_expired"]),
  reason: z.enum(["refund", "gift_card", "cashback", "referral", "goodwill", "order", "expiry"]),
  sub_key: z.string(),
  amount: Big,
  ref: z.string().nullable(),
  dedupe_key: z.string(),
  created_ms: Ms,
});

const LOT_COLS = sql`id::text as id, user_id::text as user_id, sub_key, granted::text as granted,
  remaining::text as remaining, held::text as held,
  floor(extract(epoch from expires_at) * 1000)::text as expires_ms,
  floor(extract(epoch from created_at) * 1000)::text as created_ms`;
const HOLD_COLS = sql`id::text as id, user_id::text as user_id, ref, status, amount::text as amount,
  floor(extract(epoch from expires_at) * 1000)::text as expires_ms, order_entry_key,
  floor(extract(epoch from created_at) * 1000)::text as created_ms,
  floor(extract(epoch from resolved_at) * 1000)::text as resolved_ms`;
const TXN_COLS = sql`id::text as id, user_id::text as user_id, kind, reason, sub_key, amount::text as amount,
  ref, dedupe_key, floor(extract(epoch from created_at) * 1000)::text as created_ms`;

const toLot = (raw: unknown): CreditLot => {
  const r = LotRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    sub: parseSubKey(r.sub_key),
    granted: r.granted,
    remaining: r.remaining,
    held: r.held,
    expiresAtMs: r.expires_ms,
    createdAtMs: r.created_ms,
  };
};
const toTxn = (raw: unknown): CreditTxn => {
  const r = TxnRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind as CreditTxnKind,
    reason: r.reason as CreditReason,
    sub: parseSubKey(r.sub_key),
    amount: r.amount,
    ref: r.ref,
    dedupeKey: r.dedupe_key,
    createdAtMs: r.created_ms,
  };
};
const PLATFORM_KEYS = EXPIRING_PLATFORM_KINDS.map((k) => k as string);

/**
 * Postgres adapter. Every mutating method is one transaction under the `system` role. A user's
 * lots are locked (`FOR UPDATE`) before a hold is planned, so two checkouts cannot spend the same
 * credit; the plan itself is the pure `planLotSpend`, shared with the in-memory reference.
 */
export class KyselyStoreCredit implements StoreCreditStore {
  constructor(private readonly db: StoreCreditDb) {}

  private async tx<T>(run: (trx: StoreCreditDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as StoreCreditDb);
    });
  }

  private async insertTxn(trx: StoreCreditDb, t: CreditTxn): Promise<void> {
    await sql`
      insert into credit_transactions (id, user_id, kind, reason, sub_key, amount, ref, dedupe_key, created_at)
      values (${t.id === "" ? sql`gen_random_uuid()` : sql`${t.id}::uuid`}, ${t.userId}::uuid, ${t.kind}, ${t.reason}, ${subBalanceKey(t.sub)},
        ${t.amount.toString()}::bigint, ${t.ref}, ${t.dedupeKey}, ${iso(t.createdAtMs)}::timestamptz)
      on conflict (dedupe_key) do nothing`.execute(trx);
  }

  async addLot(input: { lot: NewLot; txn: CreditTxn }): Promise<"added" | "exists"> {
    const l = input.lot;
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into credit_lots (id, user_id, sub_key, granted, remaining, held, expires_at, source_key, created_at)
        values (${l.id}::uuid, ${l.userId}::uuid, ${subBalanceKey(l.sub)}, ${l.granted.toString()}::bigint,
          ${l.remaining.toString()}::bigint, 0, ${l.expiresAtMs === null ? null : iso(l.expiresAtMs)}::timestamptz,
          ${l.sourceKey}, ${iso(l.createdAtMs)}::timestamptz)
        on conflict (source_key) do nothing
        returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return "exists";
      await this.insertTxn(trx, input.txn);
      return "added";
    });
  }

  async listLots(userId: string): Promise<readonly CreditLot[]> {
    if (!UUID.test(userId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${LOT_COLS} from credit_lots where user_id = ${userId}::uuid and remaining > 0
        order by created_at, id`.execute(trx);
      return r.rows.map(toLot);
    });
  }

  private async holdWithLines(trx: StoreCreditDb, raw: unknown): Promise<HoldRecord> {
    const h = HoldRow.parse(raw);
    const lines = await sql<unknown>`
      select lot_id::text as lot_id, sub_key, amount::text as amount from credit_hold_lines
      where hold_id = ${h.id}::uuid order by lot_id`.execute(trx);
    const parsed: HoldLine[] = lines.rows.map((x) => {
      const r = HoldLineRow.parse(x);
      return { lotId: r.lot_id, sub: parseSubKey(r.sub_key), amount: r.amount };
    });
    return {
      id: h.id,
      userId: h.user_id,
      ref: h.ref,
      status: h.status,
      amount: h.amount,
      expiresAtMs: h.expires_ms,
      orderEntryKey: h.order_entry_key,
      createdAtMs: h.created_ms,
      resolvedAtMs: h.resolved_ms,
      lines: parsed,
    };
  }

  async placeHold(input: {
    id: string;
    userId: string;
    ref: string;
    amount: Money;
    nowMs: number;
    expiresAtMs: number;
  }): Promise<PlaceHoldResult> {
    return this.tx(async (trx) => {
      // One transaction-scoped advisory lock per user serialises every hold for that user, even
      // when the user has no lot row yet to lock; the lots are then locked too.
      await sql`select pg_advisory_xact_lock(hashtextextended(${"store-credit:" + input.userId}, 0))`.execute(trx);
      const locked = await sql<unknown>`
        select ${LOT_COLS} from credit_lots where user_id = ${input.userId}::uuid and remaining > 0
        order by created_at, id for update`.execute(trx);
      const prior = await sql<unknown>`
        select ${HOLD_COLS} from credit_holds where user_id = ${input.userId}::uuid and ref = ${input.ref}`.execute(trx);
      if (prior.rows[0] !== undefined) return { kind: "exists", hold: await this.holdWithLines(trx, prior.rows[0]) };
      const lots = locked.rows.map(toLot);
      let takes;
      try {
        takes = planLotSpend(lots, input.amount, input.nowMs);
      } catch {
        const available = lots.reduce(
          (a, l) => a + (l.expiresAtMs !== null && l.expiresAtMs <= input.nowMs ? 0n : l.remaining - l.held),
          0n,
        );
        return { kind: "insufficient", available };
      }
      await sql`
        insert into credit_holds (id, user_id, ref, status, amount, expires_at, created_at)
        values (${input.id}::uuid, ${input.userId}::uuid, ${input.ref}, 'held', ${input.amount.amount.toString()}::bigint,
          ${iso(input.expiresAtMs)}::timestamptz, ${iso(input.nowMs)}::timestamptz)`.execute(trx);
      for (const t of takes) {
        await sql`
          insert into credit_hold_lines (hold_id, lot_id, sub_key, amount)
          values (${input.id}::uuid, ${t.lotId}::uuid, ${subBalanceKey(t.sub)}, ${t.amount.amount.toString()}::bigint)`.execute(trx);
        await sql`update credit_lots set held = held + ${t.amount.amount.toString()}::bigint where id = ${t.lotId}::uuid`.execute(trx);
      }
      const h = await sql<unknown>`select ${HOLD_COLS} from credit_holds where id = ${input.id}::uuid`.execute(trx);
      return { kind: "held", hold: await this.holdWithLines(trx, h.rows[0]) };
    });
  }

  async getHold(userId: string, ref: string): Promise<HoldRecord | null> {
    if (!UUID.test(userId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${HOLD_COLS} from credit_holds where user_id = ${userId}::uuid and ref = ${ref}`.execute(trx);
      return r.rows[0] === undefined ? null : this.holdWithLines(trx, r.rows[0]);
    });
  }

  private async lockHold(trx: StoreCreditDb, userId: string, ref: string): Promise<HoldRecord | null> {
    const r = await sql<unknown>`
      select ${HOLD_COLS} from credit_holds where user_id = ${userId}::uuid and ref = ${ref} for update`.execute(trx);
    return r.rows[0] === undefined ? null : this.holdWithLines(trx, r.rows[0]);
  }

  async releaseHold(userId: string, ref: string, nowMs: number): Promise<"released" | "not_found" | "not_held"> {
    if (!UUID.test(userId)) return "not_found";
    return this.tx(async (trx) => {
      const h = await this.lockHold(trx, userId, ref);
      if (h === null) return "not_found";
      if (h.status !== "held") return "not_held";
      for (const l of h.lines) {
        await sql`update credit_lots set held = held - ${l.amount.toString()}::bigint where id = ${l.lotId}::uuid`.execute(trx);
      }
      await sql`
        update credit_holds set status = 'released', resolved_at = ${iso(nowMs)}::timestamptz where id = ${h.id}::uuid`.execute(trx);
      return "released";
    });
  }

  async captureHold(input: { userId: string; ref: string; orderEntryKey: string; nowMs: number }) {
    if (!UUID.test(input.userId)) return { kind: "not_found" as const };
    return this.tx(async (trx) => {
      const h = await this.lockHold(trx, input.userId, input.ref);
      if (h === null) return { kind: "not_found" as const };
      if (h.status === "captured" && h.orderEntryKey === input.orderEntryKey) return { kind: "captured" as const, hold: h };
      if (h.status !== "held") return { kind: "not_held" as const };
      for (const l of h.lines) {
        await sql`
          update credit_lots set held = held - ${l.amount.toString()}::bigint,
            remaining = remaining - ${l.amount.toString()}::bigint where id = ${l.lotId}::uuid`.execute(trx);
        await this.insertTxn(trx, {
          id: "", // the database assigns it; the dedupe key makes the write idempotent
          userId: h.userId,
          kind: "credit_used",
          reason: "order",
          sub: l.sub,
          amount: l.amount,
          ref: input.ref,
          dedupeKey: `used:${h.id}:${l.lotId}`,
          createdAtMs: input.nowMs,
        });
      }
      await sql`
        update credit_holds set status = 'captured', order_entry_key = ${input.orderEntryKey},
          resolved_at = ${iso(input.nowMs)}::timestamptz where id = ${h.id}::uuid`.execute(trx);
      return { kind: "captured" as const, hold: { ...h, status: "captured" as const, orderEntryKey: input.orderEntryKey, resolvedAtMs: input.nowMs } };
    });
  }

  async listExpiredHolds(nowMs: number, limit: number): Promise<readonly HoldRecord[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${HOLD_COLS} from credit_holds where status = 'held' and expires_at <= ${iso(nowMs)}::timestamptz
        order by expires_at, id limit ${limit}`.execute(trx);
      const out: HoldRecord[] = [];
      for (const row of r.rows) out.push(await this.holdWithLines(trx, row));
      return out;
    });
  }

  async listSweepable(nowMs: number, limit: number): Promise<readonly CreditLot[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${LOT_COLS} from credit_lots
        where remaining > 0 and held = 0 and expires_at is not null and expires_at <= ${iso(nowMs)}::timestamptz
          and sub_key = any(${PLATFORM_KEYS})
        order by expires_at, id limit ${limit}`.execute(trx);
      return r.rows.map(toLot);
    });
  }

  async expireLot(input: { lotId: string; txn: CreditTxn }): Promise<"expired" | "stale"> {
    if (!UUID.test(input.lotId)) return "stale";
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        update credit_lots set remaining = 0 where id = ${input.lotId}::uuid and remaining > 0 and held = 0
        returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return "stale";
      await this.insertTxn(trx, input.txn);
      return "expired";
    });
  }

  async listTransactions(
    userId: string,
    page: { after: { createdAtMs: number; id: string } | null; limit: number },
  ): Promise<readonly CreditTxn[]> {
    if (!UUID.test(userId)) return [];
    return this.tx(async (trx) => {
      const a = page.after;
      const r =
        a === null || !UUID.test(a.id)
          ? await sql<unknown>`
              select ${TXN_COLS} from credit_transactions where user_id = ${userId}::uuid
              order by created_at desc, id desc limit ${page.limit}`.execute(trx)
          : await sql<unknown>`
              select ${TXN_COLS} from credit_transactions where user_id = ${userId}::uuid
                and (created_at, id) < (${iso(a.createdAtMs)}::timestamptz, ${a.id}::uuid)
              order by created_at desc, id desc limit ${page.limit}`.execute(trx);
      return r.rows.map(toTxn);
    });
  }

  async listUserIds(after: string | null, limit: number): Promise<readonly string[]> {
    return this.tx(async (trx) => {
      const r =
        after === null || !UUID.test(after)
          ? await sql<{ u: string }>`
              select distinct user_id::text as u from credit_lots order by u limit ${limit}`.execute(trx)
          : await sql<{ u: string }>`
              select distinct user_id::text as u from credit_lots where user_id::text > ${after}
              order by u limit ${limit}`.execute(trx);
      return r.rows.map((x) => x.u);
    });
  }

  async listCaptured(userId: string) {
    if (!UUID.test(userId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<{ sub_key: string; amount: string; order_entry_key: string }>`
        select hl.sub_key, hl.amount::text as amount, h.order_entry_key
        from credit_holds h join credit_hold_lines hl on hl.hold_id = h.id
        where h.user_id = ${userId}::uuid and h.status = 'captured' and h.order_entry_key is not null`.execute(trx);
      return r.rows.map((x) => ({ subKey: x.sub_key, amount: BigInt(x.amount), orderEntryKey: x.order_entry_key }));
    });
  }
}
