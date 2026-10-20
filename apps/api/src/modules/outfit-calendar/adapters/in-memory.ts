import type { OutfitLinkStatus, ReminderPlan } from "../domain/bridge";
import type {
  CalendarEvent,
  CalendarEventOut,
  CalendarStore,
  ClaimedReminder,
  DeliveryEtaPort,
  ListQuery,
  NotifyResult,
  OutfitLink,
  ReminderNotifierPort,
  ReminderRow,
  SkipReason,
} from "../domain/ports";

interface ReminderRec {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly offsetDays: number;
  dueAtMs: number;
  state: ReminderRow["state"];
  attempts: number;
  claimedAtMs: number | null;
  sentAtMs: number | null;
  skipReason: SkipReason | null;
}

export class InMemoryCalendarStore implements CalendarStore {
  readonly events: CalendarEventOut[] = [];
  private readonly rows = new Map<string, CalendarEvent>();
  private links: OutfitLink[] = [];
  private reminders: ReminderRec[] = [];

  async countFuture(userId: string, nowMs: number): Promise<number> {
    return [...this.rows.values()].filter((e) => e.userId === userId && e.status === "active" && e.startsAtMs > nowMs).length;
  }

  async insertEvent(event: CalendarEvent, reminders: readonly (ReminderPlan & { readonly id: string })[], events: readonly CalendarEventOut[]): Promise<void> {
    if (this.rows.has(event.id)) throw new Error("duplicate event");
    this.rows.set(event.id, event);
    this.addReminders(event, reminders);
    this.events.push(...events);
  }

  private addReminders(event: CalendarEvent, plan: readonly (ReminderPlan & { readonly id: string })[]): void {
    for (const p of plan) {
      if (this.reminders.some((r) => r.eventId === event.id && r.dueAtMs === p.dueAtMs)) continue; // unique (event, due_at)
      this.reminders.push({
        id: p.id,
        eventId: event.id,
        userId: event.userId,
        offsetDays: p.offsetDays,
        dueAtMs: p.dueAtMs,
        state: "pending",
        attempts: 0,
        claimedAtMs: null,
        sentAtMs: null,
        skipReason: null,
      });
    }
  }

  async getEvent(id: string): Promise<CalendarEvent | null> {
    return this.rows.get(id) ?? null;
  }

  async list(q: ListQuery): Promise<readonly CalendarEvent[]> {
    return [...this.rows.values()]
      .filter((e) => e.userId === q.userId)
      .filter((e) => (q.includeArchived ? true : e.status === "active"))
      .filter((e) => e.startsAtMs >= q.fromMs)
      .sort((a, b) => a.startsAtMs - b.startsAtMs || (a.id < b.id ? -1 : 1))
      .filter((e) => q.after === null || e.startsAtMs > q.after.startsAtMs || (e.startsAtMs === q.after.startsAtMs && e.id > q.after.id))
      .slice(0, q.limit);
  }

  async updateEvent(event: CalendarEvent, reminders: readonly (ReminderPlan & { readonly id: string })[] | null): Promise<"updated" | "not_found"> {
    const cur = this.rows.get(event.id);
    if (cur === undefined || cur.userId !== event.userId) return "not_found";
    this.rows.set(event.id, event);
    if (reminders !== null) {
      this.reminders = this.reminders.filter((r) => !(r.eventId === event.id && (r.state === "pending" || r.state === "sending")));
      this.addReminders(event, reminders);
    }
    return "updated";
  }

  async deleteEvent(id: string, userId: string): Promise<boolean> {
    const e = this.rows.get(id);
    if (e === undefined || e.userId !== userId) return false;
    this.drop(id);
    return true;
  }

  private drop(id: string): void {
    this.rows.delete(id);
    this.links = this.links.filter((l) => l.eventId !== id);
    this.reminders = this.reminders.filter((r) => r.eventId !== id);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const ids = [...this.rows.values()].filter((e) => e.userId === userId).map((e) => e.id);
    for (const id of ids) this.drop(id);
    return ids.length;
  }

  async linksFor(eventIds: readonly string[]): Promise<ReadonlyMap<string, readonly OutfitLink[]>> {
    const out = new Map<string, OutfitLink[]>();
    for (const l of this.links) {
      if (!eventIds.includes(l.eventId)) continue;
      out.set(l.eventId, [...(out.get(l.eventId) ?? []), l]);
    }
    for (const v of out.values()) v.sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
    return out;
  }

  async replacePlannedLinks(
    eventId: string,
    userId: string,
    links: readonly { readonly id: string; readonly outfitId: string }[],
    atMs: number,
    events: readonly CalendarEventOut[],
  ): Promise<void> {
    this.links = this.links.filter((l) => !(l.eventId === eventId && l.status === "planned"));
    for (const l of links) {
      this.links.push({ id: l.id, eventId, userId, outfitId: l.outfitId, status: "planned", createdAtMs: atMs, updatedAtMs: atMs });
    }
    this.events.push(...events);
  }

  async transitionLink(eventId: string, outfitId: string, from: OutfitLinkStatus, to: OutfitLinkStatus, atMs: number, events: readonly CalendarEventOut[]): Promise<boolean> {
    const i = this.links.findIndex((l) => l.eventId === eventId && l.outfitId === outfitId && l.status === from);
    const cur = this.links[i];
    if (cur === undefined) return false;
    this.links[i] = { ...cur, status: to, updatedAtMs: atMs };
    this.events.push(...events);
    return true;
  }

  async remindersFor(eventId: string): Promise<readonly ReminderRow[]> {
    return this.reminders.filter((r) => r.eventId === eventId).sort((a, b) => a.dueAtMs - b.dueAtMs).map((r) => ({ ...r }));
  }

  async claimDueReminders(nowMs: number, limit: number, leaseMs: number): Promise<readonly ClaimedReminder[]> {
    const out: ClaimedReminder[] = [];
    for (const r of [...this.reminders].sort((a, b) => a.dueAtMs - b.dueAtMs)) {
      if (out.length >= limit) break;
      const stale = r.state === "sending" && r.claimedAtMs !== null && r.claimedAtMs < nowMs - leaseMs;
      if (!((r.state === "pending" && r.dueAtMs <= nowMs) || stale)) continue;
      const e = this.rows.get(r.eventId);
      if (e === undefined) continue;
      r.state = "sending";
      r.claimedAtMs = nowMs;
      out.push({
        id: r.id,
        eventId: r.eventId,
        userId: r.userId,
        offsetDays: r.offsetDays,
        dueAtMs: r.dueAtMs,
        state: "sending",
        attempts: r.attempts,
        startsAtMs: e.startsAtMs,
        eventStatus: e.status,
        remindersEnabled: e.remindersEnabled,
      });
    }
    return out;
  }

  async rescheduleReminder(id: string, dueAtMs: number): Promise<boolean> {
    const r = this.reminders.find((x) => x.id === id);
    if (r === undefined) return false;
    if (this.reminders.some((x) => x.id !== id && x.eventId === r.eventId && x.dueAtMs === dueAtMs)) return false;
    r.dueAtMs = dueAtMs;
    r.state = "pending";
    r.claimedAtMs = null;
    return true;
  }

  async finishReminder(id: string, state: "sent" | "skipped" | "failed", reason: SkipReason | null, atMs: number, events: readonly CalendarEventOut[]): Promise<void> {
    const r = this.reminders.find((x) => x.id === id);
    if (r === undefined) return;
    r.state = state;
    r.skipReason = reason;
    if (state === "sent") r.sentAtMs = atMs;
    this.events.push(...events);
  }

  async retryReminder(id: string, dueAtMs: number, attempts: number): Promise<void> {
    const r = this.reminders.find((x) => x.id === id);
    if (r === undefined) return;
    const clash = this.reminders.some((x) => x.id !== id && x.eventId === r.eventId && x.dueAtMs === dueAtMs);
    if (!clash) r.dueAtMs = dueAtMs;
    r.attempts = attempts;
    r.state = "pending";
    r.claimedAtMs = null;
  }

  async sentTimesSince(userId: string, sinceMs: number): Promise<readonly number[]> {
    return this.reminders.filter((r) => r.userId === userId && r.state === "sent" && r.sentAtMs !== null && r.sentAtMs >= sinceMs).map((r) => r.sentAtMs ?? 0);
  }

  async archivePast(nowMs: number): Promise<number> {
    let n = 0;
    for (const [id, e] of this.rows) {
      if (e.status === "active" && e.startsAtMs <= nowMs) {
        this.rows.set(id, { ...e, status: "archived" });
        n += 1;
      }
    }
    return n;
  }
}

/** Static p80 days per store; unknown stores answer null. */
export class StaticEta implements DeliveryEtaPort {
  readonly days = new Map<string, number | null>();
  down = false;
  async p80Days(_userId: string, storeIds: readonly string[]): Promise<ReadonlyMap<string, number | null>> {
    if (this.down) throw new Error("eta down");
    return new Map(storeIds.map((s) => [s, this.days.get(s) ?? null]));
  }
}

/** No courier data configured: everything is unknown, never a promise. */
export class UnknownEta implements DeliveryEtaPort {
  async p80Days(_userId: string, storeIds: readonly string[]): Promise<ReadonlyMap<string, number | null>> {
    return new Map(storeIds.map((s) => [s, null]));
  }
}

export class FakeNotifier implements ReminderNotifierPort {
  readonly sent: { userId: string; eventId: string; dueAtMs: number; offsetDays: number }[] = [];
  next: NotifyResult = "sent";
  throws = false;
  async send(input: { userId: string; eventId: string; dueAtMs: number; offsetDays: number }): Promise<NotifyResult> {
    if (this.throws) throw new Error("notifier down");
    if (this.next === "sent") this.sent.push(input);
    return this.next;
  }
}
