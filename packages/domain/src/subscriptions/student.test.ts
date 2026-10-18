import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  STUDENT_EVENTS,
  STUDENT_NOTICE_DAYS,
  STUDENT_STATES,
  expireStudent,
  rejectStudent,
  studentLapsed,
  studentMachine,
  studentNoticeDue,
  studentPriceApplies,
  studentValidUntil,
  verifyStudent,
  type StudentVerification,
} from "./student";
import { addMonthsUtc } from "./billing";
import { DAY_MS } from "./types";

const T0 = Date.UTC(2026, 0, 15, 9);
const pending: StudentVerification = {
  id: "v",
  userId: "u",
  verifier: "fake",
  ref: "r1",
  status: "PENDING",
  verifiedAtMs: null,
  validUntilMs: null,
  noticeSentAtMs: null,
  createdAtMs: T0,
  version: 0,
};

describe("student verification", () => {
  it("machine is sound and only PENDING can verify or reject", () => {
    expect(studentMachine.analyze().ok).toBe(true);
    for (const s of STUDENT_STATES) {
      for (const e of STUDENT_EVENTS) {
        const ok = (s === "PENDING" && (e === "VERIFY" || e === "REJECT")) || (s === "VERIFIED" && e === "EXPIRE");
        if (ok) expect(() => studentMachine.transition(s, e)).not.toThrow();
        else expect(() => studentMachine.transition(s, e)).toThrow();
      }
    }
  });

  it("validity is capped at 12 months whatever the verifier claims", () => {
    const cap = addMonthsUtc(T0, 12);
    expect(studentValidUntil(T0, null)).toBe(cap);
    expect(studentValidUntil(T0, cap + 400 * DAY_MS)).toBe(cap);
    expect(studentValidUntil(T0, T0 + 10 * DAY_MS)).toBe(T0 + 10 * DAY_MS);
  });

  it("price applies only while VERIFIED and unexpired; null and pending fail closed", () => {
    const v = verifyStudent(pending, T0, null);
    expect(studentPriceApplies(v, T0 + 1)).toBe(true);
    expect(studentPriceApplies(v, v.validUntilMs ?? 0)).toBe(false);
    expect(studentPriceApplies(null, T0)).toBe(false);
    expect(studentPriceApplies(pending, T0)).toBe(false);
    expect(studentPriceApplies(rejectStudent(pending), T0)).toBe(false);
    expect(studentPriceApplies(expireStudent(v), T0)).toBe(false);
  });

  it("notice is due exactly within 30 days of the end and only once", () => {
    const v = verifyStudent(pending, T0, null);
    const end = v.validUntilMs ?? 0;
    expect(studentNoticeDue(v, end - STUDENT_NOTICE_DAYS * DAY_MS - 1)).toBe(false);
    expect(studentNoticeDue(v, end - STUDENT_NOTICE_DAYS * DAY_MS)).toBe(true);
    expect(studentNoticeDue({ ...v, noticeSentAtMs: end - 31 * DAY_MS }, end - DAY_MS)).toBe(false);
    expect(studentLapsed(v, end - 1)).toBe(false);
    expect(studentLapsed(v, end)).toBe(true);
  });

  it("property: price never applies at or after validUntil", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 800 }), fc.integer({ min: 0, max: 800 }), (verifiedDay, atDay) => {
        const v = verifyStudent(pending, T0 + verifiedDay * DAY_MS, null);
        const at = T0 + atDay * DAY_MS;
        expect(studentPriceApplies(v, at)).toBe(at < (v.validUntilMs ?? 0));
      }),
    );
  });
});
