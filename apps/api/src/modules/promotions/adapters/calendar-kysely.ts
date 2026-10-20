import { sql } from "kysely";
import { z } from "zod";
import { CALENDAR_KINDS, CALENDAR_STATUSES, type CalendarAuditEntry, type CalendarEvent, type CalendarListQuery, type CalendarStore } from "../domain/calendar";
import type { PromotionDb } from "./kysely-store";

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Row = z.object({
  id: z.string(),
  kind: z.enum(CALENDAR_KINDS),
  title_ar: z.string(),
  title_en: z.string().nullable(),
  note: z.string().nullable(),
  starts_ms: Ms,
  ends_ms: Ms,
  status: z.enum(CALENDAR_STATUSES),
  version: z.number().int(),
  created_by: z.string(),
  updated_by: z.string(),
  created_ms: Ms,
  updated_ms: Ms,
});
const COLS = sql`id::text as id, kind, title_ar, title_en, note,
  floor(extract(epoch from starts_at) * 1000)::text as starts_ms, floor(extract(epoch from ends_at) * 1000)::text as ends_ms,
  status, version::int as version, created_by::text as created_by, updated_by::text as updated_by,
  floor(extract(epoch from created_at) * 1000)::text as created_ms, floor(extract(epoch from updated_at) * 1000)::text as updated_ms`;
const ts = (ms: number) => sql`${new Date(ms).toISOString()}::timestamptz`;
const toEvent = (raw: unknown): CalendarEvent => {
  const r = Row.parse(raw);
  return {
    id: r.id, kind: r.kind, titleAr: r.title_ar, titleEn: r.title_en, note: r.note, startsAtMs: r.starts_ms, endsAtMs: r.ends_ms,
    status: r.status, version: r.version, createdBy: r.created_by, updatedBy: r.updated_by, createdAtMs: r.created_ms, updatedAtMs: r.updated_ms,
  };
};
const json = (e: CalendarEvent | null): string | null => (e === null ? null : JSON.stringify(e));

export class KyselyCalendarStore implements CalendarStore {
  constructor(private readonly db: PromotionDb) {}

  private tx<T>(run: (t: PromotionDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as PromotionDb);
    });
  }

  async list(q: CalendarListQuery) {
    return this.tx(async (t) => {
      const from = q.fromMs === null ? sql`true` : sql`ends_at >= ${ts(q.fromMs)}`;
      const to = q.toMs === null ? sql`true` : sql`starts_at <= ${ts(q.toMs)}`;
      const after = q.after === null ? sql`true` : sql`(starts_at, id) < (${ts(q.after.ms)}, ${q.after.id}::uuid)`;
      const r = await sql<unknown>`select ${COLS} from admin_calendar_events where ${from} and ${to} and ${after}
        order by starts_at desc, id desc limit ${q.limit}`.execute(t);
      return r.rows.map(toEvent);
    });
  }

  async get(id: string) {
    return this.tx(async (t) => {
      const r = await sql<unknown>`select ${COLS} from admin_calendar_events where id = ${id}::uuid`.execute(t);
      return r.rows[0] === undefined ? null : toEvent(r.rows[0]);
    });
  }

  async save(e: CalendarEvent, expectedVersion: number | null, audit: CalendarAuditEntry) {
    return this.tx(async (t) => {
      if (expectedVersion === null) {
        const ins = await sql`insert into admin_calendar_events (id, kind, title_ar, title_en, note, starts_at, ends_at, status, version, created_by, updated_by, created_at, updated_at)
          values (${e.id}::uuid, ${e.kind}, ${e.titleAr}, ${e.titleEn}, ${e.note}, ${ts(e.startsAtMs)}, ${ts(e.endsAtMs)}, ${e.status}, ${e.version},
                  ${e.createdBy}::uuid, ${e.updatedBy}::uuid, ${ts(e.createdAtMs)}, ${ts(e.updatedAtMs)})
          on conflict (id) do nothing returning id`.execute(t);
        if (ins.rows.length === 0) return "exists" as const;
      } else {
        const upd = await sql`update admin_calendar_events set kind = ${e.kind}, title_ar = ${e.titleAr}, title_en = ${e.titleEn}, note = ${e.note},
          starts_at = ${ts(e.startsAtMs)}, ends_at = ${ts(e.endsAtMs)}, status = ${e.status}, version = ${e.version}, updated_by = ${e.updatedBy}::uuid,
          updated_at = ${ts(e.updatedAtMs)} where id = ${e.id}::uuid and version = ${expectedVersion} returning id`.execute(t);
        if (upd.rows.length === 0) return "conflict" as const;
      }
      await sql`insert into admin_calendar_audit (id, event_id, actor_id, action, before, after, at)
        values (${audit.id}::uuid, ${audit.eventId}::uuid, ${audit.actorId}::uuid, ${audit.action}, ${json(audit.before)}::jsonb, ${json(audit.after)}::jsonb, ${ts(audit.atMs)})`.execute(t);
      return "ok" as const;
    });
  }

  async auditFor(eventId: string) {
    return this.tx(async (t) => {
      const r = await sql<{ id: string; event_id: string; actor_id: string; action: CalendarAuditEntry["action"]; before: CalendarEvent | null; after: CalendarEvent; ms: string }>`
        select id::text as id, event_id::text as event_id, actor_id::text as actor_id, action, before, after,
        floor(extract(epoch from at) * 1000)::text as ms from admin_calendar_audit where event_id = ${eventId}::uuid order by at, id`.execute(t);
      return r.rows.map((x) => ({ id: x.id, eventId: x.event_id, actorId: x.actor_id, action: x.action, before: x.before, after: x.after, atMs: Number(x.ms) }));
    });
  }
}
