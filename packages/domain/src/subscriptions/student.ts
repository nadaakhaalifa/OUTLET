import { defineMachine } from "../state-machine/machine";
import { addMonthsUtc } from "./billing";
import { DAY_MS } from "./types";

/**
 * Student verification (spec P3-03). We keep only the verifier's reference and an expiry, never ID
 * images. No student price without a VERIFIED, unexpired status; unknown or missing fails closed.
 */
export const STUDENT_VALIDITY_MONTHS = 12;
export const STUDENT_NOTICE_DAYS = 30;

export const STUDENT_STATES = ["PENDING", "VERIFIED", "REJECTED", "EXPIRED"] as const;
export type StudentState = (typeof STUDENT_STATES)[number];
export const STUDENT_EVENTS = ["VERIFY", "REJECT", "EXPIRE"] as const;
export type StudentEvent = (typeof STUDENT_EVENTS)[number];

export const studentMachine = defineMachine<StudentState, StudentEvent>({
  name: "StudentVerification",
  states: STUDENT_STATES,
  events: STUDENT_EVENTS,
  initial: "PENDING",
  terminal: ["REJECTED", "EXPIRED"],
  transitions: {
    PENDING: { VERIFY: { to: "VERIFIED" }, REJECT: { to: "REJECTED" } },
    VERIFIED: { EXPIRE: { to: "EXPIRED" } },
    REJECTED: {},
    EXPIRED: {},
  },
});

export interface StudentVerification {
  readonly id: string;
  readonly userId: string;
  readonly verifier: string;
  /** The verifier's reference. Unique: a replayed callback finds the same row. */
  readonly ref: string;
  readonly status: StudentState;
  readonly verifiedAtMs: number | null;
  readonly validUntilMs: number | null;
  readonly noticeSentAtMs: number | null;
  readonly createdAtMs: number;
  readonly version: number;
}

/** Validity never exceeds 12 months from verification, whatever the verifier claims. */
export function studentValidUntil(verifiedAtMs: number, claimedUntilMs: number | null): number {
  const cap = addMonthsUtc(verifiedAtMs, STUDENT_VALIDITY_MONTHS);
  return claimedUntilMs === null ? cap : Math.min(claimedUntilMs, cap);
}

export function studentPriceApplies(v: StudentVerification | null, atMs: number): boolean {
  return v !== null && v.status === "VERIFIED" && v.validUntilMs !== null && atMs < v.validUntilMs;
}

/** The 30-day heads-up before the status lapses (price reverts at the next renewal, never silently). */
export function studentNoticeDue(v: StudentVerification, nowMs: number): boolean {
  return (
    v.status === "VERIFIED" &&
    v.noticeSentAtMs === null &&
    v.validUntilMs !== null &&
    v.validUntilMs - nowMs <= STUDENT_NOTICE_DAYS * DAY_MS
  );
}

export function studentLapsed(v: StudentVerification, nowMs: number): boolean {
  return v.status === "VERIFIED" && v.validUntilMs !== null && nowMs >= v.validUntilMs;
}

export function verifyStudent(v: StudentVerification, nowMs: number, claimedUntilMs: number | null): StudentVerification {
  const status = studentMachine.transition(v.status, "VERIFY");
  return { ...v, status, verifiedAtMs: nowMs, validUntilMs: studentValidUntil(nowMs, claimedUntilMs) };
}

export function rejectStudent(v: StudentVerification): StudentVerification {
  return { ...v, status: studentMachine.transition(v.status, "REJECT") };
}

export function expireStudent(v: StudentVerification): StudentVerification {
  return { ...v, status: studentMachine.transition(v.status, "EXPIRE") };
}
