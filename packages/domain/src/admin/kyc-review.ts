import { DomainError } from "../errors";
import { defineMachine } from "../state-machine/machine";
import { MS_PER_DAY } from "./roles";

/**
 * Human review of seller suspensions (spec 9.5: a human reviews a suspension within 5 business days).
 * The KYC state itself is driven by the shared kycMachine; this record tracks the review obligation.
 */
export const SUSPENSION_REVIEW_SLA_BUSINESS_DAYS = 5;

/** Egypt's weekend is Friday and Saturday (0 = Sunday ... 6 = Saturday). Admin-editable. */
export const DEFAULT_WEEKEND_DAYS: readonly number[] = [5, 6];

const CAIRO_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" });
const DAY_INDEX: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function cairoWeekday(ms: number): number {
  const idx = DAY_INDEX[CAIRO_DAY.format(new Date(ms))];
  if (idx === undefined) throw new DomainError("unrecognised weekday");
  return idx;
}

const CAIRO_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Cairo",
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

interface CairoLocal {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly msOfDay: number;
  readonly ms: number;
}

function cairoLocal(ms: number): CairoLocal {
  const p: Record<string, number> = {};
  for (const part of CAIRO_PARTS.formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const y = p.year ?? 0;
  const m = p.month ?? 0;
  const d = p.day ?? 0;
  const msOfDay = (((p.hour ?? 0) * 60 + (p.minute ?? 0)) * 60 + (p.second ?? 0)) * 1000 + (((ms % 1000) + 1000) % 1000);
  return { y, m, d, msOfDay, ms };
}

/** Local wall time -> UTC ms. Gap times resolve forward, ambiguous times to the earlier instant. */
function cairoToUtc(y: number, m: number, d: number, msOfDay: number): number {
  const naive = Date.UTC(y, m - 1, d) + msOfDay;
  const candidates = new Set<number>();
  for (const offsetH of [2, 3]) candidates.add(naive - offsetH * 3_600_000);
  const valid = [...candidates]
    .filter((c) => {
      const l = cairoLocal(c);
      return l.y === y && l.m === m && l.d === d && l.msOfDay === msOfDay;
    })
    .sort((a, b) => a - b);
  const first = valid[0];
  if (first !== undefined) return first;
  return naive - 2 * 3_600_000; // inside a spring-forward gap: use the standard-time offset
}

/**
 * Adds whole business days in the Africa/Cairo calendar by stepping civil dates (not 24 h blocks),
 * so DST transitions never skip or double-count a day. The local wall time is preserved.
 * Starting on a weekend counts the next working day as day 1. Public holidays are not modelled.
 */
export function addBusinessDays(startMs: number, days: number, weekend: readonly number[] = DEFAULT_WEEKEND_DAYS): number {
  if (!Number.isInteger(days) || days < 0) throw new DomainError("days must be a non-negative integer");
  if (weekend.length >= 7) throw new DomainError("weekend cannot cover every day");
  if (days === 0) return startMs;
  const start = cairoLocal(startMs);
  let civil = Date.UTC(start.y, start.m - 1, start.d); // civil date held as UTC midnight
  let left = days;
  while (left > 0) {
    civil += MS_PER_DAY; // UTC has no DST: exactly one civil day
    if (!weekend.includes(new Date(civil).getUTCDay())) left -= 1;
  }
  const c = new Date(civil);
  return cairoToUtc(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), start.msOfDay);
}

export const REVIEW_STATES = ["OPEN", "UPHELD", "REINSTATED"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export const REVIEW_EVENTS = ["UPHOLD", "REINSTATE"] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export const suspensionReviewMachine = defineMachine<ReviewState, ReviewEvent>({
  name: "SuspensionReview",
  states: REVIEW_STATES,
  events: REVIEW_EVENTS,
  initial: "OPEN",
  terminal: ["UPHELD", "REINSTATED"],
  transitions: { OPEN: { UPHOLD: { to: "UPHELD" }, REINSTATE: { to: "REINSTATED" } }, UPHELD: {}, REINSTATED: {} },
});

export interface SuspensionReview {
  readonly id: string;
  readonly sellerId: string;
  readonly suspendedBy: string | null; // null = automatic suspension
  readonly suspendedAtMs: number;
  readonly dueAtMs: number;
  readonly reasonCode: string;
  readonly state: ReviewState;
  readonly reviewedBy: string | null;
  readonly reviewedAtMs: number | null;
}

export function openSuspensionReview(input: {
  readonly id: string;
  readonly sellerId: string;
  readonly suspendedBy: string | null;
  readonly reasonCode: string;
  readonly nowMs: number;
  readonly weekend?: readonly number[];
}): SuspensionReview {
  return {
    id: input.id,
    sellerId: input.sellerId,
    suspendedBy: input.suspendedBy,
    suspendedAtMs: input.nowMs,
    dueAtMs: addBusinessDays(input.nowMs, SUSPENSION_REVIEW_SLA_BUSINESS_DAYS, input.weekend),
    reasonCode: input.reasonCode,
    state: suspensionReviewMachine.initial,
    reviewedBy: null,
    reviewedAtMs: null,
  };
}

export const isReviewOverdue = (r: SuspensionReview, nowMs: number): boolean => r.state === "OPEN" && nowMs > r.dueAtMs;

export type ReviewDecisionResult =
  | { readonly kind: "decided"; readonly review: SuspensionReview }
  | { readonly kind: "denied"; readonly reason: "not_open" | "reviewer_is_suspender" };

/** A human other than the suspender decides. An automatic suspension has no suspender to conflict. */
export function decideReview(
  r: SuspensionReview,
  reviewerId: string,
  decision: "UPHOLD" | "REINSTATE",
  nowMs: number,
): ReviewDecisionResult {
  if (r.state !== "OPEN") return { kind: "denied", reason: "not_open" };
  if (r.suspendedBy !== null && r.suspendedBy === reviewerId) return { kind: "denied", reason: "reviewer_is_suspender" };
  return {
    kind: "decided",
    review: { ...r, state: suspensionReviewMachine.transition("OPEN", decision), reviewedBy: reviewerId, reviewedAtMs: nowMs },
  };
}
