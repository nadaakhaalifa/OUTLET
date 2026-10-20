import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type {
  CodeInsert,
  IdPort,
  Referral,
  ReferralCodeRecord,
  ReferralEvent,
  ReferralStore,
  SettleInput,
  SettleResult,
} from "../domain/ports";
import { REFERRAL_STATUSES, REJECT_REASONS } from "../domain/rules";

/** Raw SQL only, rows validated with Zod (same approach as the wishlists adapter). */
export type ReferralDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));

const CodeRow = z.object({ id: z.string(), owner_user_id: z.string(), code: z.string(), created_ms: Ms });

const ReferralRow = z.object({
  id: z.string(),
  code_id: z.string(),
  referrer_id: z.string(),
  referee_id: z.string(),
  status: z.enum(REFERRAL_STATUSES),
  reject_reason: z.enum(REJECT_REASONS).nullable(),
  referee_device_hashes: z.array(z.string()),
  order_id: z.string().nullable(),
  payment_fingerprint_hash: z.string().nullable(),
  reward_amount: Int.transform((s) => BigInt(s)).nullable(),
  attributed_ms: Ms,
  settled_ms: Ms.nullable(),
});

const CODE_COLS = sql`id::text as id, owner_user_id::text as owner_user_id, code::text as code,
  floor(extract(epoch from created_at) * 1000)::text as created_ms`;

const REF_COLS = sql`id::text as id, code_id::text as code_id, referrer_id::text as referrer_id,
  referee_id::text as referee_id, status, reject_reason, referee_device_hashes, order_id::text as order_id,
  payment_fingerprint_hash::text as payment_fingerprint_hash, reward_amount::text as reward_amount,
  floor(extract(epoch from attributed_at) * 1000)::text as attributed_ms,
  floor(extract(epoch from settled_at) * 1000)::text as settled_ms`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number): string => new Date(ms).toISOString();

const toCode = (raw: unknown): ReferralCodeRecord => {
  const r = CodeRow.parse(raw);
  return { id: r.id, ownerUserId: r.owner_user_id, code: r.code, createdAtMs: r.created_ms };
};

const toReferral = (raw: unknown): Referral => {
  const r = ReferralRow.parse(raw);
  return {
    id: r.id,
    codeId: r.code_id,
    referrerId: r.referrer_id,
    refereeId: r.referee_id,
    status: r.status,
    rejectReason: r.reject_reason,
    refereeDeviceHashes: r.referee_device_hashes,
    orderId: r.order_id,
    paymentFingerprintHash: r.payment_fingerprint_hash,
    rewardAmount: r.reward_amount,
    attributedAtMs: r.attributed_ms,
    settledAtMs: r.settled_ms,
  };
};

/** JSON payload for the outbox. Amounts are strings (bigint safe). No contact data, ids only. */
const payloadOf = (e: ReferralEvent): Record<string, string | number> => {
  switch (e.type) {
    case "referral.attributed":
      return { referral_id: e.referralId, referrer_id: e.referrerId, referee_id: e.refereeId };
    case "referral.attribution_rejected":
      return { referral_id: e.referralId, referrer_id: e.referrerId, referee_id: e.refereeId, reason: e.reason };
    case "referral.rejected":
      return { referral_id: e.referralId, referrer_id: e.referrerId, reason: e.reason };
    case "referral.reward_earned":
      return {
        referral_id: e.referralId,
        beneficiary_user_id: e.beneficiaryUserId,
        amount: e.amount.toString(),
        currency: e.currency,
        kind: e.kind,
        idempotency_key: e.idempotencyKey,
      };
    case "referral.plus_month_earned":
      return {
        referral_id: e.referralId,
        beneficiary_user_id: e.beneficiaryUserId,
        months: e.months,
        idempotency_key: e.idempotencyKey,
      };
  }
};

/**
 * Postgres adapter. Every method is one transaction under the `system` role (authorization is
 * the policy guard; RLS stays on for every other role). Events go to outbox_events in the same
 * transaction as the state change; this adapter never touches the ledger.
 */
export class KyselyReferralStore implements ReferralStore {
  constructor(
    private readonly db: ReferralDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: ReferralDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as ReferralDb);
    });
  }

  private async emit(trx: ReferralDb, referralId: string, events: readonly ReferralEvent[]): Promise<void> {
    for (const e of events) {
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'referral', ${referralId}::uuid, ${e.type},
                ${`referral:${referralId}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  async ensureCode(input: { id: string; ownerUserId: string; code: string; nowMs: number }): Promise<CodeInsert> {
    return this.tx(async (trx) => {
      const ins = await sql<unknown>`
        insert into referral_codes (id, owner_user_id, code, created_at)
        values (${input.id}::uuid, ${input.ownerUserId}::uuid, ${input.code}, ${iso(input.nowMs)}::timestamptz)
        on conflict do nothing
        returning ${CODE_COLS}`.execute(trx);
      const created = ins.rows[0];
      if (created !== undefined) return { kind: "created", record: toCode(created) };
      const own = await sql<unknown>`
        select ${CODE_COLS} from referral_codes where owner_user_id = ${input.ownerUserId}::uuid`.execute(trx);
      const row = own.rows[0];
      return row === undefined ? { kind: "code_taken" } : { kind: "existing", record: toCode(row) };
    });
  }

  async findCode(code: string): Promise<ReferralCodeRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${CODE_COLS} from referral_codes where code = ${code} and disabled_at is null`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toCode(row);
    });
  }

  async getByReferee(refereeId: string): Promise<Referral | null> {
    if (!UUID.test(refereeId)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${REF_COLS} from referrals where referee_id = ${refereeId}::uuid`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toReferral(row);
    });
  }

  async listByReferrer(referrerId: string): Promise<readonly Referral[]> {
    if (!UUID.test(referrerId)) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${REF_COLS} from referrals where referrer_id = ${referrerId}::uuid
        order by attributed_at, id`.execute(trx);
      return r.rows.map(toReferral);
    });
  }

  async countRewarded(referrerId: string, sinceMs: number | null): Promise<number> {
    if (!UUID.test(referrerId)) return 0;
    return this.tx(async (trx) => {
      const since = sinceMs === null ? null : iso(sinceMs);
      const r = await sql<{ n: string }>`
        select count(*)::text as n from referrals
        where referrer_id = ${referrerId}::uuid and status = 'rewarded'
          and (${since}::timestamptz is null or settled_at >= ${since}::timestamptz)`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async insertAttribution(referral: Referral, events: readonly ReferralEvent[]): Promise<"inserted" | "exists"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into referrals (id, code_id, referrer_id, referee_id, status, reject_reason,
          referee_device_hashes, attributed_at, settled_at)
        values (${referral.id}::uuid, ${referral.codeId}::uuid, ${referral.referrerId}::uuid,
          ${referral.refereeId}::uuid, ${referral.status}, ${referral.rejectReason},
          ${JSON.stringify(referral.refereeDeviceHashes)}::jsonb, ${iso(referral.attributedAtMs)}::timestamptz,
          ${referral.settledAtMs === null ? null : iso(referral.settledAtMs)}::timestamptz)
        on conflict (referee_id) do nothing
        returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return "exists";
      await this.emit(trx, referral.id, events);
      return "inserted";
    });
  }

  async settle(input: {
    consumer: string;
    messageId: string;
    change: SettleInput | null;
    events: readonly ReferralEvent[];
  }): Promise<SettleResult> {
    return this.tx(async (trx) => {
      const seen = await sql<{ message_id: string }>`
        insert into inbox_processed (consumer, message_id)
        values (${input.consumer}, ${input.messageId}::uuid)
        on conflict do nothing
        returning message_id::text as message_id`.execute(trx);
      if (seen.rows[0] === undefined) return { kind: "duplicate" };
      const c = input.change;
      if (c === null) return { kind: "applied", outcome: "recorded", plusMonths: 0 };

      let status: string = c.status;
      let reason = c.rejectReason;
      let amount = c.rewardAmount;
      let events: ReferralEvent[] = [...input.events];
      let plusMonths = 0;
      let outcome: "rewarded" | "capped" | "recorded" = c.status === "rewarded" ? "rewarded" : "recorded";
      const g = c.guard;
      if (c.status === "rewarded" && g !== undefined && UUID.test(g.referrerId)) {
        // Serialise per referrer for the rest of this transaction, then recount under the lock.
        await sql`select pg_advisory_xact_lock(hashtext(${"referrals:" + g.referrerId}))`.execute(trx);
        const cnt = await sql<{ in_window: string; total: string }>`
          select count(*) filter (where settled_at >= ${iso(g.windowStartMs)}::timestamptz)::text as in_window,
                 count(*)::text as total
          from referrals where referrer_id = ${g.referrerId}::uuid and status = 'rewarded'`.execute(trx);
        const inWindow = Number(cnt.rows[0]?.in_window ?? 0);
        const total = Number(cnt.rows[0]?.total ?? 0);
        if (inWindow >= g.maxInWindow) {
          status = "rejected";
          reason = "cap_reached";
          amount = null;
          outcome = "capped";
          events = [{ type: "referral.rejected", referralId: c.referralId, referrerId: g.referrerId, reason: "cap_reached" }];
        } else if ((total + 1) % g.milestoneEvery === 0 && g.milestonePlusMonths > 0) {
          plusMonths = g.milestonePlusMonths;
          events.push({
            type: "referral.plus_month_earned",
            referralId: c.referralId,
            beneficiaryUserId: g.referrerId,
            months: plusMonths,
            idempotencyKey: `referral:${c.referralId}:plus`,
          });
        }
      }
      const upd = await sql<{ id: string }>`
        update referrals set
          status = ${status}, reject_reason = ${reason}, order_id = ${c.orderId}::uuid,
          payment_fingerprint_hash = ${c.paymentFingerprintHash},
          reward_amount = ${amount === null ? null : amount.toString()}::bigint,
          reward_currency = ${amount === null ? null : "EGP"},
          settled_at = ${iso(c.settledAtMs)}::timestamptz
        where id = ${c.referralId}::uuid and status = 'attributed'
        returning id::text as id`.execute(trx);
      // Already settled by another message: the effect (and its events) happened once already.
      if (upd.rows[0] === undefined) return { kind: "applied", outcome: "already_settled", plusMonths: 0 };
      await this.emit(trx, c.referralId, events);
      return { kind: "applied", outcome, plusMonths };
    });
  }
}
