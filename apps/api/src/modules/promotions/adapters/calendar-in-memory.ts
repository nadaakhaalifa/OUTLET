import type { CalendarAuditEntry, CalendarEvent, CalendarListQuery, CalendarStore } from "../domain/calendar";

export class InMemoryCalendarStore implements CalendarStore {
  private readonly events = new Map<string, CalendarEvent>();
  private readonly audits: CalendarAuditEntry[] = [];

  async list(q: CalendarListQuery) {
    return [...this.events.values()]
      .filter((e) => (q.fromMs === null || e.endsAtMs >= q.fromMs) && (q.toMs === null || e.startsAtMs <= q.toMs))
      .filter((e) => q.after === null || e.startsAtMs < q.after.ms || (e.startsAtMs === q.after.ms && e.id < q.after.id))
      .sort((a, b) => b.startsAtMs - a.startsAtMs || (a.id < b.id ? 1 : -1))
      .slice(0, q.limit);
  }
  async get(id: string) {
    return this.events.get(id) ?? null;
  }
  async save(event: CalendarEvent, expectedVersion: number | null, audit: CalendarAuditEntry) {
    const cur = this.events.get(event.id);
    if (expectedVersion === null) {
      if (cur !== undefined) return "exists" as const;
    } else if (cur === undefined || cur.version !== expectedVersion) return "conflict" as const;
    this.events.set(event.id, event);
    this.audits.push(audit);
    return "ok" as const;
  }
  async auditFor(eventId: string) {
    return this.audits.filter((a) => a.eventId === eventId);
  }
}
