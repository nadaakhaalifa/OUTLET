import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FAMILY_GROUP_STATES,
  FAMILY_MEMBER_EVENTS,
  FAMILY_MEMBER_STATES,
  SEAT_CHURN_MAX,
  acceptMember,
  decideInvite,
  endMemberWithGroup,
  endSeat,
  familyGroupMachine,
  familyMarketing,
  familyMemberMachine,
  holdsSeat,
  memberAgeOk,
  newInvitedMember,
  nextFreeSeat,
  ownerMember,
  revokeInvite,
  seatChurn,
  seatEntitlementEndsAt,
  seatLimitOf,
  seatsHeld,
  settleMember,
  type FamilyGroup,
  type FamilyMember,
} from "./family";
import { DAY_MS, type PlusPlan } from "./types";

const T0 = 1_800_000_000_000;
const group = (over: Partial<FamilyGroup> = {}): FamilyGroup => ({
  id: "g",
  ownerUserId: "owner",
  subscriptionId: "s",
  seatLimit: 4,
  status: "ACTIVE",
  endingNoticeSentAtMs: null,
  createdAtMs: T0,
  version: 0,
  ...over,
});
const owner = ownerMember({ id: "m0", groupId: "g", userId: "owner", nowMs: T0 });
const invited = (n: number, seatNo: number): FamilyMember =>
  newInvitedMember({ id: `m${n}`, groupId: "g", seatNo, nickname: null, nowMs: T0 });
const accepted = (n: number, seatNo: number): FamilyMember => acceptMember(invited(n, seatNo), `u${n}`, T0 + 1);

const decide = (members: readonly FamilyMember[], over: Partial<Parameters<typeof decideInvite>[0]> = {}, now = T0) =>
  decideInvite({
    group: group(),
    members,
    nowMs: now,
    ownerEntitled: true,
    knownInviteeAgeYears: "unknown",
    plusMinAge: 21,
    inviteeAlreadyInAFamily: false,
    ...over,
  });

describe("family member machine", () => {
  it("has no unreachable state, dead end or terminal with exits", () => {
    expect(familyMemberMachine.analyze().ok).toBe(true);
    expect(familyGroupMachine.analyze().ok).toBe(true);
  });

  it("allows exactly the table transitions", () => {
    const allowed: Record<string, Record<string, string>> = {
      INVITED: { ACCEPT: "ACTIVE", REVOKE: "ENDED", INVITE_EXPIRED: "ENDED", GROUP_ENDED: "ENDED" },
      ACTIVE: { REMOVE: "REMOVED", LEAVE: "REMOVED", GROUP_ENDED: "ENDED" },
      REMOVED: { SEAT_ENDED: "ENDED", GROUP_ENDED: "ENDED" },
      ENDED: {},
    };
    for (const s of FAMILY_MEMBER_STATES) {
      for (const e of FAMILY_MEMBER_EVENTS) {
        const to = allowed[s]?.[e];
        if (to === undefined) expect(() => familyMemberMachine.transition(s, e)).toThrow();
        else expect(familyMemberMachine.transition(s, e)).toBe(to);
      }
    }
    expect(FAMILY_GROUP_STATES).toEqual(["ACTIVE", "ENDED"]);
    expect(() => familyGroupMachine.transition("ENDED", "TERMINATE")).toThrow();
  });
});

describe("seat accounting", () => {
  it("the owner holds seat 1 and pending invites hold seats until they expire", () => {
    const inv = invited(1, 2);
    expect(seatsHeld([owner, inv], T0)).toBe(2);
    expect(holdsSeat(inv, T0 + 7 * DAY_MS - 1)).toBe(true);
    expect(holdsSeat(inv, T0 + 7 * DAY_MS)).toBe(false);
    expect(nextFreeSeat([owner, inv], T0 + 8 * DAY_MS, 4)).toBe(2);
  });

  it("a fifth invite on a family of four is refused", () => {
    const full = [owner, accepted(1, 2), accepted(2, 3), accepted(3, 4)];
    expect(decide(full)).toEqual({ ok: false, reason: "seats_full" });
    expect(decide(full.slice(0, 3))).toEqual({ ok: true, seatNo: 4 });
  });

  it("a member removed on day 10 keeps the seat and benefit until period end, then frees it", () => {
    const periodEnd = T0 + 30 * DAY_MS;
    const m = endSeat(accepted(1, 2), "owner", T0 + 10 * DAY_MS, periodEnd);
    expect(m.status).toBe("REMOVED");
    expect(m.seatEndAtMs).toBe(periodEnd);
    const full = [owner, m, accepted(2, 3), accepted(3, 4)];
    expect(decide(full, {}, T0 + 11 * DAY_MS)).toEqual({ ok: false, reason: "seats_full" });
    expect(decide(full, {}, periodEnd)).toEqual({ ok: true, seatNo: 2 });
    expect(settleMember(m, periodEnd).status).toBe("ENDED");
    expect(settleMember(m, periodEnd - 1).status).toBe("REMOVED");
  });

  it("a seat end is never in the past and the owner seat cannot be removed", () => {
    expect(endSeat(accepted(1, 2), "self", T0 + 5, T0).seatEndAtMs).toBe(T0 + 5);
    expect(() => endSeat(owner, "owner", T0, T0)).toThrow();
  });

  it("blocks invites after two removals in 90 days and releases the block when they age out", () => {
    const r1 = endSeat(accepted(1, 2), "owner", T0 + DAY_MS, T0 + DAY_MS);
    const r2 = endSeat(accepted(2, 3), "self", T0 + 2 * DAY_MS, T0 + 2 * DAY_MS);
    const members = [owner, r1, r2];
    const now = T0 + 3 * DAY_MS;
    expect(seatChurn(members, now)).toBe(SEAT_CHURN_MAX);
    expect(decide(members, {}, now)).toEqual({ ok: false, reason: "seat_churn_limit" });
    expect(decide(members, {}, T0 + 92 * DAY_MS).ok).toBe(true);
  });

  it("refuses by policy: age gate 21 blocks a known 19 year old, unknown age is checked at accept", () => {
    expect(decide([owner], { knownInviteeAgeYears: 19 })).toEqual({ ok: false, reason: "age_gate" });
    expect(decide([owner], { knownInviteeAgeYears: null })).toEqual({ ok: false, reason: "age_gate" });
    expect(decide([owner], { knownInviteeAgeYears: 21 }).ok).toBe(true);
    expect(decide([owner], { knownInviteeAgeYears: "unknown" }).ok).toBe(true);
    expect(decide([owner], { inviteeAlreadyInAFamily: true })).toEqual({ ok: false, reason: "already_in_family" });
    expect(decide([owner], { ownerEntitled: false })).toEqual({ ok: false, reason: "owner_not_entitled" });
    expect(decide([owner], { group: group({ status: "ENDED" }) })).toEqual({ ok: false, reason: "group_ended" });
  });

  it("the member floor is 18 even when the Plus gate is lowered below it", () => {
    expect(memberAgeOk(17, 16)).toBe(false);
    expect(memberAgeOk(18, 18)).toBe(true);
    expect(memberAgeOk(20, 21)).toBe(false);
    expect(memberAgeOk(null, 21)).toBe(false);
  });

  it("accepting an expired or non member seat throws", () => {
    expect(() => acceptMember(invited(1, 2), "u", T0 + 7 * DAY_MS)).toThrow();
    expect(() => acceptMember(owner, "u", T0)).toThrow();
    expect(revokeInvite(invited(1, 2)).status).toBe("ENDED");
    expect(endMemberWithGroup(accepted(1, 2)).status).toBe("ENDED");
    expect(endMemberWithGroup(endMemberWithGroup(accepted(1, 2))).status).toBe("ENDED");
  });

  it("property: no sequence of invite, accept, remove, leave holds more seats than the limit", () => {
    type Op =
      | { k: "invite"; age: number | "unknown" }
      | { k: "accept"; i: number }
      | { k: "remove"; i: number }
      | { k: "leave"; i: number }
      | { k: "revoke"; i: number }
      | { k: "tick"; days: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ k: fc.constant("invite" as const), age: fc.oneof(fc.integer({ min: 10, max: 60 }), fc.constant("unknown" as const)) }),
      fc.record({ k: fc.constant("accept" as const), i: fc.nat(9) }),
      fc.record({ k: fc.constant("remove" as const), i: fc.nat(9) }),
      fc.record({ k: fc.constant("leave" as const), i: fc.nat(9) }),
      fc.record({ k: fc.constant("revoke" as const), i: fc.nat(9) }),
      fc.record({ k: fc.constant("tick" as const), days: fc.integer({ min: 0, max: 40 }) }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.array(op, { maxLength: 60 }), (limit, ops) => {
        let now = T0;
        const g = group({ seatLimit: limit });
        let members: FamilyMember[] = [owner];
        let n = 0;
        const periodEnd = () => now + 15 * DAY_MS;
        for (const o of ops) {
          const pick = (i: number): number => {
            const idx = members.findIndex((_, j) => j === i % members.length);
            return idx;
          };
          try {
            if (o.k === "tick") now += o.days * DAY_MS;
            else if (o.k === "invite") {
              const d = decideInvite({
                group: g,
                members,
                nowMs: now,
                ownerEntitled: true,
                knownInviteeAgeYears: o.age,
                plusMinAge: 21,
                inviteeAlreadyInAFamily: false,
              });
              if (d.ok) {
                n += 1;
                members = [...members, newInvitedMember({ id: `x${n}`, groupId: "g", seatNo: d.seatNo, nickname: null, nowMs: now })];
              }
            } else {
              const idx = pick(o.i);
              const m = members[idx];
              if (m === undefined) continue;
              if (o.k === "accept") members[idx] = acceptMember(m, `u${idx}`, now);
              else if (o.k === "revoke") members[idx] = revokeInvite(m);
              else members[idx] = endSeat(m, o.k === "leave" ? "self" : "owner", now, periodEnd());
            }
          } catch {
            // an invalid transition is refused: state is unchanged
          }
          expect(seatsHeld(members, now)).toBeLessThanOrEqual(limit);
          const held = members.filter((m) => holdsSeat(m, now)).map((m) => m.seatNo);
          expect(new Set(held).size).toBe(held.length);
          expect(held.every((s) => s >= 1 && s <= limit)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("seat entitlement", () => {
  const base = {
    groupStatus: "ACTIVE" as const,
    ownerEntitlementEndMs: T0 + 30 * DAY_MS,
    ownerPeriodEndMs: T0 + 30 * DAY_MS,
    familyPlanContinues: true,
    nowMs: T0 + 5 * DAY_MS,
  };
  it("ends at the owner's paid-through instant, exactly", () => {
    expect(seatEntitlementEndsAt({ ...base, member: accepted(1, 2) })).toBe(T0 + 30 * DAY_MS);
    expect(seatEntitlementEndsAt({ ...base, member: accepted(1, 2), nowMs: T0 + 30 * DAY_MS })).toBeNull();
  });
  it("a removed seat ends at its own end; invited, ended and owner rows never entitle", () => {
    const removed = endSeat(accepted(1, 2), "owner", T0 + 3 * DAY_MS, T0 + 20 * DAY_MS);
    expect(seatEntitlementEndsAt({ ...base, member: removed })).toBe(T0 + 20 * DAY_MS);
    expect(seatEntitlementEndsAt({ ...base, member: invited(2, 3) })).toBeNull();
    expect(seatEntitlementEndsAt({ ...base, member: endMemberWithGroup(accepted(3, 3)) })).toBeNull();
    expect(seatEntitlementEndsAt({ ...base, member: owner })).toBeNull();
  });
  it("a scheduled downgrade off the family plan stops the seat at the current period end", () => {
    const r = seatEntitlementEndsAt({
      ...base,
      member: accepted(1, 2),
      ownerEntitlementEndMs: T0 + 400 * DAY_MS,
      familyPlanContinues: false,
    });
    expect(r).toBe(T0 + 30 * DAY_MS);
  });
  it("an ended group and an unentitled owner give nothing", () => {
    expect(seatEntitlementEndsAt({ ...base, member: accepted(1, 2), groupStatus: "ENDED" })).toBeNull();
    expect(seatEntitlementEndsAt({ ...base, member: accepted(1, 2), ownerEntitlementEndMs: null })).toBeNull();
  });
});

describe("plan terms", () => {
  const plan = (over: Partial<PlusPlan>): PlusPlan => ({
    id: "p",
    code: "plus_family",
    interval: "year",
    priceMinor: 120_000n,
    version: 1,
    active: true,
    trialDays: 0,
    effectiveFromMs: 0,
    notifiedAtMs: null,
    ...over,
  });
  it("only family plans have a seat limit, clamped to 1..8", () => {
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 4 }))).toBe(4);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 99 }))).toBe(8);
    expect(seatLimitOf(plan({ kind: "family", seatLimit: 0 }))).toBe(1);
    expect(seatLimitOf(plan({ kind: "family" }))).toBe(4);
    expect(seatLimitOf(plan({}))).toBeNull();
    expect(seatLimitOf(plan({ kind: "student" }))).toBeNull();
  });
  it("family marketing is derived: 4 x 800 - 1,200 = 2,000 EGP, never invented", () => {
    expect(familyMarketing({ individualYearlyMinor: 80_000n, familyYearlyMinor: 120_000n, seatLimit: 4 })).toEqual({
      seats: 4,
      savingMinor: 200_000n,
    });
    expect(familyMarketing({ individualYearlyMinor: 80_000n, familyYearlyMinor: 400_000n, seatLimit: 4 }).savingMinor).toBe(0n);
    expect(() => familyMarketing({ individualYearlyMinor: 0n, familyYearlyMinor: 1n, seatLimit: 4 })).toThrow();
  });
});
