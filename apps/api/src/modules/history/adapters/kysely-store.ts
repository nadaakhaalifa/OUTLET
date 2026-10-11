import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  HISTORY_EVENT_TYPES,
  forbiddenFeatureKeys,
  type HistoryEvent,
  type HistoryEventType,
  type RecentlyViewed,
  type UserFeatures,
} from "../domain/bridge";
import {
  DEFAULT_SETTINGS,
  type ClearCounts,
  type ClearRequest,
  type EventPosition,
  type HistoryOutboxEvent,
  type HistorySettings,
  type HistoryStore,
  type IdPort,
  type StoredFeatures,
} from "../domain/ports";

export type HistoryDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));

const EventRow = z.object({
  id: z.string(),
  user_id: z.string(),
  type: z.enum(HISTORY_EVENT_TYPES),
  item_id: z.string().nullable(),
  store_id: z.string().nullable(),
  category_id: z.string().nullable(),
  price_minor: Int.nullable(),
  detail: z.string().nullable(),
  at_ms: Ms,
});
const SettingsRow = z.object({ personalization: z.boolean(), history_paused: z.boolean() });
const FeaturesRow = z.object({
  features: z.object({
    categoryAffinity: z.record(z.string(), z.number()),
    storeAffinity: z.record(z.string(), z.number()),
  }),
  model_version: z.string(),
  built_ms: Ms,
});
const RecentRow = z.object({ product_id: z.string(), price_minor: Int.nullable(), viewed_ms: Ms });
const ClearRow = z.object({
  id: z.string(),
  user_id: z.string(),
  requested_ms: Ms,
  deadline_ms: Ms,
  completed_ms: Ms.nullable(),
});
const Count = z.object({ n: Int.transform((s) => Number(s)) });

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const EVENT_COLS = sql`id::text as id, user_id::text as user_id, type, item_id::text as item_id,
  store_id::text as store_id, category_id, price_minor::text as price_minor, detail, ${EPOCH_MS("at")} as at_ms`;
const CLEAR_COLS = sql`id::text as id, user_id::text as user_id, ${EPOCH_MS("requested_at")} as requested_ms,
  ${EPOCH_MS("deadline_at")} as deadline_ms, ${EPOCH_MS("completed_at")} as completed_ms`;

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000.0)`;
const NIL = "00000000-0000-0000-0000-000000000000";

const toEvent = (raw: unknown): HistoryEvent => {
  const r = EventRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    type: r.type,
    itemId: r.item_id,
    storeId: r.store_id,
    categoryId: r.category_id,
    priceMinor: r.price_minor === null ? null : BigInt(r.price_minor),
    detail: r.detail,
    atMs: r.at_ms,
  };
};
const toClear = (raw: unknown): ClearRequest => {
  const r = ClearRow.parse(raw);
  return { id: r.id, userId: r.user_id, requestedAtMs: r.requested_ms, deadlineMs: r.deadline_ms, completedAtMs: r.completed_ms };
};
const count = (rows: readonly unknown[]): number => Count.parse(rows[0]).n;

const aggregateOf = (e: HistoryOutboxEvent): { type: string; id: string } => ({ type: "user", id: e.userId });
const payloadOf = (e: HistoryOutboxEvent): Record<string, unknown> => {
  switch (e.type) {
    case "history.cleared":
      return { user_id: e.userId, request_id: e.requestId, deadline_ms: e.deadlineMs };
    case "history.paused_changed":
      return { user_id: e.userId, paused: e.paused };
    case "personalization.changed":
      return { user_id: e.userId, personalization: e.personalization };
  }
};

export class KyselyHistoryStore implements HistoryStore {
  constructor(
    private readonly db: HistoryDb,
    private readonly ids: IdPort,
  ) {}

  private async emit(trx: HistoryDb, events: readonly HistoryOutboxEvent[]): Promise<void> {
    for (const e of events) {
      const agg = aggregateOf(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, ${agg.type}, ${agg.id}::uuid, ${e.type},
                ${`${agg.type}:${agg.id}`}, ${JSON.stringify(payloadOf(e))}::jsonb)`.execute(trx);
    }
  }

  async appendEvent(e: HistoryEvent): Promise<"recorded" | "duplicate"> {
    const r = await sql<{ id: string }>`
      insert into user_events (id, user_id, type, item_id, store_id, category_id, price_minor, detail, at)
      select ${e.id}::uuid, ${e.userId}::uuid, ${e.type}, ${e.itemId}::uuid, ${e.storeId}::uuid, ${e.categoryId},
             ${e.priceMinor === null ? null : e.priceMinor.toString()}::bigint, ${e.detail}, ${ts(e.atMs)}
      where not exists (select 1 from user_events where id = ${e.id}::uuid)
      returning id::text as id`.execute(this.db);
    return r.rows.length === 1 ? "recorded" : "duplicate";
  }

  async listEvents(userId: string, type: HistoryEventType | null, after: EventPosition | null, limit: number) {
    const r = await sql`
      select ${EVENT_COLS} from user_events
      where user_id = ${userId}::uuid
        and (${type}::text is null or type = ${type})
        and (${after === null}::boolean
             or at < ${after === null ? ts(0) : ts(after.atMs)}
             or (at = ${after === null ? ts(0) : ts(after.atMs)} and id < ${after?.id ?? NIL}::uuid))
      order by at desc, id desc
      limit ${limit}`.execute(this.db);
    return r.rows.map(toEvent);
  }

  async eventsSince(userId: string, sinceMs: number, limit: number) {
    const r = await sql`
      select ${EVENT_COLS} from user_events
      where user_id = ${userId}::uuid and at >= ${ts(sinceMs)}
      order by at desc, id desc limit ${limit}`.execute(this.db);
    return r.rows.map(toEvent);
  }

  async getSettings(userId: string): Promise<HistorySettings> {
    const r = await sql`select personalization, history_paused from personalization_settings
      where user_id = ${userId}::uuid`.execute(this.db);
    const row = r.rows[0];
    if (row === undefined) return DEFAULT_SETTINGS;
    const s = SettingsRow.parse(row);
    return { personalization: s.personalization, historyPaused: s.history_paused };
  }

  private async saveSettings(
    userId: string,
    patch: Partial<HistorySettings>,
    nowMs: number,
    events: readonly HistoryOutboxEvent[],
  ): Promise<HistorySettings> {
    return this.db.transaction().execute(async (trx) => {
      const cur = DEFAULT_SETTINGS;
      const p = patch.personalization ?? null;
      const h = patch.historyPaused ?? null;
      await sql`
        insert into personalization_settings (user_id, personalization, history_paused, updated_at)
        values (${userId}::uuid, coalesce(${p}::boolean, ${cur.personalization}), coalesce(${h}::boolean, ${cur.historyPaused}), ${ts(nowMs)})
        on conflict (user_id) do update set
          personalization = coalesce(${p}::boolean, personalization_settings.personalization),
          history_paused = coalesce(${h}::boolean, personalization_settings.history_paused),
          updated_at = excluded.updated_at`.execute(trx);
      await this.emit(trx, events);
      const r = await sql`select personalization, history_paused from personalization_settings
        where user_id = ${userId}::uuid`.execute(trx);
      const s = SettingsRow.parse(r.rows[0]);
      return { personalization: s.personalization, historyPaused: s.history_paused };
    });
  }

  setPersonalization(userId: string, on: boolean, nowMs: number, events: readonly HistoryOutboxEvent[]) {
    return this.saveSettings(userId, { personalization: on }, nowMs, events);
  }
  setPaused(userId: string, paused: boolean, nowMs: number, events: readonly HistoryOutboxEvent[]) {
    return this.saveSettings(userId, { historyPaused: paused }, nowMs, events);
  }

  async getFeatures(userId: string): Promise<StoredFeatures | null> {
    const r = await sql`select features, model_version, ${EPOCH_MS("built_at")} as built_ms
      from user_features where user_id = ${userId}::uuid`.execute(this.db);
    const row = r.rows[0];
    if (row === undefined) return null;
    const f = FeaturesRow.parse(row);
    const features: UserFeatures = {
      categoryAffinity: f.features.categoryAffinity,
      storeAffinity: f.features.storeAffinity,
      builtAtMs: f.built_ms,
    };
    return { features, modelVersion: f.model_version };
  }

  async putFeatures(userId: string, f: StoredFeatures): Promise<void> {
    if (forbiddenFeatureKeys(f.features).length > 0) throw new Error("user_features must not carry budget or measurement keys");
    const body = { categoryAffinity: f.features.categoryAffinity, storeAffinity: f.features.storeAffinity };
    await sql`
      insert into user_features (user_id, features, model_version, built_at)
      values (${userId}::uuid, ${JSON.stringify(body)}::jsonb, ${f.modelVersion}, ${ts(f.features.builtAtMs)})
      on conflict (user_id) do update set features = excluded.features,
        model_version = excluded.model_version, built_at = excluded.built_at`.execute(this.db);
  }

  async deleteFeatures(userId: string): Promise<boolean> {
    const r = await sql`delete from user_features where user_id = ${userId}::uuid returning 1 as n`.execute(this.db);
    return r.rows.length > 0;
  }

  async upsertRecentlyViewed(userId: string, entry: RecentlyViewed, cap: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`
        insert into recently_viewed (user_id, product_id, price_minor, viewed_at)
        values (${userId}::uuid, ${entry.productId}::uuid,
                ${entry.priceMinor === null ? null : entry.priceMinor.toString()}::bigint, ${ts(entry.viewedAtMs)})
        on conflict (user_id, product_id) do update set price_minor = excluded.price_minor, viewed_at = excluded.viewed_at`.execute(
        trx,
      );
      await sql`
        delete from recently_viewed where user_id = ${userId}::uuid and product_id in (
          select product_id from recently_viewed where user_id = ${userId}::uuid
          order by viewed_at desc, product_id offset ${cap})`.execute(trx);
    });
  }

  async listRecentlyViewed(userId: string, limit: number): Promise<readonly RecentlyViewed[]> {
    const r = await sql`select product_id::text as product_id, price_minor::text as price_minor,
        ${EPOCH_MS("viewed_at")} as viewed_ms
      from recently_viewed where user_id = ${userId}::uuid order by viewed_at desc, product_id limit ${limit}`.execute(this.db);
    return r.rows.map((raw) => {
      const x = RecentRow.parse(raw);
      return { productId: x.product_id, viewedAtMs: x.viewed_ms, priceMinor: x.price_minor === null ? null : BigInt(x.price_minor) };
    });
  }

  async clearAll(input: {
    requestId: string;
    userId: string;
    nowMs: number;
    deadlineMs: number;
    events: readonly HistoryOutboxEvent[];
  }): Promise<{ request: ClearRequest; counts: ClearCounts }> {
    return this.db.transaction().execute(async (trx) => {
      const ev = await sql`with d as (delete from user_events where user_id = ${input.userId}::uuid returning 1)
        select count(*)::text as n from d`.execute(trx);
      const ft = await sql`with d as (delete from user_features where user_id = ${input.userId}::uuid returning 1)
        select count(*)::text as n from d`.execute(trx);
      const rv = await sql`with d as (delete from recently_viewed where user_id = ${input.userId}::uuid returning 1)
        select count(*)::text as n from d`.execute(trx);
      await sql`insert into history_clear_requests (id, user_id, requested_at, deadline_at)
        values (${input.requestId}::uuid, ${input.userId}::uuid, ${ts(input.nowMs)}, ${ts(input.deadlineMs)})`.execute(trx);
      await this.emit(trx, input.events);
      return {
        request: {
          id: input.requestId,
          userId: input.userId,
          requestedAtMs: input.nowMs,
          deadlineMs: input.deadlineMs,
          completedAtMs: null,
        },
        counts: { events: count(ev.rows), features: count(ft.rows), recentlyViewed: count(rv.rows) },
      };
    });
  }

  async pendingClearForUser(userId: string) {
    const r = await sql`select ${CLEAR_COLS} from history_clear_requests
      where user_id = ${userId}::uuid and completed_at is null order by requested_at`.execute(this.db);
    return r.rows.map(toClear);
  }

  async pendingClearRequests(limit: number) {
    const r = await sql`select ${CLEAR_COLS} from history_clear_requests
      where completed_at is null order by deadline_at limit ${limit}`.execute(this.db);
    return r.rows.map(toClear);
  }

  async completeClear(requestId: string, nowMs: number): Promise<ClearCounts | null> {
    return this.db.transaction().execute(async (trx) => {
      const found = await sql`select ${CLEAR_COLS} from history_clear_requests
        where id = ${requestId}::uuid and completed_at is null for update`.execute(trx);
      const row = found.rows[0];
      if (row === undefined) return null;
      const req = toClear(row);
      const at = ts(req.requestedAtMs);
      const ev = await sql`with d as (delete from user_events where user_id = ${req.userId}::uuid and at <= ${at} returning 1)
        select count(*)::text as n from d`.execute(trx);
      const ft = await sql`with d as (delete from user_features where user_id = ${req.userId}::uuid and built_at <= ${at} returning 1)
        select count(*)::text as n from d`.execute(trx);
      const rv = await sql`with d as (delete from recently_viewed where user_id = ${req.userId}::uuid and viewed_at <= ${at} returning 1)
        select count(*)::text as n from d`.execute(trx);
      await sql`update history_clear_requests set completed_at = ${ts(nowMs)} where id = ${requestId}::uuid`.execute(trx);
      return { events: count(ev.rows), features: count(ft.rows), recentlyViewed: count(rv.rows) };
    });
  }

  async purgeEventsBefore(cutoffMs: number, limit: number): Promise<number> {
    const r = await sql`
      with doomed as (
        select id, at from user_events where at < ${ts(cutoffMs)} order by at limit ${limit} for update skip locked
      ), d as (
        delete from user_events u using doomed where u.id = doomed.id and u.at = doomed.at returning 1
      ) select count(*)::text as n from d`.execute(this.db);
    return count(r.rows);
  }

  async usersWithRecentEvents(sinceMs: number, limit: number): Promise<readonly string[]> {
    const r = await sql<{ user_id: string }>`
      select distinct e.user_id::text as user_id
      from user_events e
      left join personalization_settings s on s.user_id = e.user_id
      where e.at >= ${ts(sinceMs)} and coalesce(s.personalization, true)
      order by 1 limit ${limit}`.execute(this.db);
    return r.rows.map((x) => x.user_id);
  }
}
