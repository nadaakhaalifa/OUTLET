import { addDaysToDateKey, cairoLocalToUtc, cairoParts } from "./cairo";

export interface QuietHours {
  /** Minutes after local midnight (Africa/Cairo). The window wraps midnight when from > to. */
  readonly fromMin: number;
  readonly toMin: number;
}
/** 23:00 to 09:00 Africa/Cairo (spec 24). */
export const QUIET_HOURS: QuietHours = { fromMin: 23 * 60, toMin: 9 * 60 };

/** Reminders 7 days (order lead time) and 1 day before (spec P3-02 Flow). */
export const REMINDER_OFFSETS_DAYS: readonly number[] = [7, 1];

export interface ReminderCaps {
  readonly perDay: number;
  readonly perWeek: number;
}
/** Calendar reminders are service messages; the cap is a guardrail against a crowded calendar. */
export const REMINDER_CAPS: ReminderCaps = { perDay: 2, perWeek: 6 };

export function inQuietHours(utcMs: number, q: QuietHours = QUIET_HOURS): boolean {
  const mod = cairoParts(utcMs).minuteOfDay;
  return q.fromMin > q.toMin ? mod >= q.fromMin || mod < q.toMin : mod >= q.fromMin && mod < q.toMin;
}

/** The first instant at or after `utcMs` that is outside quiet hours (09:00 Cairo when inside). */
export function deferOutOfQuietHours(utcMs: number, q: QuietHours = QUIET_HOURS): number {
  if (!inQuietHours(utcMs, q)) return utcMs;
  const p = cairoParts(utcMs);
  const sameDay = cairoLocalToUtc(p.dateKey, q.toMin);
  if (sameDay > utcMs) return sameDay;
  return cairoLocalToUtc(addDaysToDateKey(p.dateKey, 1), q.toMin);
}

export interface ReminderPlan {
  readonly offsetDays: number;
  readonly dueAtMs: number;
}

/**
 * Due times for an event: one per offset, at the event's local time N Cairo days earlier (DST safe),
 * moved out of quiet hours, dropped when already past or not before the event itself.
 */
export function planReminders(input: {
  readonly startsAtMs: number;
  readonly nowMs: number;
  readonly offsetsDays?: readonly number[];
  readonly quiet?: QuietHours;
}): readonly ReminderPlan[] {
  const p = cairoParts(input.startsAtMs);
  const out: ReminderPlan[] = [];
  const seen = new Set<number>();
  for (const n of input.offsetsDays ?? REMINDER_OFFSETS_DAYS) {
    const raw = cairoLocalToUtc(addDaysToDateKey(p.dateKey, -n), p.minuteOfDay);
    const due = deferOutOfQuietHours(raw, input.quiet ?? QUIET_HOURS);
    if (due <= input.nowMs || due >= input.startsAtMs || seen.has(due)) continue;
    seen.add(due);
    out.push({ offsetDays: n, dueAtMs: due });
  }
  return out.sort((a, b) => a.dueAtMs - b.dueAtMs);
}

export type CapDecision = { readonly kind: "send" } | { readonly kind: "defer"; readonly untilMs: number };

/**
 * Frequency cap over the Cairo day and the trailing 7 Cairo days. Over the cap the reminder moves to
 * 09:00 the next Cairo day, where it is evaluated again.
 */
export function capDecision(sentAtMs: readonly number[], nowMs: number, caps: ReminderCaps = REMINDER_CAPS): CapDecision {
  const today = cairoParts(nowMs).dateKey;
  const weekKeys = new Set<string>();
  for (let i = 0; i < 7; i += 1) weekKeys.add(addDaysToDateKey(today, -i));
  let day = 0;
  let week = 0;
  for (const t of sentAtMs) {
    const k = cairoParts(t).dateKey;
    if (k === today) day += 1;
    if (weekKeys.has(k)) week += 1;
  }
  if (day >= caps.perDay || week >= caps.perWeek) {
    return { kind: "defer", untilMs: cairoLocalToUtc(addDaysToDateKey(today, 1), QUIET_HOURS.toMin) };
  }
  return { kind: "send" };
}
