import type { EventKind, EventSource, EventStatus, Modesty, OutfitLinkStatus, ReminderPlan, Season, Slot } from "./bridge";

export interface IdPort {
  uuidV7(): string;
}
export interface Clock {
  nowMs(): number;
}

export interface CalendarEvent {
  readonly id: string;
  readonly userId: string;
  readonly kind: EventKind;
  readonly startsAtMs: number;
  /** Cairo-local YYYY-MM-DD of startsAtMs. */
  readonly localDate: string;
  readonly note: string | null;
  readonly modesty: Modesty;
  readonly seasonBand: Season;
  /** Only what the shopper typed for this event. */
  readonly budgetPiastres: bigint | null;
  readonly ownedSlots: readonly Slot[];
  readonly source: EventSource;
  readonly remindersEnabled: boolean;
  readonly status: EventStatus;
  readonly version: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface OutfitLink {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly outfitId: string;
  readonly status: OutfitLinkStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type ReminderState = "pending" | "sending" | "sent" | "skipped" | "failed";
export type SkipReason = "event_past" | "event_changed" | "reminders_off" | "kill_switch" | "duplicate" | "no_recipient" | "rejected";

export interface ReminderRow {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly offsetDays: number;
  readonly dueAtMs: number;
  readonly state: ReminderState;
  readonly attempts: number;
}

/** A claimed reminder with the event fields the sender needs. */
export interface ClaimedReminder extends ReminderRow {
  readonly startsAtMs: number;
  readonly eventStatus: EventStatus;
  readonly remindersEnabled: boolean;
}

/** Domain events written to the outbox in the same transaction as the state change (A2.7). */
export type CalendarEventOut =
  | { readonly type: "calendar.event_created"; readonly eventId: string; readonly userId: string; readonly kind: EventKind; readonly source: EventSource }
  | { readonly type: "calendar.reminder_due"; readonly eventId: string; readonly userId: string; readonly offsetDays: number; readonly dueAtMs: number }
  | { readonly type: "calendar.outfit_planned"; readonly eventId: string; readonly userId: string; readonly count: number }
  | { readonly type: "calendar.gap_added_to_bag"; readonly eventId: string; readonly userId: string; readonly outfitId: string; readonly itemCount: number };

export interface ListQuery {
  readonly userId: string;
  readonly fromMs: number;
  readonly includeArchived: boolean;
  readonly limit: number;
  readonly after: { readonly startsAtMs: number; readonly id: string } | null;
}

export interface CalendarStore {
  countFuture(userId: string, nowMs: number): Promise<number>;
  insertEvent(event: CalendarEvent, reminders: readonly (ReminderPlan & { readonly id: string })[], events: readonly CalendarEventOut[]): Promise<void>;
  getEvent(id: string): Promise<CalendarEvent | null>;
  list(q: ListQuery): Promise<readonly CalendarEvent[]>;
  /**
   * Writes the new event (version + 1) and, when `reminders` is not null, replaces the PENDING
   * reminders with the plan. Reminders already sent or sending are kept.
   */
  updateEvent(
    event: CalendarEvent,
    reminders: readonly (ReminderPlan & { readonly id: string })[] | null,
  ): Promise<"updated" | "not_found">;
  deleteEvent(id: string, userId: string): Promise<boolean>;
  /** "Clear calendar": every event of the user with links and reminders. Returns the count. */
  deleteAllForUser(userId: string): Promise<number>;
  linksFor(eventIds: readonly string[]): Promise<ReadonlyMap<string, readonly OutfitLink[]>>;
  /** Drops this event's links still `planned` and links the new outfits (status planned). */
  replacePlannedLinks(eventId: string, userId: string, links: readonly { readonly id: string; readonly outfitId: string }[], atMs: number, events: readonly CalendarEventOut[]): Promise<void>;
  /** Compare-and-set of a link status. False when the link is not in `from`. */
  transitionLink(eventId: string, outfitId: string, from: OutfitLinkStatus, to: OutfitLinkStatus, atMs: number, events: readonly CalendarEventOut[]): Promise<boolean>;
  remindersFor(eventId: string): Promise<readonly ReminderRow[]>;
  /** SKIP LOCKED in SQL: pending due rows, plus 'sending' rows whose lease expired. */
  claimDueReminders(nowMs: number, limit: number, leaseMs: number): Promise<readonly ClaimedReminder[]>;
  /** False when (event, dueAt) already exists. */
  rescheduleReminder(id: string, dueAtMs: number): Promise<boolean>;
  finishReminder(id: string, state: "sent" | "skipped" | "failed", reason: SkipReason | null, atMs: number, events: readonly CalendarEventOut[]): Promise<void>;
  /** Back to pending after a transient failure. */
  retryReminder(id: string, dueAtMs: number, attempts: number): Promise<void>;
  sentTimesSince(userId: string, sinceMs: number): Promise<readonly number[]>;
  /** Marks started events archived. Returns the count. */
  archivePast(nowMs: number): Promise<number>;
}

/** Courier p80 transit time in days per store, null when unknown. Never a delivery promise. */
export interface DeliveryEtaPort {
  p80Days(userId: string, storeIds: readonly string[]): Promise<ReadonlyMap<string, number | null>>;
}

export type NotifyResult = "sent" | "deduplicated" | "suppressed" | "rejected" | "unavailable";

/** Sends one service message through the notifications module (which owns channels, inbox and logs). */
export interface ReminderNotifierPort {
  send(input: { readonly userId: string; readonly eventId: string; readonly dueAtMs: number; readonly offsetDays: number }): Promise<NotifyResult>;
}
