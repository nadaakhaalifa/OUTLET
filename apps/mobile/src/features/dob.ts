import {
  evaluateOnboardingAge,
  parseCivilDate,
  type CivilDate,
  type DeviceSoftBlock,
  type PrivacyClock,
} from "../workspace";
import { toAsciiDigits } from "./phone";

export interface DobFields {
  readonly day: string;
  readonly month: string;
  readonly year: string;
}

export type DobParse =
  | { readonly ok: true; readonly dob: CivilDate }
  | { readonly ok: false; readonly reason: "incomplete" | "invalid" };

export function parseDobFields(fields: DobFields): DobParse {
  const d = toAsciiDigits(fields.day).trim();
  const m = toAsciiDigits(fields.month).trim();
  const y = toAsciiDigits(fields.year).trim();
  if (d === "" || m === "" || y === "") return { ok: false, reason: "incomplete" };
  if (!/^\d{1,2}$/.test(d) || !/^\d{1,2}$/.test(m) || !/^\d{4}$/.test(y)) return { ok: false, reason: "invalid" };
  try {
    return { ok: true, dob: parseCivilDate({ year: Number(y), month: Number(m), day: Number(d) }) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export type AgeGateOutcome =
  | { readonly kind: "invalid_date" }
  | { readonly kind: "needs_attestation" }
  | { readonly kind: "accepted"; readonly limitedCapacity: boolean; readonly dob: CivilDate }
  | { readonly kind: "blocked_under_18"; readonly block: DeviceSoftBlock }
  | { readonly kind: "blocked_device" };

export interface AgeGateDeps {
  readonly hasher: (input: string) => string;
  readonly clock: PrivacyClock;
}

/**
 * The DOB step. A refusal returns nothing derived from the date of birth (no age, no DOB): the
 * caller persists the soft block only. The date is returned only on acceptance, to be sent to the
 * server once and never stored on the device.
 */
export function assessAge(
  fields: DobFields,
  attestedAtLeast18: boolean,
  deviceId: string,
  existingBlock: DeviceSoftBlock | undefined,
  deps: AgeGateDeps,
): AgeGateOutcome {
  const parsed = parseDobFields(fields);
  if (!parsed.ok) return { kind: "invalid_date" };
  let result;
  try {
    result = evaluateOnboardingAge(
      { dob: parsed.dob, attestedAtLeast18, deviceId, existingBlock },
      deps.hasher,
      deps.clock,
    );
  } catch {
    // DOB in the future or similar: treat as an invalid date, never as acceptance.
    return { kind: "invalid_date" };
  }
  switch (result.outcome) {
    case "accepted":
      return { kind: "accepted", limitedCapacity: result.limitedCapacity, dob: parsed.dob };
    case "refused_under_18":
      return { kind: "blocked_under_18", block: result.block };
    case "refused_no_attestation":
      return { kind: "needs_attestation" };
    case "refused_device_blocked":
      return { kind: "blocked_device" };
  }
}

/** Fresh-install form state: nothing pre-filled, attestation unticked. */
export const EMPTY_DOB_FIELDS: DobFields = { day: "", month: "", year: "" };
export const INITIAL_ATTESTED = false;

// ---------------------------------------------------------------------------------------------
// Single masked date entry ("DD / MM / YYYY"). Pure functions only; the screen holds one string of
// ASCII digits (the "draft") and derives DobFields from it, so runAgeGate and the age-gate rules
// are untouched. Order is day, month, year in Arabic and English (Egyptian locales are DMY).
// ---------------------------------------------------------------------------------------------

export const DOB_MIN_YEAR = 1900;
export const DOB_DRAFT_LENGTH = 8;
export const DOB_SEPARATOR = " / ";
const LRI = "⁦";
const PDI = "⁩";

/** Digits from any input: Arabic-Indic and Persian digits are mapped to ASCII, everything else dropped. */
export function digitsOf(input: string): string {
  return toAsciiDigits(input).replace(/\D/g, "");
}

/** Leap year in the proleptic Gregorian calendar. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** "25", "03", "1998" from a draft of up to eight digits. */
export function draftToFields(draft: string): DobFields {
  const d = digitsOf(draft);
  return { day: d.slice(0, 2), month: d.slice(2, 4), year: d.slice(4, 8) };
}

export function fieldsToDraft(fields: DobFields): string {
  return `${fields.day}${fields.month}${fields.year}`;
}

/** Plain mask text, e.g. "25 / 03 / 19". Separators appear only once a following digit exists. */
export function formatDobDraft(draft: string): string {
  const { day, month, year } = draftToFields(draft);
  return [day, month, year].filter((s) => s !== "").join(DOB_SEPARATOR);
}

/**
 * Text shown in the input. Wrapped in a left-to-right isolate so digits and slashes keep their
 * order inside an RTL paragraph. Every consumer strips it again through digitsOf.
 */
export function displayDobDraft(draft: string): string {
  const text = formatDobDraft(draft);
  return text === "" ? "" : `${LRI}${text}${PDI}`;
}

function splitSegments(text: string): string[] {
  return text.split(/\D+/).filter((s) => s !== "");
}

function padPaste(text: string): string | null {
  const ascii = toAsciiDigits(text).trim();
  if (!/\D/.test(ascii.replace(/^\D+|\D+$/g, ""))) return null; // no inner separator: plain digits
  const parts = splitSegments(ascii);
  if (parts.length !== 3) return null;
  const [a = "", b = "", c = ""] = parts;
  // ISO-like "1998-03-25" (4-digit first part) is reordered to day, month, year.
  const [day, month, year] = a.length === 4 ? [c, b, a] : [a, b, c];
  if (day.length > 2 || month.length > 2 || year.length > 4) return null;
  return `${day.padStart(2, "0")}${month.padStart(2, "0")}${year}`;
}

/**
 * Next draft for a text change. `prev` is the current draft, `nextText` whatever the input now
 * holds (typed digit, deletion, paste, autofill, Arabic digits).
 *  - A single typed digit that cannot start a day (4-9) or a month (2-9) is padded: "4" becomes "04".
 *  - A paste of 2+ new characters with separators ("3/5/1998", "1998-05-03", "٣/٥/١٩٩٨") is split
 *    into segments and padded; plain digits are taken as they are.
 *  - The draft never exceeds eight digits.
 */
export function applyDobInput(prev: string, nextText: string): string {
  const before = digitsOf(prev).slice(0, DOB_DRAFT_LENGTH);
  const typed = digitsOf(nextText);
  if (typed.length - before.length > 1) {
    const pasted = padPaste(nextText);
    if (pasted !== null) return pasted.slice(0, DOB_DRAFT_LENGTH);
    return typed.slice(0, DOB_DRAFT_LENGTH);
  }
  if (typed.length === before.length + 1 && typed.startsWith(before)) {
    const added = typed.slice(-1);
    if (before.length === 0 && added > "3") return `0${added}`;
    if (before.length === 2 && added > "1") return `${before}0${added}`;
  }
  return typed.slice(0, DOB_DRAFT_LENGTH);
}

export type DobDraftIssue = "invalid_day" | "invalid_month" | "invalid_date" | "year_range" | "future";

export type DobDraftStatus =
  | { readonly state: "empty" }
  | { readonly state: "partial" }
  | { readonly state: "valid"; readonly dob: CivilDate }
  | { readonly state: "error"; readonly issue: DobDraftIssue };

/**
 * Validation while typing. It judges only what is already typed: a finished day or month that
 * cannot exist is an error at once, a full date is checked for the calendar, the year range and
 * the future. Under-18 is deliberately NOT judged here; that stays with the age gate at submit.
 */
export function validateDobDraft(draft: string, today: { year: number; month: number; day: number }): DobDraftStatus {
  const d = digitsOf(draft).slice(0, DOB_DRAFT_LENGTH);
  if (d === "") return { state: "empty" };
  const { day, month, year } = draftToFields(d);
  if (day.length === 2) {
    const n = Number(day);
    if (n < 1 || n > 31) return { state: "error", issue: "invalid_day" };
  }
  if (month.length === 2) {
    const n = Number(month);
    if (n < 1 || n > 12) return { state: "error", issue: "invalid_month" };
  }
  if (day.length === 2 && month.length === 2) {
    // Day against month is known before the year is: 31/04 is impossible in any year, 29/02 needs a year.
    if (Number(day) > daysInMonth(2000, Number(month))) return { state: "error", issue: "invalid_date" };
  }
  if (year.length < 4) return { state: "partial" };
  const y = Number(year);
  if (y < DOB_MIN_YEAR) return { state: "error", issue: "year_range" };
  if (y > today.year) return { state: "error", issue: "future" };
  if (Number(day) > daysInMonth(y, Number(month))) return { state: "error", issue: "invalid_date" };
  if (y === today.year && (Number(month) > today.month || (Number(month) === today.month && Number(day) > today.day))) {
    return { state: "error", issue: "future" };
  }
  return { state: "valid", dob: { year: y, month: Number(month), day: Number(day) } };
}

export function civilToday(now: Date): { year: number; month: number; day: number } {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
}

/** Year options for the calendar picker, newest first, never past `today` and never before DOB_MIN_YEAR. */
export function pickerYears(todayYear: number): number[] {
  const out: number[] = [];
  for (let y = todayYear; y >= DOB_MIN_YEAR; y -= 1) out.push(y);
  return out;
}

/** Draft for a date chosen in the picker. Day is clamped to the month (31 -> 30, 29 Feb -> 28). */
export function draftFromPicker(year: number, month: number, day: number): string {
  const d = Math.min(Math.max(day, 1), daysInMonth(year, month));
  return `${String(d).padStart(2, "0")}${String(month).padStart(2, "0")}${String(year).padStart(4, "0")}`;
}
