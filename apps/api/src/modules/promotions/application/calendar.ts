import type { CalendarAuditEntry, CalendarEvent, CalendarKind, CalendarListQuery, CalendarStatus, CalendarStore } from "../domain/calendar";
import type { Clock, IdGenerator } from "./promotions";

export interface SaveCalendarInput {
  readonly actorId: string;
  readonly id: string;
  readonly kind: CalendarKind;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly note: string | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly status: CalendarStatus;
  readonly expectedVersion: number | null;
}

export type SaveCalendarResult =
  | { readonly kind: "ok"; readonly event: CalendarEvent; readonly created: boolean }
  | { readonly kind: "invalid_range" }
  | { readonly kind: "conflict" };

export class SaveCalendarEvent {
  constructor(private readonly store: CalendarStore, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async execute(i: SaveCalendarInput): Promise<SaveCalendarResult> {
    if (i.endsAtMs <= i.startsAtMs) return { kind: "invalid_range" };
    const now = this.clock.nowMs();
    const cur = await this.store.get(i.id);
    if (cur === null && i.expectedVersion !== null) return { kind: "conflict" };
    if (cur !== null && i.expectedVersion !== cur.version) return { kind: "conflict" };
    const next: CalendarEvent = {
      id: i.id, kind: i.kind, titleAr: i.titleAr, titleEn: i.titleEn, note: i.note, startsAtMs: i.startsAtMs, endsAtMs: i.endsAtMs, status: i.status,
      version: cur === null ? 1 : cur.version + 1,
      createdBy: cur?.createdBy ?? i.actorId, updatedBy: i.actorId, createdAtMs: cur?.createdAtMs ?? now, updatedAtMs: now,
    };
    const audit: CalendarAuditEntry = {
      id: this.ids.uuidV7(), eventId: i.id, actorId: i.actorId,
      action: cur === null ? "created" : i.status === "cancelled" && cur.status !== "cancelled" ? "cancelled" : "updated",
      before: cur, after: next, atMs: now,
    };
    const r = await this.store.save(next, cur === null ? null : cur.version, audit);
    if (r !== "ok") return { kind: "conflict" };
    return { kind: "ok", event: next, created: cur === null };
  }
}

export class ListCalendarEvents {
  constructor(private readonly store: CalendarStore) {}
  async execute(q: CalendarListQuery) {
    const rows = await this.store.list({ ...q, limit: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > q.limit && last !== undefined ? { ms: last.startsAtMs, id: last.id } : null };
  }
}
