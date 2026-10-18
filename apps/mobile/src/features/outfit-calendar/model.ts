/**
 * Outfit calendar (spec P3-02). Dates are Cairo-local `YYYY-MM-DD` strings (the server stores UTC plus the local date).
 * Money is integer piastres (bigint). Delivery feasibility is advice, never a guarantee. Pure model, port, fake.
 */
import { AiFailure, type AiFailureReason } from "../ai-failure";
import { FIXTURE_OUTFITS, SLOTS, type MissingSlot, type Outfit, type Slot } from "../stylist/model";

export const EVENT_KINDS = ["work", "wedding_guest", "date", "eid", "university", "travel", "custom"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const SEASONS = ["summer", "winter", "spring", "autumn", "all"] as const;
export type Season = (typeof SEASONS)[number];

/** Spec: max 100 future events. */
export const MAX_FUTURE_EVENTS = 100;
export const MAX_NOTE = 200;

export type OutfitStatus = "none" | "planned" | "owned_only" | "needs_purchases";
export type LinkStatus = "planned" | "in_bag" | "purchased" | "worn";

export interface CalendarEvent {
  readonly id: string;
  readonly kind: EventKind;
  readonly localDate: string;
  readonly localTime: string;
  readonly note: string | null;
  readonly modest: boolean;
  readonly season: Season;
  /** Piastres, or null for no budget. */
  readonly budget: bigint | null;
  readonly ownedSlots: readonly Slot[];
  readonly remindersEnabled: boolean;
  readonly archived: boolean;
  readonly outfitStatus: OutfitStatus;
  readonly outfits: readonly { readonly outfitId: string; readonly status: LinkStatus }[];
  readonly version: number;
}

export interface EventDraft {
  readonly kind: EventKind;
  readonly localDate: string;
  /** `HH:MM` or null (the server defaults it). */
  readonly localTime: string | null;
  readonly note: string | null;
  readonly modest: boolean;
  readonly season: Season;
  readonly budget: bigint | null;
  readonly remindersEnabled: boolean;
}

export type DeliveryStatus = "ok" | "may_not_arrive" | "unknown";
export interface Delivery {
  readonly status: DeliveryStatus;
  /** Last day to order for the item to arrive >= 2 days before the event (courier p80), or null. */
  readonly orderByDate: string | null;
}

export interface GapOutfit {
  readonly outfit: Outfit;
  readonly complete: boolean;
  readonly total: bigint;
  readonly ownedSlots: readonly Slot[];
  readonly missing: readonly MissingSlot[];
  readonly delivery: Delivery;
}

export interface GapResult {
  readonly outfits: readonly GapOutfit[];
  readonly ownedOnly: boolean;
  readonly shortfall: readonly MissingSlot[];
  readonly source: "ai" | "rules";
  readonly remainingToday: number | null;
}

export interface AddGapResult {
  readonly added: boolean;
  readonly alreadyAdded: boolean;
  readonly unavailable: number;
  readonly priceChanges: number;
  readonly delivery: Delivery | null;
}

export interface CalendarPort {
  list(includeArchived: boolean): Promise<readonly CalendarEvent[]>;
  create(draft: EventDraft): Promise<CalendarEvent>;
  update(id: string, patch: Partial<EventDraft>): Promise<CalendarEvent>;
  remove(id: string): Promise<void>;
  /** Deletes every event (and its outfit links). */
  clear(): Promise<void>;
  generate(eventId: string, useRemainingBudget: boolean): Promise<GapResult>;
  addGap(eventId: string, outfitId: string): Promise<AddGapResult>;
}

/* ---- dates (pure; no Date.now inside) ---- */

const EASTERN = "٠١٢٣٤٥٦٧٨٩";
export function westernDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d)));
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Today's date in Africa/Cairo as `YYYY-MM-DD` (Intl when available, otherwise UTC+2 without DST). */
export function todayCairo(nowMs: number): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
    const s = `${get("year")}-${get("month")}-${get("day")}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch {
    // fall through
  }
  return new Date(nowMs + 2 * 3_600_000).toISOString().slice(0, 10);
}

export function addDays(localDate: string, n: number): string {
  const [y = 0, m = 1, d = 1] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from `fromLocal` to `toLocal` (negative when past). */
export function daysBetween(fromLocal: string, toLocal: string): number {
  const ms = (s: string): number => {
    const [y = 0, m = 1, d = 1] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(toLocal) - ms(fromLocal)) / 86_400_000);
}

export type DateParse = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: "invalid" | "past" };

/** Accepts `YYYY-MM-DD`, `DD/MM/YYYY` and `DD-MM-YYYY` (Western or Eastern digits). Past dates are refused. */
export function parseLocalDate(raw: string, today: string): DateParse {
  const s = westernDigits(raw.trim());
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (iso !== null) {
    y = Number(iso[1]);
    m = Number(iso[2]);
    d = Number(iso[3]);
  } else if (dmy !== null) {
    d = Number(dmy[1]);
    m = Number(dmy[2]);
    y = Number(dmy[3]);
  } else return { ok: false, reason: "invalid" };
  if (!isRealDate(y, m, d)) return { ok: false, reason: "invalid" };
  const value = `${y}-${pad(m)}-${pad(d)}`;
  return value < today ? { ok: false, reason: "past" } : { ok: true, value };
}

export type TimeParse = { readonly ok: true; readonly value: string | null } | { readonly ok: false };
export function parseLocalTime(raw: string): TimeParse {
  const s = westernDigits(raw.trim());
  if (s === "") return { ok: true, value: null };
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m === null) return { ok: false };
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { ok: true, value: `${pad(h)}:${pad(min)}` } : { ok: false };
}

export function quickDates(today: string): readonly { readonly days: number; readonly date: string }[] {
  return [3, 7, 14, 30].map((days) => ({ days, date: addDays(today, days) }));
}

/* ---- draft validation ---- */

export interface DraftInput {
  readonly kind: EventKind;
  readonly date: string;
  readonly time: string;
  readonly note: string;
  readonly modest: boolean;
  readonly season: Season;
  readonly budgetEgp: string;
  readonly remindersEnabled: boolean;
}

export interface DraftErrors {
  readonly date?: "invalid" | "past";
  readonly time?: "invalid";
  readonly budget?: "invalid";
  readonly note?: "long";
}

export type DraftResult = { readonly ok: true; readonly draft: EventDraft } | { readonly ok: false; readonly errors: DraftErrors };

function budgetOf(raw: string): { ok: true; value: bigint | null } | { ok: false } {
  const s = westernDigits(raw.trim());
  if (s === "") return { ok: true, value: null };
  if (!/^[0-9]{1,9}$/.test(s)) return { ok: false };
  const egp = BigInt(s);
  return egp === 0n ? { ok: false } : { ok: true, value: egp * 100n };
}

export function validateDraft(input: DraftInput, today: string): DraftResult {
  const errors: { date?: "invalid" | "past"; time?: "invalid"; budget?: "invalid"; note?: "long" } = {};
  const date = parseLocalDate(input.date, today);
  if (!date.ok) errors.date = date.reason;
  const time = parseLocalTime(input.time);
  if (!time.ok) errors.time = "invalid";
  const budget = budgetOf(input.budgetEgp);
  if (!budget.ok) errors.budget = "invalid";
  const note = input.note.trim();
  if ([...note].length > MAX_NOTE) errors.note = "long";
  if (!date.ok || !time.ok || !budget.ok || errors.note !== undefined) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      kind: input.kind,
      localDate: date.value,
      localTime: time.value,
      note: note === "" ? null : note,
      modest: input.modest,
      season: input.season,
      budget: budget.value,
      remindersEnabled: input.remindersEnabled,
    },
  };
}

/* ---- list logic ---- */

/** Upcoming (today and later, not archived) by date and time, then past / archived most recent first. */
export function splitEvents(events: readonly CalendarEvent[], today: string): { readonly upcoming: readonly CalendarEvent[]; readonly past: readonly CalendarEvent[] } {
  const key = (e: CalendarEvent): string => `${e.localDate} ${e.localTime}`;
  const isUpcoming = (e: CalendarEvent): boolean => !e.archived && e.localDate >= today;
  const upcoming = events.filter(isUpcoming).sort((a, b) => key(a).localeCompare(key(b)));
  const past = events.filter((e) => !isUpcoming(e)).sort((a, b) => key(b).localeCompare(key(a)));
  return { upcoming, past };
}

export function canAddEvent(events: readonly CalendarEvent[], today: string): boolean {
  return events.filter((e) => !e.archived && e.localDate >= today).length < MAX_FUTURE_EVENTS;
}

export type DeliveryNotice =
  | { readonly kind: "estimate" }
  | { readonly kind: "mayNotArrive"; readonly orderBy: string | null }
  | { readonly kind: "unknown" };

/** "may not arrive in time" is shown whenever the server says so; "ok" is only ever an estimate, never a promise. */
export function deliveryNotice(d: Delivery): DeliveryNotice {
  if (d.status === "may_not_arrive") return { kind: "mayNotArrive", orderBy: d.orderByDate };
  if (d.status === "ok") return { kind: "estimate" };
  return { kind: "unknown" };
}

/** The worst notice across outfits (a gap list with one late item is a late list). */
export function worstDelivery(ds: readonly Delivery[]): Delivery {
  const late = ds.find((d) => d.status === "may_not_arrive");
  if (late !== undefined) return late;
  const unknown = ds.find((d) => d.status === "unknown");
  return unknown ?? ds[0] ?? { status: "unknown", orderByDate: null };
}

export function gapTotal(o: Pick<GapOutfit, "outfit">): bigint {
  return o.outfit.items.reduce((s, i) => s + i.unitPrice, 0n);
}

export function isEventKind(s: string): s is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(s);
}
export function isSlot(s: string): s is Slot {
  return (SLOTS as readonly string[]).includes(s);
}

/* ---- in-memory fake (development and tests only; synthetic data) ---- */

export class InMemoryCalendarPort implements CalendarPort {
  private events: CalendarEvent[] = [];
  private n = 0;
  readonly addedGaps: string[] = [];
  constructor(
    private readonly now: () => number = () => Date.now(),
    private failure: AiFailureReason | null = null,
    seed: readonly CalendarEvent[] = [],
  ) {
    this.events = [...seed];
  }
  setFailure(f: AiFailureReason | null): void {
    this.failure = f;
  }
  private check(): void {
    if (this.failure !== null) throw new AiFailure(this.failure);
  }
  async list(includeArchived: boolean): Promise<readonly CalendarEvent[]> {
    this.check();
    return this.events.filter((e) => includeArchived || !e.archived);
  }
  async create(d: EventDraft): Promise<CalendarEvent> {
    this.check();
    this.n += 1;
    const e: CalendarEvent = {
      id: `evt-${this.n}`,
      kind: d.kind,
      localDate: d.localDate,
      localTime: d.localTime ?? "19:00",
      note: d.note,
      modest: d.modest,
      season: d.season,
      budget: d.budget,
      ownedSlots: [],
      remindersEnabled: d.remindersEnabled,
      archived: false,
      outfitStatus: "none",
      outfits: [],
      version: 1,
    };
    this.events.push(e);
    return e;
  }
  async update(id: string, p: Partial<EventDraft>): Promise<CalendarEvent> {
    this.check();
    const cur = this.events.find((e) => e.id === id);
    if (cur === undefined) throw new AiFailure("notFound");
    const next: CalendarEvent = {
      ...cur,
      ...(p.kind !== undefined ? { kind: p.kind } : {}),
      ...(p.localDate !== undefined ? { localDate: p.localDate } : {}),
      ...(p.localTime !== undefined && p.localTime !== null ? { localTime: p.localTime } : {}),
      ...(p.note !== undefined ? { note: p.note } : {}),
      ...(p.modest !== undefined ? { modest: p.modest } : {}),
      ...(p.season !== undefined ? { season: p.season } : {}),
      ...(p.budget !== undefined ? { budget: p.budget } : {}),
      ...(p.remindersEnabled !== undefined ? { remindersEnabled: p.remindersEnabled } : {}),
      version: cur.version + 1,
    };
    this.events = this.events.map((e) => (e.id === id ? next : e));
    return next;
  }
  async remove(id: string): Promise<void> {
    this.check();
    if (!this.events.some((e) => e.id === id)) throw new AiFailure("notFound");
    this.events = this.events.filter((e) => e.id !== id);
  }
  async clear(): Promise<void> {
    this.check();
    this.events = [];
  }
  async generate(eventId: string, _useRemainingBudget = false): Promise<GapResult> {
    this.check();
    const e = this.events.find((x) => x.id === eventId);
    if (e === undefined) throw new AiFailure("notFound");
    const days = daysBetween(todayCairo(this.now()), e.localDate);
    const delivery: Delivery = days >= 4 ? { status: "ok", orderByDate: null } : { status: "may_not_arrive", orderByDate: addDays(e.localDate, -4) };
    const outfits: GapOutfit[] = FIXTURE_OUTFITS.map((outfit) => ({
      outfit,
      complete: outfit.missing.length === 0,
      total: outfit.items.reduce((s, i) => s + i.unitPrice, 0n),
      ownedSlots: [],
      missing: outfit.missing,
      delivery,
    }));
    return { outfits, ownedOnly: false, shortfall: [], source: "ai", remainingToday: 29 };
  }
  async addGap(eventId: string, outfitId: string): Promise<AddGapResult> {
    this.check();
    if (!this.events.some((e) => e.id === eventId)) throw new AiFailure("notFound");
    const first = this.addedGaps.includes(outfitId);
    this.addedGaps.push(outfitId);
    return { added: !first, alreadyAdded: first, unavailable: 0, priceChanges: 0, delivery: null };
  }
}
