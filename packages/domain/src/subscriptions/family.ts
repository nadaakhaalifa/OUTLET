import { defineMachine } from "../state-machine/machine";
import { SubscriptionRuleError } from "./errors";
import { DAY_MS, type PlusPlan } from "./types";
import { meetsMinAge } from "./rules";

/**
 * Family plan seats (spec P3-03). Pure, no I/O. The owner is the billing party and holds seat 1;
 * members receive benefits only. Everything here is deterministic in `nowMs`.
 *
 * Seat accounting, two options compared: (a) count rows by status at read time; (b) a stored
 * counter. A counter can drift and needs its own reconciliation, while (a) is derivable from the
 * member rows that persistence already protects with a unique (group, seat_no) index. Chosen: (a).
 */

export const FAMILY_SEAT_LIMIT_DEFAULT = 4;
export const FAMILY_SEAT_LIMIT_MAX = 8;
export const FAMILY_INVITE_TTL_DAYS = 7;
export const SEAT_CHURN_WINDOW_DAYS = 90;
export const SEAT_CHURN_MAX = 2;
/** The adult floor of §B6: a member is never below 18 whatever the Plus gate says. */
export const FAMILY_MEMBER_FLOOR_AGE = 18;

// ---- member state machine --------------------------------------------------------------------

export const FAMILY_MEMBER_STATES = ["INVITED", "ACTIVE", "REMOVED", "ENDED"] as const;
export type FamilyMemberState = (typeof FAMILY_MEMBER_STATES)[number];

export const FAMILY_MEMBER_EVENTS = [
  "ACCEPT",
  "REVOKE",
  "INVITE_EXPIRED",
  "REMOVE",
  "LEAVE",
  "SEAT_ENDED",
  "GROUP_ENDED",
] as const;
export type FamilyMemberEvent = (typeof FAMILY_MEMBER_EVENTS)[number];

/** REMOVED still holds the seat and the benefit until `seatEndAtMs`; ENDED is terminal and frees the seat. */
export const familyMemberMachine = defineMachine<FamilyMemberState, FamilyMemberEvent>({
  name: "FamilyMember",
  states: FAMILY_MEMBER_STATES,
  events: FAMILY_MEMBER_EVENTS,
  initial: "INVITED",
  terminal: ["ENDED"],
  transitions: {
    INVITED: {
      ACCEPT: { to: "ACTIVE" },
      REVOKE: { to: "ENDED" },
      INVITE_EXPIRED: { to: "ENDED" },
      GROUP_ENDED: { to: "ENDED" },
    },
    ACTIVE: {
      REMOVE: { to: "REMOVED" },
      LEAVE: { to: "REMOVED" },
      GROUP_ENDED: { to: "ENDED" },
    },
    REMOVED: {
      SEAT_ENDED: { to: "ENDED" },
      GROUP_ENDED: { to: "ENDED" },
    },
    ENDED: {},
  },
});

export const FAMILY_GROUP_STATES = ["ACTIVE", "ENDED"] as const;
export type FamilyGroupState = (typeof FAMILY_GROUP_STATES)[number];
export const FAMILY_GROUP_EVENTS = ["TERMINATE"] as const;
export type FamilyGroupEvent = (typeof FAMILY_GROUP_EVENTS)[number];

export const familyGroupMachine = defineMachine<FamilyGroupState, FamilyGroupEvent>({
  name: "FamilyGroup",
  states: FAMILY_GROUP_STATES,
  events: FAMILY_GROUP_EVENTS,
  initial: "ACTIVE",
  terminal: ["ENDED"],
  transitions: { ACTIVE: { TERMINATE: { to: "ENDED" } }, ENDED: {} },
});

// ---- records ---------------------------------------------------------------------------------

export type FamilyRole = "owner" | "member";
export type RemovedBy = "owner" | "self" | "system";

export interface FamilyGroup {
  readonly id: string;
  readonly ownerUserId: string;
  readonly subscriptionId: string;
  /** Snapshot of the plan version's seat limit at creation, owner included. */
  readonly seatLimit: number;
  readonly status: FamilyGroupState;
  readonly endingNoticeSentAtMs: number | null;
  readonly createdAtMs: number;
  readonly version: number;
}

export interface FamilyMember {
  readonly id: string;
  readonly groupId: string;
  /** Null while an invite is pending: the invitee has no seat identity until acceptance. */
  readonly userId: string | null;
  readonly role: FamilyRole;
  readonly status: FamilyMemberState;
  readonly seatNo: number;
  /** Owner-supplied label shown only to the owner. Never a name from the invitee's account. */
  readonly nickname: string | null;
  readonly invitedAtMs: number;
  readonly inviteExpiresAtMs: number | null;
  readonly seatEffectiveFromMs: number | null;
  readonly seatEndAtMs: number | null;
  readonly removedAtMs: number | null;
  readonly removedBy: RemovedBy | null;
}

export interface FamilyInvite {
  readonly id: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly inviteePhoneHash: string;
  readonly tokenHash: string;
  readonly expiresAtMs: number;
  readonly acceptedAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly createdAtMs: number;
}

// ---- seat accounting -------------------------------------------------------------------------

/** Does this row occupy a seat at `nowMs`? Pending invites hold one while unexpired. */
export function holdsSeat(m: FamilyMember, nowMs: number): boolean {
  switch (m.status) {
    case "ACTIVE":
      return true;
    case "INVITED":
      return m.inviteExpiresAtMs === null || nowMs < m.inviteExpiresAtMs;
    case "REMOVED":
      return m.seatEndAtMs === null || nowMs < m.seatEndAtMs;
    case "ENDED":
      return false;
  }
}

export function seatsHeld(members: readonly FamilyMember[], nowMs: number): number {
  return members.filter((m) => holdsSeat(m, nowMs)).length;
}

/** The lowest free seat number in 1..limit, or null when the group is full. */
export function nextFreeSeat(members: readonly FamilyMember[], nowMs: number, seatLimit: number): number | null {
  const taken = new Set(members.filter((m) => holdsSeat(m, nowMs)).map((m) => m.seatNo));
  for (let n = 1; n <= seatLimit; n += 1) if (!taken.has(n)) return n;
  return null;
}

/** Removals inside the rolling window: the seat-trading signal (a seat sold, then resold). */
export function seatChurn(members: readonly FamilyMember[], nowMs: number): number {
  const from = nowMs - SEAT_CHURN_WINDOW_DAYS * DAY_MS;
  return members.filter((m) => m.removedAtMs !== null && m.removedAtMs > from).length;
}

/** A plan's seat limit, clamped to the supported range. Non family plans have none. */
export function seatLimitOf(plan: PlusPlan): number | null {
  if (plan.kind !== "family") return null;
  const n = plan.seatLimit ?? FAMILY_SEAT_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.trunc(n), 1), FAMILY_SEAT_LIMIT_MAX);
}

/** A member's age gate: the Plus policy age, and never below the adult floor of 18. */
export function memberAgeOk(ageYears: number | null, plusMinAge: number): boolean {
  return meetsMinAge(ageYears, Math.max(plusMinAge, FAMILY_MEMBER_FLOOR_AGE));
}

// ---- operations (pure state changes; persistence applies them atomically) --------------------

export type InviteRefusal =
  | "group_ended"
  | "owner_not_entitled"
  | "seats_full"
  | "seat_churn_limit"
  | "age_gate"
  | "already_in_family";

export type InviteDecision =
  | { readonly ok: true; readonly seatNo: number }
  | { readonly ok: false; readonly reason: InviteRefusal };

export function decideInvite(i: {
  readonly group: FamilyGroup;
  readonly members: readonly FamilyMember[];
  readonly nowMs: number;
  readonly ownerEntitled: boolean;
  /** Age of the invitee when their account is already known; null when unknown (checked at accept). */
  readonly knownInviteeAgeYears: number | null | "unknown";
  readonly plusMinAge: number;
  readonly inviteeAlreadyInAFamily: boolean;
}): InviteDecision {
  if (i.group.status !== "ACTIVE") return { ok: false, reason: "group_ended" };
  if (!i.ownerEntitled) return { ok: false, reason: "owner_not_entitled" };
  if (i.knownInviteeAgeYears !== "unknown" && !memberAgeOk(i.knownInviteeAgeYears, i.plusMinAge)) {
    return { ok: false, reason: "age_gate" };
  }
  if (i.inviteeAlreadyInAFamily) return { ok: false, reason: "already_in_family" };
  const seatNo = nextFreeSeat(i.members, i.nowMs, i.group.seatLimit);
  if (seatNo === null) return { ok: false, reason: "seats_full" };
  if (seatChurn(i.members, i.nowMs) >= SEAT_CHURN_MAX) return { ok: false, reason: "seat_churn_limit" };
  return { ok: true, seatNo };
}

export function newInvitedMember(i: {
  readonly id: string;
  readonly groupId: string;
  readonly seatNo: number;
  readonly nickname: string | null;
  readonly nowMs: number;
}): FamilyMember {
  return {
    id: i.id,
    groupId: i.groupId,
    userId: null,
    role: "member",
    status: familyMemberMachine.initial,
    seatNo: i.seatNo,
    nickname: i.nickname,
    invitedAtMs: i.nowMs,
    inviteExpiresAtMs: i.nowMs + FAMILY_INVITE_TTL_DAYS * DAY_MS,
    seatEffectiveFromMs: null,
    seatEndAtMs: null,
    removedAtMs: null,
    removedBy: null,
  };
}

export function ownerMember(i: { readonly id: string; readonly groupId: string; readonly userId: string; readonly nowMs: number }): FamilyMember {
  return {
    id: i.id,
    groupId: i.groupId,
    userId: i.userId,
    role: "owner",
    status: "ACTIVE",
    seatNo: 1,
    nickname: null,
    invitedAtMs: i.nowMs,
    inviteExpiresAtMs: null,
    seatEffectiveFromMs: i.nowMs,
    seatEndAtMs: null,
    removedAtMs: null,
    removedBy: null,
  };
}

export function acceptMember(m: FamilyMember, userId: string, nowMs: number): FamilyMember {
  if (m.role !== "member") throw new SubscriptionRuleError("only a member seat can be accepted");
  if (m.inviteExpiresAtMs !== null && nowMs >= m.inviteExpiresAtMs) throw new SubscriptionRuleError("invite expired");
  const status = familyMemberMachine.transition(m.status, "ACCEPT");
  return { ...m, status, userId, inviteExpiresAtMs: null, seatEffectiveFromMs: nowMs };
}

/**
 * Removal and leaving free the seat at the next cycle: the row keeps the seat and the benefit until
 * `seatEndAtMs`, which is the paid-through instant of the owner's subscription (never in the past).
 */
export function endSeat(m: FamilyMember, by: RemovedBy, nowMs: number, ownerPaidThroughMs: number | null): FamilyMember {
  if (m.role === "owner") throw new SubscriptionRuleError("the owner seat cannot be removed");
  const status = familyMemberMachine.transition(m.status, by === "self" ? "LEAVE" : "REMOVE");
  const end = Math.max(ownerPaidThroughMs ?? nowMs, nowMs);
  return { ...m, status, removedAtMs: nowMs, removedBy: by, seatEndAtMs: end };
}

export function revokeInvite(m: FamilyMember): FamilyMember {
  return { ...m, status: familyMemberMachine.transition(m.status, "REVOKE") };
}

/** Housekeeping the sweeper applies: expired invites and seats whose end has passed become ENDED. */
export function settleMember(m: FamilyMember, nowMs: number): FamilyMember {
  if (m.status === "INVITED" && m.inviteExpiresAtMs !== null && nowMs >= m.inviteExpiresAtMs) {
    return { ...m, status: familyMemberMachine.transition(m.status, "INVITE_EXPIRED") };
  }
  if (m.status === "REMOVED" && m.seatEndAtMs !== null && nowMs >= m.seatEndAtMs) {
    return { ...m, status: familyMemberMachine.transition(m.status, "SEAT_ENDED") };
  }
  return m;
}

export function endMemberWithGroup(m: FamilyMember): FamilyMember {
  return m.status === "ENDED" ? m : { ...m, status: familyMemberMachine.transition(m.status, "GROUP_ENDED") };
}

// ---- entitlement -----------------------------------------------------------------------------

/**
 * The instant until which a seat entitles its holder, or null. The owner's paid-through instant
 * bounds it (cancel, refund, grace), and a removed or leaving seat ends at its own `seatEndAtMs`.
 * `ownerPlanIsFamilyAtEnd` is false once a downgrade to a non family plan is scheduled: the group's
 * benefit then stops at the current period end instead of following the owner's new plan.
 */
export function seatEntitlementEndsAt(i: {
  readonly member: FamilyMember;
  readonly groupStatus: FamilyGroupState;
  readonly ownerEntitlementEndMs: number | null;
  readonly ownerPeriodEndMs: number;
  readonly familyPlanContinues: boolean;
  readonly nowMs: number;
}): number | null {
  if (i.groupStatus !== "ACTIVE") return null;
  if (i.member.role !== "member") return null;
  if (i.member.status !== "ACTIVE" && i.member.status !== "REMOVED") return null;
  if (i.member.seatEffectiveFromMs === null || i.nowMs < i.member.seatEffectiveFromMs) return null;
  if (i.ownerEntitlementEndMs === null) return null;
  let end = i.ownerEntitlementEndMs;
  if (!i.familyPlanContinues) end = Math.min(end, i.ownerPeriodEndMs);
  if (i.member.status === "REMOVED" && i.member.seatEndAtMs !== null) end = Math.min(end, i.member.seatEndAtMs);
  return end > i.nowMs ? end : null;
}

/**
 * "Pay once for up to N adults" arithmetic, derived from real prices only: N x the individual
 * yearly price minus the family price. Zero when the family plan is not actually cheaper.
 */
export function familyMarketing(i: {
  readonly individualYearlyMinor: bigint;
  readonly familyYearlyMinor: bigint;
  readonly seatLimit: number;
}): { readonly seats: number; readonly savingMinor: bigint } {
  if (i.individualYearlyMinor <= 0n || i.familyYearlyMinor <= 0n || i.seatLimit < 1) {
    throw new SubscriptionRuleError("prices must be positive and seats at least one");
  }
  const separate = i.individualYearlyMinor * BigInt(i.seatLimit);
  return { seats: i.seatLimit, savingMinor: separate > i.familyYearlyMinor ? separate - i.familyYearlyMinor : 0n };
}
