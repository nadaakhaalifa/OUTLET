import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { EVENT_KINDS, EVENT_SOURCES, MODESTY, OUTFIT_LINK_STATUSES, type OutfitLinkStatus, type ReminderPlan, type Slot } from "../domain/bridge";
import type {
  CalendarEvent,
  CalendarEventOut,
  CalendarStore,
  ClaimedReminder,
  IdPort,
  ListQuery,
  OutfitLink,
  ReminderRow,
  SkipReason,
} from "../domain/ports";

/** Raw SQL with Zod validated rows, as in the stylist and wishlists adapters. */
export type OutfitCalendarDb = Kysely<Record<string, never>>;

const Int = z.string().regex(/^-?\d+$/);
const SLOTS = ["top", "bottom", "dress", "shoes", "bag", "accessory"] as const;

const EventRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(EVENT_KINDS),
  starts_ms: Int,
  local_date: z.string(),
  note: z.string().nullable(),
  modesty: z.enum(MODESTY),
  season_band: z.enum(["summer", "winter", "spring", "autumn", "all"]),
  budget: Int.nullable(),
  owned_slots: z.array(z.enum(SLOTS)),
  source: z.enum(EVENT_SOURCES),
  reminders_enabled: z.boolean(),
  status: z.enum(["active", "archived"]),
  version: z.number().int(),
  created_ms: Int,
  updated_ms: Int,
});

const LinkRow = z.object({
  id: z.string(),
  event_id: z.string(),
  user_id: z.string(),
  outfit_id: z.string(),
  status: z.enum(OUTFIT_LINK_STATUSES),
  created_ms: Int,
  updated_ms: Int,
});

const ReminderRowZ = z.object({
  id: z.string(),
  event_id: z.string(),
  user_id: z.string(),
  offset_days: z.number().int(),
  due_ms: Int,
  state: z.enum(["pending", "sending", "sent", "skipped", "failed"]),
  attempts: z.number().int(),
});
const ClaimedRow = ReminderRowZ.extend({
  starts_ms: Int,
  event_status: z.enum(["active", "archived"]),
  reminders_enabled: z.boolean(),
});

const EPOCH_MS = (col: string) => sql.raw(`floor(extract(epoch from ${col}) * 1000)::text`);
const EVENT_COLS = sql`id::text as id, user_id::text as user_id, kind, ${EPOCH_MS("starts_at")} as starts_ms,
  to_char(local_date, 'YYYY-MM-DD') as local_date, note, modesty, season_band, budget_piastres::text as budget,
  owned_slots, source, reminders_enabled, status, version, ${EPOCH_MS("created_at")} as created_ms,
  ${EPOCH_MS("updated_at")} as updated_ms`;

const toEvent = (raw: unknown): CalendarEvent => {
  const r = EventRow.parse(raw);
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    startsAtMs: Number(r.starts_ms),
    localDate: r.local_date,
    note: r.note,
    modesty: r.modesty,
    seasonBand: r.season_band,
    budgetPiastres: r.budget === null ? null : BigInt(r.budget),
    ownedSlots: r.owned_slots as Slot[],
    source: r.source,
    remindersEnabled: r.reminders_enabled,
    status: r.status,
    version: r.version,
    createdAtMs: Number(r.created_ms),
    updatedAtMs: Number(r.updated_ms),
  };
};

const toLink = (raw: unknown): OutfitLink => {
  const r = LinkRow.parse(raw);
  return {
    id: r.id,
    eventId: r.event_id,
    userId: r.user_id,
    outfitId: r.outfit_id,
    status: r.status,
    createdAtMs: Number(r.created_ms),
    updatedAtMs: Number(r.updated_ms),
  };
};

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

const ts = (ms: number) => sql`to_timestamp(${ms}::double precision / 1000)`;
const slotArray = (s: readonly Slot[]) => sql`${`{${s.join(",")}}`}::text[]`;

export class KyselyOutfitCalendarStore implements CalendarStore {
  constructor(
    private readonly db: OutfitCalendarDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: OutfitCalendarDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as OutfitCalendarDb);
    });
  }

  private async emit(trx: OutfitCalendarDb, events: readonly CalendarEventOut[]): Promise<void> {
    for (const e of events) {
      // Payloads carry ids, enums and counters. Never the note, the budget or item titles.
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'calendar_event', ${e.eventId}::uuid, ${e.type},
                ${`calendar_event:${e.eventId}`}, ${JSON.stringify(e)}::jsonb)`.execute(trx);
    }
  }

  private async insertReminders(trx: OutfitCalendarDb, event: CalendarEvent, plan: readonly (ReminderPlan & { readonly id: string })[]): Promise<void> {
    for (const p of plan) {
      await sql`
        insert into calendar_reminders (id, event_id, user_id, offset_days, due_at)
        values (${p.id}::uuid, ${event.id}::uuid, ${event.userId}::uuid, ${p.offsetDays}, ${ts(p.dueAtMs)})
        on conflict (event_id, due_at) do nothing`.execute(trx);
    }
  }

  async countFuture(userId: string, nowMs: number): Promise<number> {
    return this.tx(async (trx) => {
      const res = await sql`
        select count(*)::text as n from calendar_events
        where user_id = ${userId}::uuid and status = 'active' and starts_at > ${ts(nowMs)}`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? 0 : Number(z.object({ n: z.string() }).parse(row).n);
    });
  }

  async insertEvent(event: CalendarEvent, reminders: readonly (ReminderPlan & { readonly id: string })[], events: readonly CalendarEventOut[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into calendar_events (id, user_id, kind, starts_at, local_date, note, modesty, season_band,
                                     budget_piastres, owned_slots, source, reminders_enabled, status, version,
                                     created_at, updated_at)
        values (${event.id}::uuid, ${event.userId}::uuid, ${event.kind}, ${ts(event.startsAtMs)}, ${event.localDate}::date,
                ${event.note}, ${event.modesty}, ${event.seasonBand},
                ${event.budgetPiastres === null ? null : event.budgetPiastres.toString()}::bigint,
                ${slotArray(event.ownedSlots)}, ${event.source}, ${event.remindersEnabled}, ${event.status}, ${event.version},
                ${ts(event.createdAtMs)}, ${ts(event.updatedAtMs)})`.execute(trx);
      await this.insertReminders(trx, event, reminders);
      await this.emit(trx, events);
    });
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    return this.tx(async (trx) => {
      const res = await sql`select ${EVENT_COLS} from calendar_events where id = ${id}::uuid`.execute(trx);
      const row = res.rows[0];
      return row === undefined ? null : toEvent(row);
    });
  }

  async list(q: ListQuery): Promise<readonly CalendarEvent[]> {
    return this.tx(async (trx) => {
      const after =
        q.after === null
          ? sql`true`
          : sql`(starts_at, id) > (${ts(q.after.startsAtMs)}, ${q.after.id}::uuid)`;
      const status = q.includeArchived ? sql`true` : sql`status = 'active'`;
      const res = await sql`
        select ${EVENT_COLS} from calendar_events
        where user_id = ${q.userId}::uuid and ${status} and starts_at >= ${ts(q.fromMs)} and ${after}
        order by starts_at, id limit ${q.limit}`.execute(trx);
      return res.rows.map(toEvent);
    });
  }

  async updateEvent(event: CalendarEvent, reminders: readonly (ReminderPlan & { readonly id: string })[] | null): Promise<"updated" | "not_found"> {
    return this.tx(async (trx) => {
      const res = await sql`
        update calendar_events set kind = ${event.kind}, starts_at = ${ts(event.startsAtMs)}, local_date = ${event.localDate}::date,
          note = ${event.note}, modesty = ${event.modesty}, season_band = ${event.seasonBand},
          budget_piastres = ${event.budgetPiastres === null ? null : event.budgetPiastres.toString()}::bigint,
          owned_slots = ${slotArray(event.ownedSlots)}, reminders_enabled = ${event.remindersEnabled},
          version = version + 1, updated_at = ${ts(event.updatedAtMs)}
        where id = ${event.id}::uuid and user_id = ${event.userId}::uuid
        returning id`.execute(trx);
      if (res.rows.length === 0) return "not_found";
      if (reminders !== null) {
        await sql`delete from calendar_reminders where event_id = ${event.id}::uuid and state in ('pending', 'sending')`.execute(trx);
        await this.insertReminders(trx, event, reminders);
      }
      return "updated";
    });
  }

  async deleteEvent(id: string, userId: string): Promise<boolean> {
    return this.tx(async (trx) => {
      const res = await sql`delete from calendar_events where id = ${id}::uuid and user_id = ${userId}::uuid returning id`.execute(trx);
      return res.rows.length > 0;
    });
  }

  async deleteAllForUser(userId: string): Promise<number> {
    return this.tx(async (trx) => {
      const res = await sql`delete from calendar_events where user_id = ${userId}::uuid returning id`.execute(trx);
      return res.rows.length;
    });
  }

  async linksFor(eventIds: readonly string[]): Promise<ReadonlyMap<string, readonly OutfitLink[]>> {
    const out = new Map<string, OutfitLink[]>();
    if (eventIds.length === 0) return out;
    return this.tx(async (trx) => {
      const res = await sql`
        select id::text as id, event_id::text as event_id, user_id::text as user_id, outfit_id::text as outfit_id, status,
               ${EPOCH_MS("created_at")} as created_ms, ${EPOCH_MS("updated_at")} as updated_ms
        from calendar_outfits where event_id = any(${eventIds}::uuid[]) order by created_at, id`.execute(trx);
      for (const raw of res.rows) {
        const l = toLink(raw);
        out.set(l.eventId, [...(out.get(l.eventId) ?? []), l]);
      }
      return out;
    });
  }

  async replacePlannedLinks(
    eventId: string,
    userId: string,
    links: readonly { readonly id: string; readonly outfitId: string }[],
    atMs: number,
    events: readonly CalendarEventOut[],
  ): Promise<void> {
    await this.tx(async (trx) => {
      await sql`delete from calendar_outfits where event_id = ${eventId}::uuid and user_id = ${userId}::uuid and status = 'planned'`.execute(trx);
      for (const l of links) {
        await sql`
          insert into calendar_outfits (id, event_id, user_id, outfit_id, status, created_at, updated_at)
          values (${l.id}::uuid, ${eventId}::uuid, ${userId}::uuid, ${l.outfitId}::uuid, 'planned', ${ts(atMs)}, ${ts(atMs)})`.execute(trx);
      }
      await this.emit(trx, events);
    });
  }

  async transitionLink(eventId: string, outfitId: string, from: OutfitLinkStatus, to: OutfitLinkStatus, atMs: number, events: readonly CalendarEventOut[]): Promise<boolean> {
    return this.tx(async (trx) => {
      // The conditional UPDATE is the compare-and-set: only one concurrent caller sees a row.
      const res = await sql`
        update calendar_outfits set status = ${to}, updated_at = ${ts(atMs)}
        where event_id = ${eventId}::uuid and outfit_id = ${outfitId}::uuid and status = ${from}
        returning id`.execute(trx);
      if (res.rows.length === 0) return false;
      await this.emit(trx, events);
      return true;
    });
  }

  async remindersFor(eventId: string): Promise<readonly ReminderRow[]> {
    return this.tx(async (trx) => {
      const res = await sql`
        select id::text as id, event_id::text as event_id, user_id::text as user_id, offset_days, ${EPOCH_MS("due_at")} as due_ms, state, attempts
        from calendar_reminders where event_id = ${eventId}::uuid order by due_at, id`.execute(trx);
      return res.rows.map((raw) => {
        const r = ReminderRowZ.parse(raw);
        return { id: r.id, eventId: r.event_id, userId: r.user_id, offsetDays: r.offset_days, dueAtMs: Number(r.due_ms), state: r.state, attempts: r.attempts };
      });
    });
  }

  async claimDueReminders(nowMs: number, limit: number, leaseMs: number): Promise<readonly ClaimedReminder[]> {
    return this.tx(async (trx) => {
      const res = await sql`
        with picked as (
          select id from calendar_reminders
          where (state = 'pending' and due_at <= ${ts(nowMs)})
             or (state = 'sending' and claimed_at < ${ts(nowMs - leaseMs)})
          order by due_at, id limit ${limit} for update skip locked),
        upd as (
          update calendar_reminders r set state = 'sending', claimed_at = ${ts(nowMs)}
          from picked where r.id = picked.id returning r.*)
        select upd.id::text as id, upd.event_id::text as event_id, upd.user_id::text as user_id, upd.offset_days,
               floor(extract(epoch from upd.due_at) * 1000)::text as due_ms, upd.state, upd.attempts,
               floor(extract(epoch from e.starts_at) * 1000)::text as starts_ms, e.status as event_status,
               e.reminders_enabled
        from upd join calendar_events e on e.id = upd.event_id order by upd.due_at, upd.id`.execute(trx);
      return res.rows.map((raw): ClaimedReminder => {
        const r = ClaimedRow.parse(raw);
        return {
          id: r.id,
          eventId: r.event_id,
          userId: r.user_id,
          offsetDays: r.offset_days,
          dueAtMs: Number(r.due_ms),
          state: r.state,
          attempts: r.attempts,
          startsAtMs: Number(r.starts_ms),
          eventStatus: r.event_status,
          remindersEnabled: r.reminders_enabled,
        };
      });
    });
  }

  async rescheduleReminder(id: string, dueAtMs: number): Promise<boolean> {
    try {
      return await this.tx(async (trx) => {
        const res = await sql`
          update calendar_reminders set due_at = ${ts(dueAtMs)}, state = 'pending', claimed_at = null
          where id = ${id}::uuid returning id`.execute(trx);
        return res.rows.length > 0;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  }

  async finishReminder(id: string, state: "sent" | "skipped" | "failed", reason: SkipReason | null, atMs: number, events: readonly CalendarEventOut[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        update calendar_reminders set state = ${state}, skip_reason = ${reason}, claimed_at = null,
          sent_at = ${state === "sent" ? ts(atMs) : null}
        where id = ${id}::uuid`.execute(trx);
      await this.emit(trx, events);
    });
  }

  async retryReminder(id: string, dueAtMs: number, attempts: number): Promise<void> {
    try {
      await this.tx(async (trx) => {
        await sql`
          update calendar_reminders set state = 'pending', claimed_at = null, attempts = ${attempts}, due_at = ${ts(dueAtMs)}
          where id = ${id}::uuid`.execute(trx);
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await this.tx(async (trx) => {
        await sql`update calendar_reminders set state = 'pending', claimed_at = null, attempts = ${attempts} where id = ${id}::uuid`.execute(trx);
      });
    }
  }

  async sentTimesSince(userId: string, sinceMs: number): Promise<readonly number[]> {
    return this.tx(async (trx) => {
      const res = await sql`
        select ${EPOCH_MS("sent_at")} as ms from calendar_reminders
        where user_id = ${userId}::uuid and state = 'sent' and sent_at >= ${ts(sinceMs)} order by sent_at`.execute(trx);
      return res.rows.map((raw) => Number(z.object({ ms: Int }).parse(raw).ms));
    });
  }

  async archivePast(nowMs: number): Promise<number> {
    return this.tx(async (trx) => {
      const res = await sql`
        update calendar_events set status = 'archived', updated_at = ${ts(nowMs)}
        where status = 'active' and starts_at <= ${ts(nowMs)} returning id`.execute(trx);
      return res.rows.length;
    });
  }
}
