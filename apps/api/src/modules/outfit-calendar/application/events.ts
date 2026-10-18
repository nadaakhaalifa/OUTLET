import {
  DEFAULT_LOCAL_MINUTE,
  MAX_FUTURE_EVENTS,
  cairoLocalToUtc,
  cairoParts,
  isDateKey,
  ownedSlotsConsistent,
  planReminders,
  type EventKind,
  type EventSource,
  type Modesty,
  type Season,
  type Slot,
} from "../domain/bridge";
import type { CalendarEvent, OutfitLink } from "../domain/ports";
import { isArchived, viewOf, type CalendarDeps, type EventView } from "./shared";

export interface CreateEventInput {
  readonly userId: string;
  readonly kind: EventKind;
  readonly localDate: string;
  /** Minutes after local midnight; the default is noon so a date-only event reminds at a sane hour. */
  readonly localMinute: number | null;
  readonly note: string | null;
  readonly modesty: Modesty;
  readonly seasonBand: Season;
  readonly budgetPiastres: bigint | null;
  readonly ownedSlots: readonly Slot[];
  readonly source: EventSource;
  readonly remindersEnabled: boolean;
}

export type CreateEventOutcome =
  | { readonly kind: "created"; readonly view: EventView }
  | { readonly kind: "invalid_date" }
  | { readonly kind: "event_in_past" }
  | { readonly kind: "owned_slots_invalid" }
  | { readonly kind: "limit_reached"; readonly limit: number };

const dedupe = (s: readonly Slot[]): Slot[] => [...new Set(s)];

/** POST /v1/me/calendar/events. */
export class CreateEvent {
  constructor(private readonly d: CalendarDeps) {}

  async execute(input: CreateEventInput): Promise<CreateEventOutcome> {
    const d = this.d;
    const now = d.clock.nowMs();
    if (!isDateKey(input.localDate)) return { kind: "invalid_date" };
    const minute = input.localMinute ?? DEFAULT_LOCAL_MINUTE;
    const startsAtMs = cairoLocalToUtc(input.localDate, minute);
    // The Cairo date of the resolved instant is the source of truth (a skipped local time shifts forward).
    const local = cairoParts(startsAtMs);
    if (startsAtMs <= now) return { kind: "event_in_past" };
    const owned = dedupe(input.ownedSlots);
    if (!ownedSlotsConsistent(owned)) return { kind: "owned_slots_invalid" };
    if ((await d.store.countFuture(input.userId, now)) >= MAX_FUTURE_EVENTS) return { kind: "limit_reached", limit: MAX_FUTURE_EVENTS };

    const event: CalendarEvent = {
      id: d.ids.uuidV7(),
      userId: input.userId,
      kind: input.kind,
      startsAtMs,
      localDate: local.dateKey,
      note: input.note,
      modesty: input.modesty,
      seasonBand: input.seasonBand,
      budgetPiastres: input.budgetPiastres,
      ownedSlots: owned,
      source: input.source,
      remindersEnabled: input.remindersEnabled,
      status: "active",
      version: 1,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const plan = input.remindersEnabled ? planReminders({ startsAtMs, nowMs: now }) : [];
    await d.store.insertEvent(
      event,
      plan.map((p) => ({ ...p, id: d.ids.uuidV7() })),
      [{ type: "calendar.event_created", eventId: event.id, userId: event.userId, kind: event.kind, source: event.source }],
    );
    return { kind: "created", view: viewOf(event, [], now) };
  }
}

export interface UpdateEventInput {
  readonly userId: string;
  readonly eventId: string;
  readonly kind?: EventKind;
  readonly localDate?: string;
  readonly localMinute?: number;
  readonly note?: string | null;
  readonly modesty?: Modesty;
  readonly seasonBand?: Season;
  readonly budgetPiastres?: bigint | null;
  readonly ownedSlots?: readonly Slot[];
  readonly remindersEnabled?: boolean;
}

export type UpdateEventOutcome =
  | { readonly kind: "updated"; readonly view: EventView }
  | { readonly kind: "not_found" }
  | { readonly kind: "event_archived" }
  | { readonly kind: "invalid_date" }
  | { readonly kind: "event_in_past" }
  | { readonly kind: "owned_slots_invalid" };

/**
 * PATCH /v1/me/calendar/events/{id}. A new date or time, or a change to reminders, re-plans the
 * pending reminders; outfit links and bag items are kept.
 */
export class UpdateEvent {
  constructor(private readonly d: CalendarDeps) {}

  async execute(input: UpdateEventInput): Promise<UpdateEventOutcome> {
    const d = this.d;
    const now = d.clock.nowMs();
    const cur = await d.store.getEvent(input.eventId);
    if (cur === null || cur.userId !== input.userId) return { kind: "not_found" };
    if (isArchived(cur, now)) return { kind: "event_archived" };

    let startsAtMs = cur.startsAtMs;
    let localDate = cur.localDate;
    const timeChanged = input.localDate !== undefined || input.localMinute !== undefined;
    if (timeChanged) {
      const key = input.localDate ?? cur.localDate;
      if (!isDateKey(key)) return { kind: "invalid_date" };
      const minute = input.localMinute ?? cairoParts(cur.startsAtMs).minuteOfDay;
      startsAtMs = cairoLocalToUtc(key, minute);
      if (startsAtMs <= now) return { kind: "event_in_past" };
      localDate = cairoParts(startsAtMs).dateKey;
    }
    const owned = input.ownedSlots === undefined ? cur.ownedSlots : dedupe(input.ownedSlots);
    if (!ownedSlotsConsistent(owned)) return { kind: "owned_slots_invalid" };
    const remindersEnabled = input.remindersEnabled ?? cur.remindersEnabled;

    const next: CalendarEvent = {
      ...cur,
      kind: input.kind ?? cur.kind,
      startsAtMs,
      localDate,
      note: input.note === undefined ? cur.note : input.note,
      modesty: input.modesty ?? cur.modesty,
      seasonBand: input.seasonBand ?? cur.seasonBand,
      budgetPiastres: input.budgetPiastres === undefined ? cur.budgetPiastres : input.budgetPiastres,
      ownedSlots: owned,
      remindersEnabled,
      version: cur.version + 1,
      updatedAtMs: now,
    };
    const replan = timeChanged || remindersEnabled !== cur.remindersEnabled;
    const plan = replan ? (remindersEnabled ? planReminders({ startsAtMs, nowMs: now }) : []) : null;
    const r = await d.store.updateEvent(next, plan === null ? null : plan.map((p) => ({ ...p, id: d.ids.uuidV7() })));
    if (r === "not_found") return { kind: "not_found" };
    const links = (await d.store.linksFor([next.id])).get(next.id) ?? [];
    return { kind: "updated", view: viewOf(next, links, now) };
  }
}

/** DELETE /v1/me/calendar/events/{id}. */
export class DeleteEvent {
  constructor(private readonly d: CalendarDeps) {}
  async execute(input: { readonly userId: string; readonly eventId: string }): Promise<"deleted" | "not_found"> {
    return (await this.d.store.deleteEvent(input.eventId, input.userId)) ? "deleted" : "not_found";
  }
}

/** DELETE /v1/me/calendar/events: the shopper's explicit "clear calendar" (history clear keeps events). */
export class ClearCalendar {
  constructor(private readonly d: CalendarDeps) {}
  async execute(input: { readonly userId: string }): Promise<number> {
    return this.d.store.deleteAllForUser(input.userId);
  }
}

export interface ListEventsInput {
  readonly userId: string;
  readonly includeArchived: boolean;
  readonly limit: number;
  readonly cursor: string | null;
}

export type ListEventsOutcome =
  | { readonly kind: "ok"; readonly items: readonly EventView[]; readonly nextCursor: string | null }
  | { readonly kind: "bad_cursor" };

const CURSOR = /^(\d{1,15}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** GET /v1/me/calendar/events: upcoming first; archived events only on request. */
export class ListEvents {
  constructor(private readonly d: CalendarDeps) {}

  async execute(input: ListEventsInput): Promise<ListEventsOutcome> {
    const now = this.d.clock.nowMs();
    let after: { startsAtMs: number; id: string } | null = null;
    if (input.cursor !== null) {
      const m = CURSOR.exec(input.cursor);
      if (m === null) return { kind: "bad_cursor" };
      after = { startsAtMs: Number(m[1]), id: m[2] ?? "" };
    }
    const rows = await this.d.store.list({
      userId: input.userId,
      fromMs: input.includeArchived ? 0 : now,
      includeArchived: input.includeArchived,
      limit: input.limit + 1,
      after,
    });
    const page = rows.slice(0, input.limit);
    const links = await this.d.store.linksFor(page.map((e) => e.id));
    const last = page[page.length - 1];
    return {
      kind: "ok",
      items: page.map((e) => viewOf(e, links.get(e.id) ?? [], now)),
      nextCursor: rows.length > input.limit && last !== undefined ? `${last.startsAtMs}:${last.id}` : null,
    };
  }
}

export type { OutfitLink };
