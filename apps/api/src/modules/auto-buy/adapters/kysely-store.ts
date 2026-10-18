import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { isAttemptState, MANDATE_LOCALES, OPEN_ATTEMPT_STATES } from "../domain/bridge";
import type {
  AttemptRecord,
  AutoBuyDomainEvent,
  AutoBuyStore,
  AutoBuyTx,
  IdPort,
  MandateRecord,
  MandateTextRecord,
  MandateWithLatest,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the budget and wishlists adapters. */
export type AutoBuyDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Big = z.string().regex(/^\d+$/).transform((s) => BigInt(s));

const MandateRow = z.object({
  id: z.string(),
  user_id: z.string(),
  sku_id: z.string(),
  size_label: z.string(),
  target_price: Big,
  max_price: Big,
  mode: z.enum(["notify_confirm", "unattended"]),
  psp_token_ref: z.string().nullable(),
  status: z.enum(["ARMED", "PURCHASED", "DISARMED", "EXPIRED"]),
  closed_reason: z.string().nullable(),
  expires_ms: Ms,
  mandate_version: z.number().int(),
  mandate_locale: z.enum(MANDATE_LOCALES),
  terms_sha256: z.string(),
  accepted_ms: Ms,
  accepted_device_id: z.string(),
  created_ms: Ms,
  updated_ms: Ms,
});

const AttemptRow = z.object({
  id: z.string(),
  mandate_id: z.string(),
  user_id: z.string(),
  price_event_id: z.string(),
  mode: z.enum(["notify_confirm", "unattended"]),
  state: z.string(),
  trigger_price: Big,
  charge_price: Big.nullable(),
  notice_ms: Ms.nullable(),
  deadline_ms: Ms.nullable(),
  charge_started_ms: Ms.nullable(),
  reservation_ref: z.string().nullable(),
  order_group_id: z.string().nullable(),
  failure_reason: z.string().nullable(),
  created_ms: Ms,
  updated_ms: Ms,
});

const TextRow = z.object({ version: z.number().int(), locale: z.enum(MANDATE_LOCALES), body: z.string(), body_sha256: z.string() });

const EPOCH = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const MANDATE_COLS = sql`id::text as id, user_id::text as user_id, sku_id::text as sku_id, size_label,
  target_price::text as target_price, max_price::text as max_price, mode, psp_token_ref, status, closed_reason,
  ${EPOCH("expires_at")} as expires_ms, mandate_version::int as mandate_version, mandate_locale, terms_sha256,
  ${EPOCH("accepted_at")} as accepted_ms, accepted_device_id, ${EPOCH("created_at")} as created_ms,
  ${EPOCH("updated_at")} as updated_ms`;

const ATTEMPT_COLS = sql`id::text as id, mandate_id::text as mandate_id, user_id::text as user_id, price_event_id, mode, state,
  trigger_price::text as trigger_price, charge_price::text as charge_price, ${EPOCH("notice_sent_at")} as notice_ms,
  ${EPOCH("cancel_deadline")} as deadline_ms, ${EPOCH("charge_started_at")} as charge_started_ms, reservation_ref,
  order_group_id::text as order_group_id, failure_reason, ${EPOCH("created_at")} as created_ms,
  ${EPOCH("updated_at")} as updated_ms`;

const toMandate = (p: z.infer<typeof MandateRow>): MandateRecord => ({
  id: p.id,
  userId: p.user_id,
  skuId: p.sku_id,
  sizeLabel: p.size_label,
  targetPrice: p.target_price,
  maxPrice: p.max_price,
  mode: p.mode,
  pspTokenRef: p.psp_token_ref,
  status: p.status,
  closedReason: p.closed_reason,
  expiresAtMs: p.expires_ms,
  mandateVersion: p.mandate_version,
  mandateLocale: p.mandate_locale,
  termsSha256: p.terms_sha256,
  acceptedAtMs: p.accepted_ms,
  acceptedDeviceId: p.accepted_device_id,
  createdAtMs: p.created_ms,
  updatedAtMs: p.updated_ms,
});

const toAttempt = (p: z.infer<typeof AttemptRow>): AttemptRecord => {
  if (!isAttemptState(p.state)) throw new Error(`unknown attempt state ${p.state}`);
  return {
    id: p.id,
    mandateId: p.mandate_id,
    userId: p.user_id,
    priceEventId: p.price_event_id,
    mode: p.mode,
    state: p.state,
    triggerPrice: p.trigger_price,
    chargePrice: p.charge_price,
    noticeSentAtMs: p.notice_ms,
    cancelDeadlineMs: p.deadline_ms,
    chargeStartedAtMs: p.charge_started_ms,
    reservationRef: p.reservation_ref,
    orderGroupId: p.order_group_id,
    failureReason: p.failure_reason,
    createdAtMs: p.created_ms,
    updatedAtMs: p.updated_ms,
  };
};

/** Outbox payload: ids and enums only. No prices, no token reference (spec Events, analytics rule). */
const payloadOf = (e: AutoBuyDomainEvent): Record<string, string | number | boolean | null> => {
  switch (e.type) {
    case "auto_buy.armed":
      return { user_id: e.userId, mandate_id: e.mandateId, mode: e.mode };
    case "auto_buy.notified":
      return {
        user_id: e.userId,
        mandate_id: e.mandateId,
        attempt_id: e.attemptId,
        mode: e.mode,
        cancel_deadline: e.cancelDeadlineMs === null ? null : iso(e.cancelDeadlineMs),
      };
    case "auto_buy.cancelled":
      return { user_id: e.userId, mandate_id: e.mandateId, attempt_id: e.attemptId, by: e.by };
    case "auto_buy.charged":
      return { user_id: e.userId, mandate_id: e.mandateId, attempt_id: e.attemptId, order_group_id: e.orderGroupId };
    case "auto_buy.manual_review":
      return { user_id: e.userId, mandate_id: e.mandateId, attempt_id: e.attemptId, reason: e.reason };
    case "auto_buy.failed":
      return { user_id: e.userId, mandate_id: e.mandateId, attempt_id: e.attemptId, reason: e.reason };
    case "auto_buy.manual_review_resolved":
      return { user_id: e.userId, mandate_id: e.mandateId, attempt_id: e.attemptId, resolution: e.resolution, resolver_id: e.resolverId };
  }
};

const OPEN_LIST = sql.join(OPEN_ATTEMPT_STATES.map((s) => sql`${s}`));

/**
 * Postgres adapter. One transaction per call under the `system` role (authorization is the
 * controller's owner-scoped lookup; RLS stays on for every other role). Mutating getters take a row
 * lock (`FOR UPDATE`), which is what makes cancel-versus-charge a clean race with one winner.
 */
export class KyselyAutoBuyStore implements AutoBuyStore {
  constructor(
    private readonly db: AutoBuyDb,
    private readonly ids: IdPort,
  ) {}

  private bind(trx: AutoBuyDb): AutoBuyTx {
    const ids = this.ids;
    const mandateBy = async (where: ReturnType<typeof sql>): Promise<MandateRecord | null> => {
      const r = await sql<unknown>`select ${MANDATE_COLS} from auto_buy_mandates where ${where} for update`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toMandate(MandateRow.parse(row));
    };
    const attemptBy = async (where: ReturnType<typeof sql>): Promise<AttemptRecord | null> => {
      const r = await sql<unknown>`select ${ATTEMPT_COLS} from auto_buy_attempts where ${where} for update`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toAttempt(AttemptRow.parse(row));
    };
    return {
      async getText(version, locale) {
        const r = await sql<unknown>`select version::int as version, locale, body, body_sha256 from auto_buy_mandate_texts
          where version = ${version} and locale = ${locale}`.execute(trx);
        const row = r.rows[0];
        if (row === undefined) return null;
        const p = TextRow.parse(row);
        return { version: p.version, locale: p.locale, body: p.body, bodySha256: p.body_sha256 } satisfies MandateTextRecord;
      },
      async putText(t) {
        await sql`insert into auto_buy_mandate_texts (version, locale, body, body_sha256)
          values (${t.version}, ${t.locale}, ${t.body}, ${t.bodySha256}) on conflict (version, locale) do nothing`.execute(trx);
      },
      async lockUser(userId) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${"auto_buy_user:" + userId}, 0))`.execute(trx);
      },
      async countArmed(userId) {
        const r = await sql<{ n: string }>`select count(*)::text as n from auto_buy_mandates
          where user_id = ${userId}::uuid and status = 'ARMED'`.execute(trx);
        return Number(r.rows[0]?.n ?? 0);
      },
      async insertMandate(m) {
        const r = await sql<{ id: string }>`
          insert into auto_buy_mandates (id, user_id, sku_id, size_label, target_price, max_price, mode, psp_token_ref, status,
            expires_at, mandate_version, mandate_locale, terms_sha256, accepted_at, accepted_device_id, created_at, updated_at)
          values (${m.id}::uuid, ${m.userId}::uuid, ${m.skuId}::uuid, ${m.sizeLabel}, ${m.targetPrice.toString()}::bigint,
            ${m.maxPrice.toString()}::bigint, ${m.mode}, ${m.pspTokenRef}, 'ARMED', ${iso(m.expiresAtMs)}::timestamptz,
            ${m.mandateVersion}, ${m.mandateLocale}, ${m.termsSha256}, ${iso(m.acceptedAtMs)}::timestamptz,
            ${m.acceptedDeviceId}, ${iso(m.createdAtMs)}::timestamptz, ${iso(m.updatedAtMs)}::timestamptz)
          on conflict (user_id, sku_id) where status = 'ARMED' do nothing
          returning id::text as id`.execute(trx);
        return r.rows.length === 0 ? "duplicate_active" : "inserted";
      },
      getMandateForUpdate: (id) => mandateBy(sql`id = ${id}::uuid`),
      getOwnedMandateForUpdate: (userId, id) => mandateBy(sql`id = ${id}::uuid and user_id = ${userId}::uuid`),
      async closeMandate(id, status, reason, atMs) {
        await sql`update auto_buy_mandates set status = ${status}, closed_reason = ${reason},
          updated_at = ${iso(atMs)}::timestamptz where id = ${id}::uuid`.execute(trx);
      },
      async lastAttemptAt(mandateId) {
        const r = await sql<{ ms: string | null }>`select ${EPOCH("max(created_at)")} as ms from auto_buy_attempts
          where mandate_id = ${mandateId}::uuid and notice_sent_at is not null`.execute(trx);
        const v = r.rows[0]?.ms;
        return v === undefined || v === null || v === "NaN" ? null : Number(v);
      },
      async insertAttempt(a) {
        const r = await sql<{ id: string }>`
          insert into auto_buy_attempts (id, mandate_id, user_id, price_event_id, mode, state, trigger_price, charge_price,
            notice_sent_at, cancel_deadline, charge_started_at, reservation_ref, order_group_id, failure_reason, created_at, updated_at)
          values (${a.id}::uuid, ${a.mandateId}::uuid, ${a.userId}::uuid, ${a.priceEventId}, ${a.mode}, ${a.state},
            ${a.triggerPrice.toString()}::bigint, ${a.chargePrice === null ? null : a.chargePrice.toString()}::bigint,
            ${isoOrNull(a.noticeSentAtMs)}::timestamptz, ${isoOrNull(a.cancelDeadlineMs)}::timestamptz,
            ${isoOrNull(a.chargeStartedAtMs)}::timestamptz, ${a.reservationRef}, ${a.orderGroupId}::uuid, ${a.failureReason},
            ${iso(a.createdAtMs)}::timestamptz, ${iso(a.updatedAtMs)}::timestamptz)
          on conflict (mandate_id, price_event_id) do nothing returning id::text as id`.execute(trx);
        return r.rows.length === 0 ? "exists" : "inserted";
      },
      getAttemptForUpdate: (id) => attemptBy(sql`id = ${id}::uuid`),
      getOwnedAttemptForUpdate: (userId, id) => attemptBy(sql`id = ${id}::uuid and user_id = ${userId}::uuid`),
      async updateAttempt(a) {
        await sql`update auto_buy_attempts set state = ${a.state}, charge_price = ${a.chargePrice === null ? null : a.chargePrice.toString()}::bigint,
          notice_sent_at = ${isoOrNull(a.noticeSentAtMs)}::timestamptz, cancel_deadline = ${isoOrNull(a.cancelDeadlineMs)}::timestamptz,
          charge_started_at = ${isoOrNull(a.chargeStartedAtMs)}::timestamptz, reservation_ref = ${a.reservationRef},
          order_group_id = ${a.orderGroupId}::uuid, failure_reason = ${a.failureReason}, updated_at = ${iso(a.updatedAtMs)}::timestamptz
          where id = ${a.id}::uuid`.execute(trx);
      },
      async openAttemptsOfMandate(mandateId) {
        const r = await sql<unknown>`select ${ATTEMPT_COLS} from auto_buy_attempts
          where mandate_id = ${mandateId}::uuid and state in (${OPEN_LIST}) order by created_at, id for update`.execute(trx);
        return r.rows.map((x) => toAttempt(AttemptRow.parse(x)));
      },
      async emit(events) {
        for (const e of events) {
          await sql`
            insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
            values (${ids.uuidV7()}::uuid, 'auto_buy', ${e.mandateId}::uuid, ${e.type},
                    ${`auto_buy:${e.mandateId}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
        }
      },
    };
  }

  async run<T>(fn: (tx: AutoBuyTx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return fn(this.bind(trx as unknown as AutoBuyDb));
    });
  }

  private async reading<T>(q: (trx: AutoBuyDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`set transaction read only`.execute(trx);
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return q(trx as unknown as AutoBuyDb);
    });
  }

  async listForUser(userId: string, limit: number): Promise<readonly MandateWithLatest[]> {
    return this.reading(async (trx) => {
      const ms = await sql<unknown>`select ${MANDATE_COLS} from auto_buy_mandates where user_id = ${userId}::uuid
        order by created_at desc, id desc limit ${limit}`.execute(trx);
      const mandates = ms.rows.map((x) => toMandate(MandateRow.parse(x)));
      if (mandates.length === 0) return [];
      const ids = sql.join(mandates.map((m) => sql`${m.id}::uuid`));
      const as = await sql<unknown>`select distinct on (mandate_id) ${ATTEMPT_COLS} from auto_buy_attempts
        where mandate_id in (${ids}) order by mandate_id, created_at desc, id desc`.execute(trx);
      const latest = new Map(as.rows.map((x) => toAttempt(AttemptRow.parse(x))).map((a) => [a.mandateId, a] as const));
      return mandates.map((mandate) => ({ mandate, latest: latest.get(mandate.id) ?? null }));
    });
  }

  private async mandates(where: ReturnType<typeof sql>, limit: number): Promise<readonly MandateRecord[]> {
    return this.reading(async (trx) => {
      const r = await sql<unknown>`select ${MANDATE_COLS} from auto_buy_mandates where ${where} order by id limit ${limit}`.execute(trx);
      return r.rows.map((x) => toMandate(MandateRow.parse(x)));
    });
  }

  private async attempts(where: ReturnType<typeof sql>, limit: number): Promise<readonly AttemptRecord[]> {
    return this.reading(async (trx) => {
      const r = await sql<unknown>`select ${ATTEMPT_COLS} from auto_buy_attempts where ${where}
        order by updated_at, id limit ${limit}`.execute(trx);
      return r.rows.map((x) => toAttempt(AttemptRow.parse(x)));
    });
  }

  armedForSku(skuId: string, price: bigint, limit: number) {
    return this.mandates(sql`status = 'ARMED' and sku_id = ${skuId}::uuid and target_price >= ${price.toString()}::bigint`, limit);
  }
  armedForUser(userId: string, tokenRef: string | null) {
    return this.mandates(sql`status = 'ARMED' and user_id = ${userId}::uuid and (${tokenRef}::text is null or psp_token_ref = ${tokenRef})`, 500);
  }
  armedForUserSku(userId: string, skuId: string) {
    return this.mandates(sql`status = 'ARMED' and user_id = ${userId}::uuid and sku_id = ${skuId}::uuid`, 50);
  }
  expiredMandates(nowMs: number, limit: number) {
    return this.mandates(sql`status = 'ARMED' and expires_at <= ${iso(nowMs)}::timestamptz`, limit);
  }
  dueAttempts(nowMs: number, limit: number) {
    return this.attempts(sql`state = 'NOTIFIED' and mode = 'unattended' and cancel_deadline <= ${iso(nowMs)}::timestamptz`, limit);
  }
  staleNotices(beforeMs: number, limit: number) {
    return this.attempts(sql`state = 'NOTIFIED' and mode = 'unattended' and cancel_deadline <= ${iso(beforeMs)}::timestamptz`, limit);
  }
  stuckTriggered(beforeMs: number, limit: number) {
    return this.attempts(sql`state = 'TRIGGERED' and created_at <= ${iso(beforeMs)}::timestamptz`, limit);
  }
  unresolvedCharges(beforeMs: number, limit: number) {
    return this.attempts(sql`state = 'CHARGING' and charge_started_at <= ${iso(beforeMs)}::timestamptz`, limit);
  }
  manualReview(limit: number) {
    return this.attempts(sql`state = 'MANUAL_REVIEW'`, limit);
  }
  abandonedSca(beforeMs: number, limit: number) {
    return this.attempts(sql`state = 'REQUIRES_USER_ACTION' and updated_at <= ${iso(beforeMs)}::timestamptz`, limit);
  }
}
