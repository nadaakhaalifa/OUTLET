import { sql, type Kysely, type RawBuilder } from "kysely";
import { z } from "zod";
import { REDEMPTION_THROTTLE, evaluateThrottle, next } from "../domain/bridge";
import type {
  AdmitAttempt,
  AttemptRecord,
  ConfirmApply,
  BeginRedemption,
  CardPatch,
  CardRecord,
  CasResult,
  ContributionRecord,
  GiftCardStore,
  IdPort,
  KeysetPos,
  OutboxDraft,
  PotRecord,
  RedemptionRecord,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the budget and reviews adapters. */
export type GiftCardDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Big = z.string().regex(/^-?\d+$/).transform((s) => BigInt(s));
const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array).transform((v) => new Uint8Array(v));
const CARD_STATUS = z.enum(["PENDING_PAYMENT", "POT_OPEN", "ISSUED", "DELIVERED", "REDEEMED", "EXPIRED", "VOIDED", "CANCELLED"]);
const POT_STATUS = z.enum(["OPEN", "CLOSED_FUNDED", "CLOSED_UNFUNDED", "REFUNDING", "REFUNDED"]);

const CardRow = z.object({
  id: z.string(),
  purchaser_id: z.string(),
  code_hash: z.string().nullable(),
  code_key_version: z.number().int().nullable(),
  last4: z.string().nullable(),
  amount: Big,
  remaining: Big,
  status: CARD_STATUS,
  scope_store_id: z.string().nullable(),
  expires_ms: Ms.nullable(),
  design: z.enum(["birthday", "eid", "ramadan", "wedding", "new_baby", "graduation", "thank_you"]),
  recipient_channel: z.enum(["whatsapp", "sms", "email", "in_app"]),
  recipient_contact: Bytes.nullable(),
  message: Bytes.nullable(),
  scheduled_ms: Ms.nullable(),
  pot_id: z.string().nullable(),
  payment_intent_id: z.string().nullable(),
  idempotency_key: z.string(),
  version: z.number().int(),
  created_ms: Ms,
  issued_ms: Ms.nullable(),
  delivered_ms: Ms.nullable(),
});
const RedemptionRow = z.object({
  id: z.string(),
  card_id: z.string(),
  user_id: z.string(),
  amount: Big,
  status: z.enum(["pending", "completed", "reversed"]),
  status_before: z.enum(["ISSUED", "DELIVERED"]),
  journal_entry_id: z.string().nullable(),
  created_ms: Ms,
});
const PotRow = z.object({
  id: z.string(),
  organiser_id: z.string(),
  organiser_nickname: z.string(),
  target: Big,
  closes_ms: Ms,
  status: POT_STATUS,
  card_id: z.string(),
  share_token_hash: z.string(),
  version: z.number().int(),
  created_ms: Ms,
  closed_ms: Ms.nullable(),
});
const ContributionRow = z.object({
  id: z.string(),
  pot_id: z.string(),
  user_id: z.string(),
  amount: Big,
  payment_intent_id: z.string().nullable(),
  status: z.enum(["pending", "pending_void", "paid", "cancelled", "refunded", "refund_failed"]),
  idempotency_key: z.string(),
  created_ms: Ms,
});

const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const iso = (ms: number): string => new Date(ms).toISOString();
const ts = (ms: number | null) => (ms === null ? sql`null::timestamptz` : sql`${iso(ms)}::timestamptz`);
const buf = (b: Uint8Array | null) => (b === null ? sql`null::bytea` : sql`${Buffer.from(b)}::bytea`);

const CARD_COLS = sql`id::text as id, purchaser_id::text as purchaser_id, code_hash, code_key_version::int as code_key_version,
  last4, amount::text as amount, remaining::text as remaining, status, scope_store_id::text as scope_store_id,
  ${EPOCH("expires_at")} as expires_ms, design, recipient_channel, recipient_contact, message,
  ${EPOCH("scheduled_at")} as scheduled_ms, pot_id::text as pot_id, payment_intent_id, idempotency_key,
  version::int as version, ${EPOCH("created_at")} as created_ms, ${EPOCH("issued_at")} as issued_ms,
  ${EPOCH("delivered_at")} as delivered_ms`;
const REDEMPTION_COLS = sql`id::text as id, card_id::text as card_id, user_id::text as user_id, amount::text as amount,
  status, status_before, journal_entry_id::text as journal_entry_id, ${EPOCH("created_at")} as created_ms`;
const POT_COLS = sql`id::text as id, organiser_id::text as organiser_id, organiser_nickname, target::text as target,
  ${EPOCH("closes_at")} as closes_ms, status, card_id::text as card_id, share_token_hash, version::int as version,
  ${EPOCH("created_at")} as created_ms, ${EPOCH("closed_at")} as closed_ms`;
const CONTRIB_COLS = sql`id::text as id, pot_id::text as pot_id, user_id::text as user_id, amount::text as amount,
  payment_intent_id, status, idempotency_key, ${EPOCH("created_at")} as created_ms`;

const toCard = (raw: unknown): CardRecord => {
  const r = CardRow.parse(raw);
  return {
    id: r.id,
    purchaserId: r.purchaser_id,
    codeHash: r.code_hash,
    codeKeyVersion: r.code_key_version,
    last4: r.last4,
    amount: r.amount,
    remaining: r.remaining,
    status: r.status,
    scopeStoreId: r.scope_store_id,
    expiresAtMs: r.expires_ms,
    design: r.design,
    recipientChannel: r.recipient_channel,
    recipientContactEnc: r.recipient_contact,
    messageEnc: r.message,
    scheduledAtMs: r.scheduled_ms,
    potId: r.pot_id,
    paymentIntentId: r.payment_intent_id,
    idempotencyKey: r.idempotency_key,
    version: r.version,
    createdAtMs: r.created_ms,
    issuedAtMs: r.issued_ms,
    deliveredAtMs: r.delivered_ms,
  };
};
const toRedemption = (raw: unknown): RedemptionRecord => {
  const r = RedemptionRow.parse(raw);
  return {
    id: r.id,
    cardId: r.card_id,
    userId: r.user_id,
    amount: r.amount,
    status: r.status,
    statusBefore: r.status_before,
    journalEntryId: r.journal_entry_id,
    createdAtMs: r.created_ms,
  };
};
const toPot = (raw: unknown): PotRecord => {
  const r = PotRow.parse(raw);
  return {
    id: r.id,
    organiserId: r.organiser_id,
    organiserNickname: r.organiser_nickname,
    target: r.target,
    closesAtMs: r.closes_ms,
    status: r.status,
    cardId: r.card_id,
    shareTokenHash: r.share_token_hash,
    version: r.version,
    createdAtMs: r.created_ms,
    closedAtMs: r.closed_ms,
  };
};
const toContribution = (raw: unknown): ContributionRecord => {
  const r = ContributionRow.parse(raw);
  return {
    id: r.id,
    potId: r.pot_id,
    userId: r.user_id,
    amount: r.amount,
    paymentIntentId: r.payment_intent_id,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    createdAtMs: r.created_ms,
  };
};

type Trx = GiftCardDb;

/**
 * Postgres store. Every method runs in one transaction as `app.role = 'system'` (the module is
 * the only writer; owners are filtered by the policy guard and RLS stays on for all other roles).
 * Card and pot rows are locked FOR UPDATE where a balance or state decision is made.
 */
export class KyselyGiftCardStore implements GiftCardStore {
  constructor(
    private readonly db: GiftCardDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(fn: (t: Trx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return fn(trx as unknown as Trx);
    });
  }

  private async emit(t: Trx, events: readonly OutboxDraft[]): Promise<void> {
    for (const e of events) {
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${e.aggregateType}, ${e.aggregateId}::uuid, ${e.type},
                ${`${e.aggregateType}:${e.aggregateId}`}, ${JSON.stringify(e.payload)}::jsonb)`.execute(t);
    }
  }

  private async cardById(t: Trx, id: string, lock: boolean): Promise<CardRecord | null> {
    const r = await sql<unknown>`select ${CARD_COLS} from gift_cards where id = ${id}::uuid ${lock ? sql`for update` : sql``}`.execute(t);
    return r.rows[0] === undefined ? null : toCard(r.rows[0]);
  }

  private async patchCard(t: Trx, id: string, patch: CardPatch): Promise<CardRecord> {
    const sets: RawBuilder<unknown>[] = [sql`version = version + 1`, sql`updated_at = now()`];
    if (patch.codeHash !== undefined) sets.push(sql`code_hash = ${patch.codeHash}`);
    if (patch.codeKeyVersion !== undefined) sets.push(sql`code_key_version = ${patch.codeKeyVersion}`);
    if (patch.last4 !== undefined) sets.push(sql`last4 = ${patch.last4}`);
    if (patch.status !== undefined) sets.push(sql`status = ${patch.status}`);
    if (patch.expiresAtMs !== undefined) sets.push(sql`expires_at = ${ts(patch.expiresAtMs)}`);
    if (patch.paymentIntentId !== undefined) sets.push(sql`payment_intent_id = ${patch.paymentIntentId}`);
    if (patch.issuedAtMs !== undefined) sets.push(sql`issued_at = ${ts(patch.issuedAtMs)}`);
    if (patch.deliveredAtMs !== undefined) sets.push(sql`delivered_at = ${ts(patch.deliveredAtMs)}`);
    if (patch.remaining !== undefined) sets.push(sql`remaining = ${patch.remaining.toString()}::bigint`);
    const r = await sql<unknown>`update gift_cards set ${sql.join(sets)} where id = ${id}::uuid returning ${CARD_COLS}`.execute(t);
    return toCard(r.rows[0]);
  }

  async insertCard(card: CardRecord, events: readonly OutboxDraft[]) {
    return this.tx(async (t) => {
      const ins = await sql<unknown>`
        insert into gift_cards (id, purchaser_id, code_hash, code_key_version, last4, amount, remaining, status, scope_store_id,
          expires_at, design, recipient_channel, recipient_contact, message, scheduled_at, pot_id, payment_intent_id,
          idempotency_key, created_at)
        values (${card.id}::uuid, ${card.purchaserId}::uuid, ${card.codeHash}, ${card.codeKeyVersion}, ${card.last4},
          ${card.amount.toString()}::bigint, ${card.remaining.toString()}::bigint, ${card.status}, ${card.scopeStoreId}::uuid,
          ${ts(card.expiresAtMs)}, ${card.design}, ${card.recipientChannel}, ${buf(card.recipientContactEnc)},
          ${buf(card.messageEnc)}, ${ts(card.scheduledAtMs)}, ${card.potId}::uuid, ${card.paymentIntentId},
          ${card.idempotencyKey}, ${ts(card.createdAtMs)})
        on conflict (purchaser_id, idempotency_key) do nothing
        returning ${CARD_COLS}`.execute(t);
      if (ins.rows[0] !== undefined) {
        await this.emit(t, events);
        return { kind: "created" as const, card: toCard(ins.rows[0]) };
      }
      const ex = await sql<unknown>`select ${CARD_COLS} from gift_cards
        where purchaser_id = ${card.purchaserId}::uuid and idempotency_key = ${card.idempotencyKey}`.execute(t);
      return { kind: "duplicate" as const, card: toCard(ex.rows[0]) };
    });
  }

  async getCard(id: string) {
    return this.tx((t) => this.cardById(t, id, false));
  }

  async findByCodeHash(hash: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CARD_COLS} from gift_cards where code_hash = ${hash}`.execute(t);
      return r.rows[0] === undefined ? null : toCard(r.rows[0]);
    });
  }

  async listByPurchaser(userId: string, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CARD_COLS} from gift_cards where purchaser_id = ${userId}::uuid
        order by created_at desc, id desc limit ${limit}`.execute(t);
      return r.rows.map(toCard);
    });
  }

  async updateCard(id: string, expectedVersion: number, patch: CardPatch, events: readonly OutboxDraft[]): Promise<CasResult> {
    return this.tx(async (t) => {
      const cur = await this.cardById(t, id, true);
      if (cur === null) return { kind: "not_found" };
      if (cur.version !== expectedVersion) return { kind: "conflict" };
      const card = await this.patchCard(t, id, patch);
      await this.emit(t, events);
      return { kind: "ok", card };
    });
  }

  async listExpirable(nowMs: number, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<{ id: string }>`select id::text as id from gift_cards
        where status in ('ISSUED','DELIVERED') and expires_at <= ${ts(nowMs)} order by expires_at limit ${limit}`.execute(t);
      return r.rows.map((x) => x.id);
    });
  }

  async beginRedemption(input: {
    cardId: string;
    userId: string;
    requested: bigint | null;
    redemptionId: string;
    nowMs: number;
  }): Promise<BeginRedemption> {
    return this.tx(async (t) => {
      const c = await this.cardById(t, input.cardId, true);
      if (c === null || c.codeHash === null) return { kind: "not_found" };
      if (c.status === "REDEEMED") return { kind: "empty" };
      if (c.status !== "ISSUED" && c.status !== "DELIVERED") return { kind: "unavailable", status: c.status };
      if (c.expiresAtMs !== null && input.nowMs >= c.expiresAtMs) return { kind: "unavailable", status: "EXPIRED" };
      if (c.remaining <= 0n) return { kind: "empty" };
      const amount = input.requested ?? c.remaining;
      if (amount <= 0n) return { kind: "empty" };
      if (amount > c.remaining) return { kind: "exceeds_balance", remaining: c.remaining };
      const remaining = c.remaining - amount;
      const full = remaining === 0n;
      const status = full ? next(c.status, "REDEEM", { nowMs: input.nowMs, expiresAtMs: c.expiresAtMs }) : c.status;
      const card = await this.patchCard(t, c.id, { remaining, status });
      await sql`insert into gift_card_redemptions (id, card_id, user_id, amount, status, status_before, created_at)
        values (${input.redemptionId}::uuid, ${c.id}::uuid, ${input.userId}::uuid, ${amount.toString()}::bigint, 'pending',
                ${c.status}, ${ts(input.nowMs)})`.execute(t);
      const redemption: RedemptionRecord = {
        id: input.redemptionId,
        cardId: c.id,
        userId: input.userId,
        amount,
        status: "pending",
        statusBefore: c.status,
        journalEntryId: null,
        createdAtMs: input.nowMs,
      };
      return { kind: "ok", redemption, card, full };
    });
  }

  async completeRedemption(redemptionId: string, journalEntryId: string, nowMs: number, events: readonly OutboxDraft[]) {
    await this.tx(async (t) => {
      const r = await sql`update gift_card_redemptions set status = 'completed', journal_entry_id = ${journalEntryId}::uuid,
        completed_at = ${ts(nowMs)} where id = ${redemptionId}::uuid and status = 'pending'`.execute(t);
      if (Number(r.numAffectedRows ?? 0) > 0) await this.emit(t, events);
    });
  }

  async reverseRedemption(redemptionId: string) {
    await this.tx(async (t) => {
      const r = await sql<unknown>`select ${REDEMPTION_COLS} from gift_card_redemptions
        where id = ${redemptionId}::uuid and status = 'pending' for update`.execute(t);
      if (r.rows[0] === undefined) return;
      const red = toRedemption(r.rows[0]);
      const c = await this.cardById(t, red.cardId, true);
      if (c === null) return;
      await this.patchCard(t, c.id, { remaining: c.remaining + red.amount, status: red.statusBefore });
      await sql`update gift_card_redemptions set status = 'reversed' where id = ${redemptionId}::uuid`.execute(t);
    });
  }

  async listPendingRedemptions(olderThanMs: number, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${REDEMPTION_COLS} from gift_card_redemptions
        where status = 'pending' and created_at <= ${ts(olderThanMs)} order by created_at, id limit ${limit}`.execute(t);
      return r.rows.map(toRedemption);
    });
  }

  async listRedemptions(cardId: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${REDEMPTION_COLS} from gift_card_redemptions where card_id = ${cardId}::uuid
        order by created_at, id`.execute(t);
      return r.rows.map(toRedemption);
    });
  }

  async recordAttempt(a: AttemptRecord) {
    await this.tx(async (t) => {
      await sql`insert into gift_card_attempts (id, account_id, device_hash, ip_hash, outcome, at)
        values (${a.id}::uuid, ${a.accountId}::uuid, ${a.deviceHash}, ${a.ipHash}, ${a.outcome}, ${ts(a.atMs)})`.execute(t);
    });
  }

  async admitAttempt(a: Omit<AttemptRecord, "outcome">): Promise<AdmitAttempt> {
    const t = REDEMPTION_THROTTLE;
    return this.tx(async (trx) => {
      // serialise check-then-record per account, device and ip (sorted keys: no deadlock)
      for (const key of [`gca:${a.accountId}`, `gcd:${a.deviceHash}`, `gci:${a.ipHash}`].sort()) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
      }
      const times = async (who: ReturnType<typeof sql>, windowMs: number): Promise<number[]> => {
        const r = await sql<{ ms: string }>`select ${EPOCH("at")} as ms from gift_card_attempts
          where outcome in ('wrong', 'pending') and ${who} and at > ${ts(a.atMs - windowMs)} order by at`.execute(trx);
        return r.rows.map((x) => Number(x.ms));
      };
      const verdict = evaluateThrottle({
        nowMs: a.atMs,
        accountFailuresMs: await times(sql`account_id = ${a.accountId}::uuid`, t.accountWindowMs),
        deviceFailuresMs: await times(sql`device_hash = ${a.deviceHash}`, t.deviceWindowMs),
        ipFailuresMs: await times(sql`ip_hash = ${a.ipHash}`, t.ipWindowMs),
      });
      await sql`insert into gift_card_attempts (id, account_id, device_hash, ip_hash, outcome, at)
        values (${a.id}::uuid, ${a.accountId}::uuid, ${a.deviceHash}, ${a.ipHash},
                ${verdict.allowed ? "pending" : "throttled"}, ${ts(a.atMs)})`.execute(trx);
      return verdict.allowed ? { allowed: true as const } : { allowed: false as const, scope: verdict.scope, retryAfterMs: verdict.retryAfterMs };
    });
  }

  async finalizeAttempt(id: string, outcome: "ok" | "wrong") {
    await this.tx(async (t) => {
      await sql`update gift_card_attempts set outcome = ${outcome} where id = ${id}::uuid and outcome = 'pending'`.execute(t);
    });
  }

  async failureTimes(scope: { accountId: string } | { deviceHash: string } | { ipHash: string }, sinceMs: number) {
    return this.tx(async (t) => {
      const who =
        "accountId" in scope
          ? sql`account_id = ${scope.accountId}::uuid`
          : "deviceHash" in scope
            ? sql`device_hash = ${scope.deviceHash}`
            : sql`ip_hash = ${scope.ipHash}`;
      const r = await sql<{ ms: string }>`select ${EPOCH("at")} as ms from gift_card_attempts
        where outcome in ('wrong', 'pending') and ${who} and at > ${ts(sinceMs)} order by at`.execute(t);
      return r.rows.map((x) => Number(x.ms));
    });
  }

  async purgeAttemptsBefore(cutoffMs: number) {
    return this.tx(async (t) => {
      const r = await sql`delete from gift_card_attempts where at < ${ts(cutoffMs)}`.execute(t);
      return Number(r.numAffectedRows ?? 0);
    });
  }

  async insertPot(pot: PotRecord, card: CardRecord, events: readonly OutboxDraft[]) {
    return this.tx(async (t) => {
      const ex = await sql<unknown>`select ${CARD_COLS} from gift_cards
        where purchaser_id = ${card.purchaserId}::uuid and idempotency_key = ${card.idempotencyKey}`.execute(t);
      const existing = ex.rows[0];
      if (existing !== undefined) {
        const c = toCard(existing);
        if (c.potId !== null) {
          const p = await sql<unknown>`select ${POT_COLS} from gift_pots where id = ${c.potId}::uuid`.execute(t);
          if (p.rows[0] !== undefined) return { kind: "duplicate" as const, pot: toPot(p.rows[0]), card: c };
        }
      }
      await sql`insert into gift_pots (id, organiser_id, organiser_nickname, target, closes_at, status, card_id, share_token_hash, created_at)
        values (${pot.id}::uuid, ${pot.organiserId}::uuid, ${pot.organiserNickname}, ${pot.target.toString()}::bigint,
                ${ts(pot.closesAtMs)}, ${pot.status}, ${pot.cardId}::uuid, ${pot.shareTokenHash}, ${ts(pot.createdAtMs)})`.execute(t);
      await sql`insert into gift_cards (id, purchaser_id, amount, remaining, status, design, recipient_channel,
          recipient_contact, message, pot_id, idempotency_key, created_at)
        values (${card.id}::uuid, ${card.purchaserId}::uuid, ${card.amount.toString()}::bigint, ${card.remaining.toString()}::bigint,
                ${card.status}, ${card.design}, ${card.recipientChannel}, ${buf(card.recipientContactEnc)}, ${buf(card.messageEnc)},
                ${pot.id}::uuid, ${card.idempotencyKey}, ${ts(card.createdAtMs)})`.execute(t);
      await this.emit(t, events);
      return { kind: "created" as const, pot, card };
    });
  }

  async getPot(id: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${POT_COLS} from gift_pots where id = ${id}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : toPot(r.rows[0]);
    });
  }

  async getPotByTokenHash(hash: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${POT_COLS} from gift_pots where share_token_hash = ${hash}`.execute(t);
      return r.rows[0] === undefined ? null : toPot(r.rows[0]);
    });
  }

  async updatePot(
    id: string,
    expectedVersion: number,
    patch: { status: PotRecord["status"]; closedAtMs?: number },
    cardPatch: { patch: CardPatch; events: readonly OutboxDraft[] } | null,
    events: readonly OutboxDraft[],
  ) {
    return this.tx(async (t) => {
      const cur = await sql<unknown>`select ${POT_COLS} from gift_pots where id = ${id}::uuid for update`.execute(t);
      if (cur.rows[0] === undefined) return { kind: "not_found" as const };
      const p = toPot(cur.rows[0]);
      if (p.version !== expectedVersion) return { kind: "conflict" as const };
      const closed = patch.closedAtMs === undefined ? sql`closed_at` : ts(patch.closedAtMs);
      const r = await sql<unknown>`update gift_pots set status = ${patch.status}, closed_at = ${closed}, version = version + 1
        where id = ${id}::uuid returning ${POT_COLS}`.execute(t);
      if (cardPatch !== null) {
        await this.patchCard(t, p.cardId, cardPatch.patch);
        await this.emit(t, cardPatch.events);
      }
      await this.emit(t, events);
      return { kind: "ok" as const, pot: toPot(r.rows[0]) };
    });
  }

  async listDuePots(nowMs: number, limit: number) {
    return this.tx(async (t) => {
      const r = await sql<{ id: string }>`select id::text as id from gift_pots
        where status = 'OPEN' and closes_at <= ${ts(nowMs)} order by closes_at limit ${limit}`.execute(t);
      return r.rows.map((x) => x.id);
    });
  }

  async listThrottledAttempts(after: KeysetPos | null, limit: number) {
    return this.tx(async (t) => {
      const cond = after === null ? sql`true` : sql`(at, id) < (${ts(after.ms)}, ${after.id}::uuid)`;
      const r = await sql<{ id: string; account_id: string; device_hash: string; ip_hash: string; ms: string }>`
        select id::text as id, account_id::text as account_id, device_hash, ip_hash, ${EPOCH("at")} as ms
        from gift_card_attempts where outcome = 'throttled' and ${cond} order by at desc, id desc limit ${limit}`.execute(t);
      return r.rows.map((x) => ({
        id: x.id,
        accountId: x.account_id,
        deviceHash: x.device_hash,
        ipHash: x.ip_hash,
        outcome: "throttled" as const,
        atMs: Number(x.ms),
      }));
    });
  }

  async listPotsPage(after: KeysetPos | null, limit: number) {
    return this.tx(async (t) => {
      const cond = after === null ? sql`true` : sql`(created_at, id) < (${ts(after.ms)}, ${after.id}::uuid)`;
      const r = await sql<unknown>`select ${POT_COLS} from gift_pots where ${cond} order by created_at desc, id desc limit ${limit}`.execute(t);
      return r.rows.map(toPot);
    });
  }

  async listPotsInState(state: PotRecord["status"], limit: number) {
    return this.tx(async (t) => {
      const r = await sql<{ id: string }>`select id::text as id from gift_pots where status = ${state}
        order by created_at limit ${limit}`.execute(t);
      return r.rows.map((x) => x.id);
    });
  }

  async insertContribution(c: ContributionRecord) {
    return this.tx(async (t) => {
      const ins = await sql<unknown>`insert into gift_pot_contributions (id, pot_id, user_id, amount, payment_intent_id, status,
          idempotency_key, created_at)
        values (${c.id}::uuid, ${c.potId}::uuid, ${c.userId}::uuid, ${c.amount.toString()}::bigint, ${c.paymentIntentId},
                ${c.status}, ${c.idempotencyKey}, ${ts(c.createdAtMs)})
        on conflict (user_id, idempotency_key) do nothing returning ${CONTRIB_COLS}`.execute(t);
      if (ins.rows[0] !== undefined) return { kind: "created" as const, contribution: toContribution(ins.rows[0]) };
      const ex = await sql<unknown>`select ${CONTRIB_COLS} from gift_pot_contributions
        where user_id = ${c.userId}::uuid and idempotency_key = ${c.idempotencyKey}`.execute(t);
      return { kind: "duplicate" as const, contribution: toContribution(ex.rows[0]) };
    });
  }

  async getContribution(id: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CONTRIB_COLS} from gift_pot_contributions where id = ${id}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : toContribution(r.rows[0]);
    });
  }

  async updateContribution(
    id: string,
    patch: { status: ContributionRecord["status"]; paymentIntentId?: string },
    onlyFrom?: readonly ContributionRecord["status"][],
  ) {
    return this.tx(async (t) => {
      const guard = onlyFrom === undefined ? sql`true` : sql`status in (${sql.join(onlyFrom.map((x) => sql`${x}`))})`;
      const r = await sql<unknown>`update gift_pot_contributions set status = ${patch.status},
          payment_intent_id = coalesce(${patch.paymentIntentId ?? null}, payment_intent_id), updated_at = now()
        where id = ${id}::uuid and ${guard} returning ${CONTRIB_COLS}`.execute(t);
      return r.rows[0] === undefined ? null : toContribution(r.rows[0]);
    });
  }

  async confirmContribution(contributionId: string, paymentIntentId: string): Promise<ConfirmApply> {
    return this.tx(async (t) => {
      const probe = await sql<{ pot_id: string }>`select pot_id from gift_pot_contributions where id = ${contributionId}::uuid`.execute(t);
      const potId = probe.rows[0]?.pot_id;
      if (potId === undefined) return { kind: "not_found" };
      // the pot row lock serialises every concurrent success webhook for this pot
      const pr = await sql<unknown>`select ${POT_COLS} from gift_pots where id = ${potId}::uuid for update`.execute(t);
      if (pr.rows[0] === undefined) return { kind: "not_found" };
      const pot = toPot(pr.rows[0]);
      const cr = await sql<unknown>`select ${CONTRIB_COLS} from gift_pot_contributions where id = ${contributionId}::uuid for update`.execute(t);
      if (cr.rows[0] === undefined) return { kind: "not_found" };
      const c = toContribution(cr.rows[0]);
      if (c.status !== "pending" && c.status !== "pending_void" && c.status !== "cancelled") return { kind: "replayed" };
      const sum = await sql<{ s: string }>`select coalesce(sum(amount), 0)::text as s from gift_pot_contributions
        where pot_id = ${potId}::uuid and status = 'paid'`.execute(t);
      const paid = BigInt(sum.rows[0]?.s ?? "0");
      const reason = pot.status !== "OPEN" ? ("pot_closed" as const) : paid + c.amount > pot.target ? ("overshoot" as const) : null;
      if (reason !== null) return { kind: "excess", reason, contribution: { ...c, paymentIntentId } };
      await sql`update gift_pot_contributions set status = 'paid', payment_intent_id = ${paymentIntentId}, updated_at = now()
        where id = ${contributionId}::uuid`.execute(t);
      return { kind: "applied" };
    });
  }

  async listContributionsInStatus(status: ContributionRecord["status"], limit: number) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CONTRIB_COLS} from gift_pot_contributions where status = ${status}
        order by created_at, id limit ${limit}`.execute(t);
      return r.rows.map(toContribution);
    });
  }

  async listContributions(potId: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${CONTRIB_COLS} from gift_pot_contributions where pot_id = ${potId}::uuid
        order by created_at, id`.execute(t);
      return r.rows.map(toContribution);
    });
  }
}
