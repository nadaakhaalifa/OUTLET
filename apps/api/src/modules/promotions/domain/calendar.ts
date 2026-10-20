export const CALENDAR_KINDS = ["mega_event", "promotion_window", "drop_window", "release_freeze"] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export const CALENDAR_STATUSES = ["planned", "cancelled"] as const;
export type CalendarStatus = (typeof CALENDAR_STATUSES)[number];

/** A planning record. It never changes a price or starts a promotion. */
export interface CalendarEvent {
  readonly id: string;
  readonly kind: CalendarKind;
  readonly titleAr: string;
  readonly titleEn: string | null;
  readonly note: string | null;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly status: CalendarStatus;
  readonly version: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface CalendarAuditEntry {
  readonly id: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly action: "created" | "updated" | "cancelled";
  readonly before: CalendarEvent | null;
  readonly after: CalendarEvent;
  readonly atMs: number;
}

export interface CalendarPos {
  readonly ms: number;
  readonly id: string;
}

export interface CalendarListQuery {
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly after: CalendarPos | null;
  readonly limit: number;
}

/** Atomic: the event row and its audit row commit together or not at all. */
export interface CalendarStore {
  list(q: CalendarListQuery): Promise<readonly CalendarEvent[]>;
  get(id: string): Promise<CalendarEvent | null>;
  /** `expectedVersion` null = create (fails with `exists` if the id is taken). */
  save(event: CalendarEvent, expectedVersion: number | null, audit: CalendarAuditEntry): Promise<"ok" | "conflict" | "exists">;
  auditFor(eventId: string): Promise<readonly CalendarAuditEntry[]>;
}
