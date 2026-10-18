// Targeted tests for family seat accounting and student verification. Written to kill Stryker survivors
// (ADR-0019). Modules are loaded with dynamic import inside each test: both files define state machines
// that validate themselves at import time, so a corrupted table crashes the load, and a crash inside a
// test is what Stryker counts as a kill.
import { describe, expect, it } from "vitest";
import type { FamilyGroup, FamilyMember } from "./family";
import type { StudentVerification } from "./student";

const F = () => import("./family");
const S = () => import("./student");
const DAY = 86_400_000;
const T = 1_800_000_000_000;

const member = (over: Partial<FamilyMember> = {}): FamilyMember => ({
  id: "m",
  groupId: "g",
  userId: "u",
  role: "member",
  status: "ACTIVE",
  seatNo: 2,
  nickname: null,
  invitedAtMs: T,
  inviteExpiresAtMs: null,
  seatEffectiveFromMs: T,
  seatEndAtMs: null,
  removedAtMs: null,
  removedBy: null,
  ...over,
});
const group = (over: Partial<FamilyGroup> = {}): FamilyGroup => ({
  id: "g",
  ownerUserId: "o",
  subscriptionId: "s",
  seatLimit: 4,
  status: "ACTIVE",
  endingNoticeSentAtMs: null,
  createdAtMs: T,
  version: 0,
  ...over,
});

describe("family machines", () => {
  it("member machine: every state x event", async () => {
    const f = await F();
    const want: Record<string, Record<string, string>> = {
      INVITED: { ACCEPT: "ACTIVE", REVOKE: "ENDED", INVITE_EXPIRED: "ENDED", GROUP_ENDED: "ENDED" },
      ACTIVE: { REMOVE: "REMOVED", LEAVE: "REMOVED", GROUP_ENDED: "ENDED" },
      REMOVED: { SEAT_ENDED: "ENDED", GROUP_ENDED: "ENDED" },
      ENDED: {},
    };
    expect([...f.FAMILY_MEMBER_STATES]).toEqual(["INVITED", "ACTIVE", "REMOVED", "ENDED"]);
    expect([...f.FAMILY_MEMBER_EVENTS]).toEqual(["ACCEPT", "REVOKE", "INVITE_EXPIRED", "REMOVE", "LEAVE", "SEAT_ENDED", "GROUP_ENDED"]);
    for (const s of f.FAMILY_MEMBER_STATES) {
      for (const e of f.FAMILY_MEMBER_EVENTS) {
        const to = want[s]?.[e];
        if (to === undefined) expect(() => f.familyMemberMachine.transition(s, e), `${s} ${e}`).toThrow();
        else expect(f.familyMemberMachine.transition(s, e), `${s} ${e}`).toBe(to);
      }
    }
    expect(f.familyMemberMachine.name).toBe("FamilyMember");
    expect(f.familyMemberMachine.initial).toBe("INVITED");
    expect([...f.familyMemberMachine.terminalStates]).toEqual(["ENDED"]);
  });
  it("group machine", async () => {
    const f = await F();
    expect(f.familyGroupMachine.name).toBe("FamilyGroup");
    expect(f.familyGroupMachine.initial).toBe("ACTIVE");
    expect([...f.familyGroupMachine.terminalStates]).toEqual(["ENDED"]);
    expect(f.familyGroupMachine.transition("ACTIVE", "TERMINATE")).toBe("ENDED");
    expect(() => f.familyGroupMachine.transition("ENDED", "TERMINATE")).toThrow();
    expect([...f.FAMILY_GROUP_STATES]).toEqual(["ACTIVE", "ENDED"]);
  });
  it("constants", async () => {
    const f = await F();
    expect([f.FAMILY_SEAT_LIMIT_DEFAULT, f.FAMILY_SEAT_LIMIT_MAX, f.FAMILY_INVITE_TTL_DAYS, f.SEAT_CHURN_WINDOW_DAYS, f.SEAT_CHURN_MAX, f.FAMILY_MEMBER_FLOOR_AGE]).toEqual([
      4, 8, 7, 90, 2, 18,
    ]);
  });
});

describe("seat accounting", () => {
  it("holdsSeat per status and boundary", async () => {
    const { holdsSeat } = await F();
    expect(holdsSeat(member({ status: "ACTIVE" }), T)).toBe(true);
    expect(holdsSeat(member({ status: "INVITED", inviteExpiresAtMs: null }), T)).toBe(true);
    expect(holdsSeat(member({ status: "INVITED", inviteExpiresAtMs: T + 1 }), T)).toBe(true);
    expect(holdsSeat(member({ status: "INVITED", inviteExpiresAtMs: T }), T)).toBe(false);
    expect(holdsSeat(member({ status: "REMOVED", seatEndAtMs: null }), T)).toBe(true);
    expect(holdsSeat(member({ status: "REMOVED", seatEndAtMs: T + 1 }), T)).toBe(true);
    expect(holdsSeat(member({ status: "REMOVED", seatEndAtMs: T }), T)).toBe(false);
    expect(holdsSeat(member({ status: "ENDED" }), T)).toBe(false);
  });
  it("seatsHeld and nextFreeSeat", async () => {
    const { seatsHeld, nextFreeSeat } = await F();
    const ms = [
      member({ id: "1", seatNo: 1 }),
      member({ id: "3", seatNo: 3 }),
      member({ id: "x", seatNo: 2, status: "ENDED" }),
      member({ id: "y", seatNo: 4, status: "REMOVED", seatEndAtMs: T }),
    ];
    expect(seatsHeld(ms, T)).toBe(2);
    expect(nextFreeSeat(ms, T, 4)).toBe(2);
    expect(nextFreeSeat([member({ seatNo: 1 }), member({ seatNo: 2 })], T, 2)).toBeNull();
    expect(nextFreeSeat([], T, 0)).toBeNull();
    expect(nextFreeSeat([member({ seatNo: 1 })], T, 2)).toBe(2);
    expect(nextFreeSeat([], T, 4)).toBe(1);
  });
  it("seatChurn counts removals strictly inside the 90 day window", async () => {
    const { seatChurn } = await F();
    const from = T - 90 * DAY;
    const ms = [
      member({ id: "a", removedAtMs: from }),
      member({ id: "b", removedAtMs: from + 1 }),
      member({ id: "c", removedAtMs: T }),
      member({ id: "d", removedAtMs: null }),
      member({ id: "e", removedAtMs: from - DAY }),
    ];
    expect(seatChurn(ms, T)).toBe(2);
    expect(seatChurn([], T)).toBe(0);
  });
  it("seatLimitOf clamps and defaults", async () => {
    const { seatLimitOf } = await F();
    const plan = (o: object) => ({ id: "p", code: "c", interval: "year", priceMinor: 1n, version: 1, active: true, trialDays: 0, effectiveFromMs: 0, notifiedAtMs: null, ...o }) as never;
    expect(seatLimitOf(plan({ kind: "individual", seatLimit: 5 }))).toBeNull();
    expect(seatLimitOf(plan({}))).toBeNull();
    expect(seatLimitOf(plan({ kind: "family" }))).toBe(4);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: null }))).toBe(4);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 0 }))).toBe(1);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: -3 }))).toBe(1);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 1 }))).toBe(1);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 8 }))).toBe(8);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 9 }))).toBe(8);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 100 }))).toBe(8);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 2.9 }))).toBe(2);
  });
  it("memberAgeOk applies the 18 floor to a lower plan age", async () => {
    const { memberAgeOk } = await F();
    expect(memberAgeOk(null, 21)).toBe(false);
    expect(memberAgeOk(20, 21)).toBe(false);
    expect(memberAgeOk(21, 21)).toBe(true);
    expect(memberAgeOk(17, 16)).toBe(false);
    expect(memberAgeOk(18, 16)).toBe(true);
    expect(memberAgeOk(18, 18)).toBe(true);
  });
});

describe("decideInvite", () => {
  const run = async (over: Record<string, unknown> = {}, members: FamilyMember[] = [], now = T) => {
    const { decideInvite } = await F();
    return decideInvite({
      group: group(),
      members,
      nowMs: now,
      ownerEntitled: true,
      knownInviteeAgeYears: "unknown",
      plusMinAge: 21,
      inviteeAlreadyInAFamily: false,
      ...over,
    } as never);
  };
  const owner = (): FamilyMember => member({ id: "o", role: "owner", seatNo: 1 });
  it("happy path gives the lowest free seat", async () => {
    expect(await run({}, [owner()])).toEqual({ ok: true, seatNo: 2 });
    expect(await run({ knownInviteeAgeYears: 21 }, [owner()])).toEqual({ ok: true, seatNo: 2 });
  });
  it("refusal precedence", async () => {
    const full = [owner(), member({ id: "a", seatNo: 2 }), member({ id: "b", seatNo: 3 }), member({ id: "c", seatNo: 4 })];
    const all = { group: group({ status: "ENDED" }), ownerEntitled: false, knownInviteeAgeYears: 5, inviteeAlreadyInAFamily: true };
    expect(await run(all, full)).toEqual({ ok: false, reason: "group_ended" });
    expect(await run({ ...all, group: group() }, full)).toEqual({ ok: false, reason: "owner_not_entitled" });
    expect(await run({ ...all, group: group(), ownerEntitled: true }, full)).toEqual({ ok: false, reason: "age_gate" });
    expect(await run({ ...all, group: group(), ownerEntitled: true, knownInviteeAgeYears: 30 }, full)).toEqual({ ok: false, reason: "already_in_family" });
    expect(await run({}, full)).toEqual({ ok: false, reason: "seats_full" });
    expect(await run({ knownInviteeAgeYears: null }, [owner()])).toEqual({ ok: false, reason: "age_gate" });
  });
  it("seat churn limit: two removals in 90 days refuse, one does not", async () => {
    const gone = (id: string, seatNo: number, at: number) => member({ id, seatNo, status: "ENDED", removedAtMs: at });
    const two = [owner(), gone("a", 2, T - DAY), gone("b", 3, T - 2 * DAY)];
    expect(await run({}, two)).toEqual({ ok: false, reason: "seat_churn_limit" });
    const one = [owner(), gone("a", 2, T - DAY), gone("b", 3, T - 100 * DAY)];
    expect(await run({}, one)).toEqual({ ok: true, seatNo: 2 });
  });
});

describe("member lifecycle", () => {
  it("newInvitedMember and ownerMember", async () => {
    const f = await F();
    expect(f.newInvitedMember({ id: "m1", groupId: "g", seatNo: 3, nickname: "Sis", nowMs: T })).toEqual({
      id: "m1",
      groupId: "g",
      userId: null,
      role: "member",
      status: "INVITED",
      seatNo: 3,
      nickname: "Sis",
      invitedAtMs: T,
      inviteExpiresAtMs: T + 7 * DAY,
      seatEffectiveFromMs: null,
      seatEndAtMs: null,
      removedAtMs: null,
      removedBy: null,
    });
    expect(f.ownerMember({ id: "o", groupId: "g", userId: "u", nowMs: T })).toEqual({
      id: "o",
      groupId: "g",
      userId: "u",
      role: "owner",
      status: "ACTIVE",
      seatNo: 1,
      nickname: null,
      invitedAtMs: T,
      inviteExpiresAtMs: null,
      seatEffectiveFromMs: T,
      seatEndAtMs: null,
      removedAtMs: null,
      removedBy: null,
    });
  });
  it("acceptMember", async () => {
    const f = await F();
    const inv = f.newInvitedMember({ id: "m1", groupId: "g", seatNo: 2, nickname: null, nowMs: T });
    const ok = f.acceptMember(inv, "u9", T + 1);
    expect(ok).toMatchObject({ status: "ACTIVE", userId: "u9", inviteExpiresAtMs: null, seatEffectiveFromMs: T + 1 });
    expect(() => f.acceptMember({ ...inv, role: "owner" }, "u", T)).toThrow("only a member seat can be accepted");
    expect(() => f.acceptMember(inv, "u", T + 7 * DAY)).toThrow("invite expired");
    expect(f.acceptMember(inv, "u", T + 7 * DAY - 1).status).toBe("ACTIVE");
    expect(f.acceptMember({ ...inv, inviteExpiresAtMs: null }, "u", T + 99 * DAY).status).toBe("ACTIVE");
    expect(() => f.acceptMember({ ...inv, status: "ACTIVE" }, "u", T)).toThrow();
  });
  it("endSeat keeps the seat until the paid period ends", async () => {
    const f = await F();
    const m = member();
    expect(f.endSeat(m, "owner", T, null)).toMatchObject({ status: "REMOVED", removedAtMs: T, removedBy: "owner", seatEndAtMs: T });
    expect(f.endSeat(m, "self", T, T + 5 * DAY)).toMatchObject({ status: "REMOVED", removedBy: "self", seatEndAtMs: T + 5 * DAY });
    expect(f.endSeat(m, "system", T, T - DAY).seatEndAtMs).toBe(T);
    expect(f.endSeat(m, "owner", T, T).seatEndAtMs).toBe(T);
    expect(() => f.endSeat(member({ role: "owner" }), "owner", T, null)).toThrow("the owner seat cannot be removed");
    expect(() => f.endSeat(member({ status: "ENDED" }), "owner", T, null)).toThrow();
  });
  it("revokeInvite", async () => {
    const f = await F();
    expect(f.revokeInvite(member({ status: "INVITED" })).status).toBe("ENDED");
    expect(() => f.revokeInvite(member({ status: "ACTIVE" }))).toThrow();
  });
  it("settleMember", async () => {
    const f = await F();
    const inv = member({ status: "INVITED", inviteExpiresAtMs: T });
    expect(f.settleMember(inv, T).status).toBe("ENDED");
    expect(f.settleMember(inv, T - 1)).toBe(inv);
    const never = member({ status: "INVITED", inviteExpiresAtMs: null, seatEndAtMs: T - 1 });
    expect(f.settleMember(never, T + DAY)).toBe(never);
    const rem = member({ status: "REMOVED", seatEndAtMs: T });
    expect(f.settleMember(rem, T).status).toBe("ENDED");
    expect(f.settleMember(rem, T - 1)).toBe(rem);
    const open = member({ status: "REMOVED", seatEndAtMs: null });
    expect(f.settleMember(open, T + 99 * DAY)).toBe(open);
    const act = member({ status: "ACTIVE", inviteExpiresAtMs: T - 5, seatEndAtMs: T - 5 });
    expect(f.settleMember(act, T)).toBe(act);
    const remWithInvite = member({ status: "REMOVED", inviteExpiresAtMs: T - 5, seatEndAtMs: T + DAY });
    expect(f.settleMember(remWithInvite, T)).toBe(remWithInvite);
    const invWithSeatEnd = member({ status: "INVITED", inviteExpiresAtMs: T + DAY, seatEndAtMs: T - 5 });
    expect(f.settleMember(invWithSeatEnd, T)).toBe(invWithSeatEnd);
  });
  it("endMemberWithGroup", async () => {
    const f = await F();
    const ended = member({ status: "ENDED" });
    expect(f.endMemberWithGroup(ended)).toBe(ended);
    for (const s of ["INVITED", "ACTIVE", "REMOVED"] as const) expect(f.endMemberWithGroup(member({ status: s })).status).toBe("ENDED");
  });
});

describe("seatEntitlementEndsAt", () => {
  const base = async (over: Record<string, unknown> = {}) => {
    const f = await F();
    return f.seatEntitlementEndsAt({
      member: member(),
      groupStatus: "ACTIVE",
      ownerEntitlementEndMs: T + 100,
      ownerPeriodEndMs: T + 50,
      familyPlanContinues: false,
      nowMs: T + 10,
      ...over,
    } as never);
  };
  it("is the owner's entitlement, capped by the paid period unless the family plan continues", async () => {
    expect(await base()).toBe(T + 50);
    expect(await base({ familyPlanContinues: true })).toBe(T + 100);
    expect(await base({ ownerPeriodEndMs: T + 500 })).toBe(T + 100);
  });
  it("a removed member keeps access to the end of their seat only", async () => {
    const removed = member({ status: "REMOVED", seatEndAtMs: T + 30 });
    expect(await base({ member: removed, familyPlanContinues: true })).toBe(T + 30);
    expect(await base({ member: member({ status: "REMOVED", seatEndAtMs: null }), familyPlanContinues: true })).toBe(T + 100);
    // an active member's seatEndAtMs is ignored
    expect(await base({ member: member({ status: "ACTIVE", seatEndAtMs: T + 30 }), familyPlanContinues: true })).toBe(T + 100);
    // seat end later than the owner entitlement does not extend it
    expect(await base({ member: member({ status: "REMOVED", seatEndAtMs: T + 900 }), familyPlanContinues: true })).toBe(T + 100);
  });
  it("null when any precondition fails", async () => {
    expect(await base({ groupStatus: "ENDED" })).toBeNull();
    expect(await base({ member: member({ role: "owner" }) })).toBeNull();
    expect(await base({ member: member({ status: "INVITED" }) })).toBeNull();
    expect(await base({ member: member({ status: "ENDED" }) })).toBeNull();
    expect(await base({ member: member({ seatEffectiveFromMs: null }) })).toBeNull();
    expect(await base({ member: member({ seatEffectiveFromMs: T + 11 }) })).toBeNull();
    expect(await base({ member: member({ seatEffectiveFromMs: T + 10 }) })).toBe(T + 50);
    expect(await base({ ownerEntitlementEndMs: null })).toBeNull();
    expect(await base({ ownerEntitlementEndMs: T + 10, familyPlanContinues: true })).toBeNull();
    expect(await base({ ownerEntitlementEndMs: T + 11, familyPlanContinues: true })).toBe(T + 11);
  });
});

describe("familyMarketing", () => {
  it("computes the saving against separate yearly plans", async () => {
    const { familyMarketing } = await F();
    expect(familyMarketing({ individualYearlyMinor: 80_000n, familyYearlyMinor: 120_000n, seatLimit: 4 })).toEqual({ seats: 4, savingMinor: 200_000n });
    expect(familyMarketing({ individualYearlyMinor: 30_000n, familyYearlyMinor: 120_000n, seatLimit: 4 })).toEqual({ seats: 4, savingMinor: 0n });
    expect(familyMarketing({ individualYearlyMinor: 30_000n, familyYearlyMinor: 120_000n, seatLimit: 5 })).toEqual({ seats: 5, savingMinor: 30_000n });
    expect(familyMarketing({ individualYearlyMinor: 5n, familyYearlyMinor: 1n, seatLimit: 1 })).toEqual({ seats: 1, savingMinor: 4n });
  });
  it("rejects non-positive prices and seat counts", async () => {
    const { familyMarketing } = await F();
    const msg = "prices must be positive and seats at least one";
    expect(() => familyMarketing({ individualYearlyMinor: 0n, familyYearlyMinor: 1n, seatLimit: 1 })).toThrow(msg);
    expect(() => familyMarketing({ individualYearlyMinor: 1n, familyYearlyMinor: 0n, seatLimit: 1 })).toThrow(msg);
    expect(() => familyMarketing({ individualYearlyMinor: 1n, familyYearlyMinor: -1n, seatLimit: 1 })).toThrow(msg);
    expect(() => familyMarketing({ individualYearlyMinor: 1n, familyYearlyMinor: 1n, seatLimit: 0 })).toThrow(msg);
  });
});

describe("student verification", () => {
  const v = (over: Partial<StudentVerification> = {}): StudentVerification => ({
    id: "v",
    userId: "u",
    verifier: "unidays",
    ref: "r",
    status: "VERIFIED",
    verifiedAtMs: T,
    validUntilMs: T + 100 * DAY,
    noticeSentAtMs: null,
    createdAtMs: T - DAY,
    version: 3,
    ...over,
  });
  it("machine table, constants and metadata", async () => {
    const s = await S();
    expect([s.STUDENT_VALIDITY_MONTHS, s.STUDENT_NOTICE_DAYS]).toEqual([12, 30]);
    expect([...s.STUDENT_STATES]).toEqual(["PENDING", "VERIFIED", "REJECTED", "EXPIRED"]);
    expect([...s.STUDENT_EVENTS]).toEqual(["VERIFY", "REJECT", "EXPIRE"]);
    const want: Record<string, Record<string, string>> = {
      PENDING: { VERIFY: "VERIFIED", REJECT: "REJECTED" },
      VERIFIED: { EXPIRE: "EXPIRED" },
      REJECTED: {},
      EXPIRED: {},
    };
    for (const st of s.STUDENT_STATES) {
      for (const e of s.STUDENT_EVENTS) {
        const to = want[st]?.[e];
        if (to === undefined) expect(() => s.studentMachine.transition(st, e), `${st} ${e}`).toThrow();
        else expect(s.studentMachine.transition(st, e)).toBe(to);
      }
    }
    expect(s.studentMachine.name).toBe("StudentVerification");
    expect(s.studentMachine.initial).toBe("PENDING");
    expect([...s.studentMachine.terminalStates]).toEqual(["REJECTED", "EXPIRED"]);
  });
  it("validity is capped at 12 months from verification", async () => {
    const s = await S();
    const t0 = Date.UTC(2026, 0, 31, 12);
    const cap = Date.UTC(2027, 0, 31, 12);
    expect(s.studentValidUntil(t0, null)).toBe(cap);
    expect(s.studentValidUntil(t0, cap + DAY)).toBe(cap);
    expect(s.studentValidUntil(t0, cap)).toBe(cap);
    expect(s.studentValidUntil(t0, cap - DAY)).toBe(cap - DAY);
  });
  it("price applies only while verified and before the expiry instant", async () => {
    const s = await S();
    expect(s.studentPriceApplies(null, T)).toBe(false);
    expect(s.studentPriceApplies(v(), T)).toBe(true);
    expect(s.studentPriceApplies(v({ status: "PENDING" }), T)).toBe(false);
    expect(s.studentPriceApplies(v({ status: "EXPIRED" }), T)).toBe(false);
    expect(s.studentPriceApplies(v({ validUntilMs: null }), T)).toBe(false);
    expect(s.studentPriceApplies(v({ validUntilMs: T }), T)).toBe(false);
    expect(s.studentPriceApplies(v({ validUntilMs: T + 1 }), T)).toBe(true);
  });
  it("notice is due 30 days out, once", async () => {
    const s = await S();
    const exp = T + 30 * DAY;
    expect(s.studentNoticeDue(v({ validUntilMs: exp }), T)).toBe(true);
    expect(s.studentNoticeDue(v({ validUntilMs: exp + 1 }), T)).toBe(false);
    expect(s.studentNoticeDue(v({ validUntilMs: T - DAY }), T)).toBe(true);
    expect(s.studentNoticeDue(v({ validUntilMs: exp, noticeSentAtMs: T - 1 }), T)).toBe(false);
    expect(s.studentNoticeDue(v({ validUntilMs: exp, status: "PENDING" }), T)).toBe(false);
    expect(s.studentNoticeDue(v({ validUntilMs: null }), T)).toBe(false);
  });
  it("lapsed at the expiry instant", async () => {
    const s = await S();
    expect(s.studentLapsed(v({ validUntilMs: T }), T)).toBe(true);
    expect(s.studentLapsed(v({ validUntilMs: T + 1 }), T)).toBe(false);
    expect(s.studentLapsed(v({ validUntilMs: T, status: "PENDING" }), T)).toBe(false);
    expect(s.studentLapsed(v({ validUntilMs: null }), T + 999 * DAY)).toBe(false);
  });
  it("verify, reject and expire keep every other field", async () => {
    const s = await S();
    const pending = v({ status: "PENDING", verifiedAtMs: null, validUntilMs: null });
    const ok = s.verifyStudent(pending, T, null);
    expect(ok).toEqual({ ...pending, status: "VERIFIED", verifiedAtMs: T, validUntilMs: s.studentValidUntil(T, null) });
    expect(s.rejectStudent(pending)).toEqual({ ...pending, status: "REJECTED" });
    expect(s.expireStudent(v())).toEqual({ ...v(), status: "EXPIRED" });
    expect(() => s.verifyStudent(v(), T, null)).toThrow();
    expect(() => s.rejectStudent(v())).toThrow();
    expect(() => s.expireStudent(pending)).toThrow();
  });
});
