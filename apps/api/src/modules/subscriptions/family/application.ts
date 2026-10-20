import {
  DAY_MS,
  acceptMember,
  cancel,
  decideInvite,
  endMemberWithGroup,
  endSeat,
  entitlementEndsAt,
  expireStudent,
  familyGroupMachine,
  isEntitled,
  memberAgeOk,
  newInvitedMember,
  ownerMember,
  rejectStudent,
  revokeInvite,
  seatEntitlementEndsAt,
  seatLimitOf,
  selectPlanVersion,
  studentLapsed,
  studentPriceApplies,
  verifyStudent,
  STUDENT_NOTICE_DAYS,
  InvalidSubscriptionTransition,
  SubscriptionRuleError,
  type FamilyGroup,
  type FamilyInvite,
  type FamilyMember,
  type InviteRefusal,
  type PlanKind,
  type PlusPlan,
  type PlusSubscription,
  type StudentVerification,
} from "../domain/bridge";
import { PLUS_FLAGS } from "../domain/ports";
import { applyTransition, type PlusDeps } from "../application/shared";
import type { Subscribe, SubscribeInput, SubscribeResult } from "../application/subscribe";
import type {
  FamilyEvent,
  FamilyIdentityPort,
  FamilyInviteDeliveryPort,
  FamilyStore,
  InviteTokenPort,
  StudentEligibilityPort,
  StudentStartMethod,
  StudentStore,
  StudentVerifierPort,
} from "./ports";

export const kindOf = (plan: PlusPlan | null): PlanKind => plan?.kind ?? "individual";

export interface FamilyDeps {
  readonly plus: PlusDeps;
  readonly family: FamilyStore;
  readonly students: StudentStore;
  readonly identity: FamilyIdentityPort;
  readonly delivery: FamilyInviteDeliveryPort;
  readonly tokens: InviteTokenPort;
  readonly verifier: StudentVerifierPort;
}

const inviteTokenKey = (token: string): string => `family-invite:${token}`;

// ---- views -----------------------------------------------------------------------------------

export interface OwnerSeatView {
  readonly id: string;
  readonly role: "owner" | "member";
  readonly status: FamilyMember["status"];
  readonly nickname: string | null;
  readonly seatNo: number;
  readonly seatEffectiveFromMs: number | null;
  readonly seatEndAtMs: number | null;
  readonly inviteExpiresAtMs: number | null;
}

export type FamilyView =
  | {
      readonly role: "owner";
      readonly groupId: string;
      readonly status: FamilyGroup["status"];
      readonly seatLimit: number;
      readonly seatsHeld: number;
      readonly seatsFree: number;
      readonly members: readonly OwnerSeatView[];
      readonly seatChangesInWindow: number;
    }
  | {
      readonly role: "member";
      readonly groupId: string;
      readonly status: FamilyGroup["status"];
      readonly seatStatus: FamilyMember["status"];
      readonly seatEffectiveFromMs: number | null;
      readonly seatEndAtMs: number | null;
      readonly entitlementEndsAtMs: number | null;
    };

/** The family plan code on sale now, if any (the lowest code when an admin runs several). */
export async function currentFamilyPlan(d: PlusDeps, nowMs: number): Promise<PlusPlan | null> {
  const all = await d.store.listPlanVersions();
  const codes = [...new Set(all.filter((p) => kindOf(p) === "family").map((p) => p.code))].sort();
  for (const code of codes) {
    const p = selectPlanVersion(all.filter((x) => x.code === code), nowMs);
    if (p !== null) return p;
  }
  return null;
}

/** Creates the group of an owner's live family subscription once. Idempotent and race safe. */
export async function ensureGroup(d: FamilyDeps, userId: string): Promise<FamilyGroup | null> {
  const existing = await d.family.getGroupByOwner(userId);
  if (existing !== null) return existing;
  const sub = await d.plus.store.getLiveByUser(userId);
  if (sub === null) return null;
  const plan = await d.plus.store.getPlan(sub.planId);
  const limit = plan === null ? null : seatLimitOf(plan);
  if (plan === null || kindOf(plan) !== "family" || limit === null) return null;
  const now = d.plus.clock.nowMs();
  const group: FamilyGroup = {
    id: d.plus.ids.uuidV7(),
    ownerUserId: userId,
    subscriptionId: sub.id,
    seatLimit: limit,
    status: familyGroupMachine.initial,
    endingNoticeSentAtMs: null,
    createdAtMs: now,
    version: 0,
  };
  const owner = ownerMember({ id: d.plus.ids.uuidV7(), groupId: group.id, userId, nowMs: now });
  const r = await d.family.createGroup(group, owner, [
    { type: "family.created", groupId: group.id, ownerUserId: userId, subscriptionId: sub.id, seatLimit: limit },
  ]);
  if (r === "ok") return group;
  return d.family.getGroupByOwner(userId);
}

/**
 * The seat a user holds now. A removed seat whose end has passed is settled first, so the user is
 * free to join another family without waiting for the sweeper.
 */
async function activeMembership(d: FamilyDeps, userId: string, nowMs: number) {
  let ms = await d.family.membershipOf(userId);
  if (ms !== null && ms.member.status === "REMOVED" && ms.member.seatEndAtMs !== null && ms.member.seatEndAtMs <= nowMs) {
    await d.family.mutateGroup(ms.group.id, nowMs, () => ({ result: null, events: [] }));
    ms = await d.family.membershipOf(userId);
  }
  return ms !== null && ms.member.status === "REMOVED" && ms.member.seatEndAtMs !== null && ms.member.seatEndAtMs <= nowMs ? null : ms;
}

async function ownerPaidThrough(d: FamilyDeps, group: FamilyGroup, nowMs: number): Promise<number> {
  const sub = await d.plus.store.getSubscription(group.subscriptionId);
  if (sub === null) return nowMs;
  return Math.max(entitlementEndsAt(sub) ?? sub.periodEndMs, nowMs);
}

// ---- create, view ----------------------------------------------------------------------------

export type CreateFamilyResult =
  | SubscribeResult
  | { readonly kind: "family_unavailable" }
  | { readonly kind: "wrong_plan" };

/** Subscribes the caller to the family plan on sale, then opens the group (also repaired lazily). */
export class CreateFamily {
  constructor(
    private readonly d: FamilyDeps,
    private readonly subscribe: Subscribe,
  ) {}

  async execute(i: Omit<SubscribeInput, "planCode">): Promise<CreateFamilyResult> {
    const d = this.d;
    if (!(await d.plus.flags.enabled(PLUS_FLAGS.family))) return { kind: "family_unavailable" };
    const plan = await currentFamilyPlan(d.plus, d.plus.clock.nowMs());
    if (plan === null) return { kind: "family_unavailable" };
    const live = await d.plus.store.getLiveByUser(i.userId);
    if (live !== null && live.planCode !== plan.code) {
      const livePlan = await d.plus.store.getPlan(live.planId);
      if (kindOf(livePlan) !== "family") return { kind: "wrong_plan" };
    }
    const r = await this.subscribe.execute({ ...i, planCode: plan.code });
    if (r.kind === "subscribed" || r.kind === "existing") await ensureGroup(d, i.userId);
    return r;
  }
}

export class GetFamily {
  constructor(private readonly d: FamilyDeps) {}

  async execute(userId: string): Promise<FamilyView | null> {
    const d = this.d;
    const now = d.plus.clock.nowMs();
    const group = (await ensureGroup(d, userId)) ?? null;
    if (group !== null) {
      const members = await d.family.listMembers(group.id);
      const held = members.filter((m) => holdsNow(m, now));
      const removed = members.filter((m) => m.removedAtMs !== null && m.removedAtMs > now - 90 * DAY_MS).length;
      return {
        role: "owner",
        groupId: group.id,
        status: group.status,
        seatLimit: group.seatLimit,
        seatsHeld: held.length,
        seatsFree: Math.max(group.seatLimit - held.length, 0),
        seatChangesInWindow: removed,
        members: members
          .filter((m) => m.status !== "ENDED")
          .map((m) => ({
            id: m.id,
            role: m.role,
            status: m.status,
            nickname: m.nickname,
            seatNo: m.seatNo,
            seatEffectiveFromMs: m.seatEffectiveFromMs,
            seatEndAtMs: m.seatEndAtMs,
            inviteExpiresAtMs: m.inviteExpiresAtMs,
          })),
      };
    }
    const ms = await d.family.membershipOf(userId);
    if (ms === null) return null;
    const end = await new FamilySeatEntitlements(d).endsAt(userId);
    return {
      role: "member",
      groupId: ms.group.id,
      status: ms.group.status,
      seatStatus: ms.member.status,
      seatEffectiveFromMs: ms.member.seatEffectiveFromMs,
      seatEndAtMs: ms.member.seatEndAtMs,
      entitlementEndsAtMs: end,
    };
  }
}

const holdsNow = (m: FamilyMember, now: number): boolean =>
  m.status === "ACTIVE" ||
  (m.status === "INVITED" && (m.inviteExpiresAtMs === null || now < m.inviteExpiresAtMs)) ||
  (m.status === "REMOVED" && (m.seatEndAtMs === null || now < m.seatEndAtMs));

// ---- seat entitlement ------------------------------------------------------------------------

/** Time based truth for family seats: computed from the owner's subscription at the instant asked. */
export class FamilySeatEntitlements {
  constructor(private readonly d: FamilyDeps) {}

  async endsAt(userId: string): Promise<number | null> {
    const d = this.d;
    const now = d.plus.clock.nowMs();
    const ms = await d.family.membershipOf(userId);
    if (ms === null || ms.member.role !== "member") return null;
    const sub = await d.plus.store.getSubscription(ms.group.subscriptionId);
    if (sub === null) return null;
    const continues = await this.familyPlanContinues(sub, now);
    return seatEntitlementEndsAt({
      member: ms.member,
      groupStatus: ms.group.status,
      ownerEntitlementEndMs: entitlementEndsAt(sub),
      ownerPeriodEndMs: sub.periodEndMs,
      familyPlanContinues: continues,
      nowMs: now,
    });
  }

  private async familyPlanContinues(sub: PlusSubscription, now: number): Promise<boolean> {
    const current = kindOf(await this.d.plus.store.getPlan(sub.planId));
    if (current !== "family") return false;
    if (sub.pendingPlanCode === null) return true;
    const pending = selectPlanVersion(await this.d.plus.store.listPlanVersions(sub.pendingPlanCode), now);
    return kindOf(pending) === "family";
  }
}

// ---- invite ----------------------------------------------------------------------------------

export type InviteResult =
  | { readonly kind: "invited"; readonly memberId: string; readonly inviteId: string; readonly expiresAtMs: number }
  | { readonly kind: "family_unavailable" }
  | { readonly kind: "not_owner" }
  | { readonly kind: "refused"; readonly reason: InviteRefusal | "self_invite" | "already_invited"; readonly minAge?: number }
  | { readonly kind: "delivery_failed" }
  | { readonly kind: "conflict" };

export class InviteMember {
  constructor(private readonly d: FamilyDeps) {}

  async execute(i: { readonly ownerUserId: string; readonly phoneE164: string; readonly nickname: string | null }): Promise<InviteResult> {
    const d = this.d;
    if (!(await d.plus.flags.enabled(PLUS_FLAGS.family))) return { kind: "family_unavailable" };
    const now = d.plus.clock.nowMs();
    const group = await ensureGroup(d, i.ownerUserId);
    if (group === null) return { kind: "not_owner" };
    const sub = await d.plus.store.getSubscription(group.subscriptionId);
    const ownerEntitled = sub !== null && isEntitled(sub, now);

    const phoneHash = d.identity.hashPhone(i.phoneE164);
    const ownerPhone = await d.plus.persons.phoneHash(i.ownerUserId);
    if (ownerPhone !== null && ownerPhone === phoneHash) return { kind: "refused", reason: "self_invite" };

    const plusMinAge = await d.plus.ages.plusMinAge();
    const inviteeId = await d.identity.userIdByPhoneHash(phoneHash);
    const knownAge = inviteeId === null ? ("unknown" as const) : await d.plus.ages.ageYears(inviteeId);
    const inFamily = inviteeId !== null && (await activeMembership(d, inviteeId, now)) !== null;

    const token = d.tokens.newToken();
    const memberId = d.plus.ids.uuidV7();
    const inviteId = d.plus.ids.uuidV7();
    const tokenHash = d.plus.hasher.hash(inviteTokenKey(token));

    const out = await d.family.mutateGroup(group.id, now, (ctx) => {
      const pendingSame = ctx.invites.some((inv) => {
        if (inv.inviteePhoneHash !== phoneHash) return false;
        const m = ctx.members.find((x) => x.id === inv.memberId);
        return m !== undefined && m.status === "INVITED";
      });
      if (pendingSame) return { result: { kind: "refused", reason: "already_invited" } as InviteResult, events: [] };
      const decision = decideInvite({
        group: ctx.group,
        members: ctx.members,
        nowMs: now,
        ownerEntitled,
        knownInviteeAgeYears: knownAge,
        plusMinAge,
        inviteeAlreadyInAFamily: inFamily,
      });
      if (!decision.ok) {
        const minAge = decision.reason === "age_gate" ? Math.max(plusMinAge, 18) : undefined;
        return {
          result: { kind: "refused", reason: decision.reason, ...(minAge !== undefined ? { minAge } : {}) } as InviteResult,
          events: [],
        };
      }
      const member = newInvitedMember({ id: memberId, groupId: group.id, seatNo: decision.seatNo, nickname: i.nickname, nowMs: now });
      const invite: FamilyInvite = {
        id: inviteId,
        groupId: group.id,
        memberId,
        inviteePhoneHash: phoneHash,
        tokenHash,
        expiresAtMs: member.inviteExpiresAtMs ?? now,
        acceptedAtMs: null,
        revokedAtMs: null,
        createdAtMs: now,
      };
      const events: FamilyEvent[] = [{ type: "family.member_invited", groupId: group.id, memberId }];
      return {
        result: { kind: "invited", memberId, inviteId, expiresAtMs: invite.expiresAtMs } as InviteResult,
        members: [member],
        invites: [invite],
        events,
      };
    });
    if (out.kind === "not_found") return { kind: "not_owner" };
    if (out.kind === "conflict") return { kind: "conflict" };
    const result = out.result;
    if (result.kind !== "invited") return result;

    const sent = await d.delivery.deliver({ phoneE164: i.phoneE164, token, expiresAtMs: result.expiresAtMs });
    if (sent.kind === "failed") {
      await this.release(group.id, memberId, now);
      return { kind: "delivery_failed" };
    }
    return result;
  }

  private async release(groupId: string, memberId: string, now: number): Promise<void> {
    await this.d.family.mutateGroup(groupId, now, (ctx) => {
      const m = ctx.members.find((x) => x.id === memberId);
      const inv = ctx.invites.find((x) => x.memberId === memberId);
      if (m === undefined || m.status !== "INVITED" || inv === undefined) return { result: null, events: [] };
      return {
        result: null,
        members: [revokeInvite(m)],
        invites: [{ ...inv, revokedAtMs: now }],
        events: [{ type: "family.invite_revoked", groupId, memberId }],
      };
    });
  }
}

export type RevokeResult = { readonly kind: "revoked" } | { readonly kind: "not_found" };

/** Owner revokes a pending invite. The id must belong to the caller's own group, else 404. */
export class RevokeInvite {
  constructor(private readonly d: FamilyDeps) {}
  async execute(ownerUserId: string, memberId: string): Promise<RevokeResult> {
    const d = this.d;
    const now = d.plus.clock.nowMs();
    const group = await d.family.getGroupByOwner(ownerUserId);
    if (group === null) return { kind: "not_found" };
    const out = await d.family.mutateGroup(group.id, now, (ctx) => {
      const m = ctx.members.find((x) => x.id === memberId);
      const inv = ctx.invites.find((x) => x.memberId === memberId);
      if (m === undefined || m.status !== "INVITED" || inv === undefined) return { result: false, events: [] };
      return {
        result: true,
        members: [revokeInvite(m)],
        invites: [{ ...inv, revokedAtMs: now }],
        events: [{ type: "family.invite_revoked", groupId: group.id, memberId }],
      };
    });
    return out.kind === "applied" && out.result ? { kind: "revoked" } : { kind: "not_found" };
  }
}

// ---- accept ----------------------------------------------------------------------------------

export type AcceptResult =
  | { readonly kind: "accepted"; readonly groupId: string; readonly ownPlanEnding: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "family_unavailable" }
  | { readonly kind: "invite_expired" }
  | { readonly kind: "invite_unavailable" }
  | { readonly kind: "age_gate"; readonly minAge: number }
  | { readonly kind: "already_in_family" }
  | { readonly kind: "owner_not_entitled" }
  | { readonly kind: "existing_plan_choice_required" }
  | { readonly kind: "conflict" };

export class AcceptInvite {
  constructor(private readonly d: FamilyDeps) {}

  async execute(i: {
    readonly userId: string;
    readonly token: string;
    readonly existingPlan: "end_at_period_end" | null;
  }): Promise<AcceptResult> {
    const d = this.d;
    if (!(await d.plus.flags.enabled(PLUS_FLAGS.family))) return { kind: "family_unavailable" };
    const now = d.plus.clock.nowMs();
    const found = await d.family.findInviteByTokenHash(d.plus.hasher.hash(inviteTokenKey(i.token)));
    if (found === null) return { kind: "not_found" };
    // Identity first and uniformly: only the OTP verified owner of the invited phone learns anything else.
    const phoneHash = await d.plus.persons.phoneHash(i.userId);
    if (phoneHash === null || phoneHash !== found.invite.inviteePhoneHash || !(await d.identity.phoneVerified(i.userId))) {
      return { kind: "not_found" };
    }
    if (found.invite.revokedAtMs !== null || found.invite.acceptedAtMs !== null || found.member.status !== "INVITED" || found.group.status !== "ACTIVE") {
      return found.member.status === "INVITED" && now >= found.invite.expiresAtMs ? { kind: "invite_expired" } : { kind: "invite_unavailable" };
    }
    if (now >= found.invite.expiresAtMs) return { kind: "invite_expired" };

    const plusMinAge = await d.plus.ages.plusMinAge();
    if (!memberAgeOk(await d.plus.ages.ageYears(i.userId), plusMinAge)) {
      return { kind: "age_gate", minAge: Math.max(plusMinAge, 18) };
    }
    if (found.group.ownerUserId === i.userId || (await activeMembership(d, i.userId, now)) !== null) {
      return { kind: "already_in_family" };
    }
    const ownerSub = await d.plus.store.getSubscription(found.group.subscriptionId);
    if (ownerSub === null || !isEntitled(ownerSub, now)) return { kind: "owner_not_entitled" };

    const own = await d.plus.store.getLiveByUser(i.userId);
    if (own !== null && i.existingPlan === null) return { kind: "existing_plan_choice_required" };

    const out = await d.family.mutateGroup(found.group.id, now, (ctx) => {
      const m = ctx.members.find((x) => x.id === found.member.id);
      const inv = ctx.invites.find((x) => x.id === found.invite.id);
      if (ctx.group.status !== "ACTIVE" || m === undefined || inv === undefined || m.status !== "INVITED") {
        return { result: { kind: "invite_unavailable" } as AcceptResult, events: [] };
      }
      if (inv.revokedAtMs !== null || inv.acceptedAtMs !== null) {
        return { result: { kind: "invite_unavailable" } as AcceptResult, events: [] };
      }
      if (m.inviteExpiresAtMs !== null && now >= m.inviteExpiresAtMs) {
        return { result: { kind: "invite_expired" } as AcceptResult, events: [] };
      }
      const next = acceptMember(m, i.userId, now);
      return {
        result: { kind: "accepted", groupId: ctx.group.id, ownPlanEnding: false } as AcceptResult,
        members: [next],
        invites: [{ ...inv, acceptedAtMs: now }],
        events: [{ type: "family.member_added", groupId: ctx.group.id, memberId: m.id, userId: i.userId }],
      };
    });
    if (out.kind === "not_found") return { kind: "invite_unavailable" };
    if (out.kind === "conflict") return (await d.family.membershipOf(i.userId)) !== null ? { kind: "already_in_family" } : { kind: "conflict" };
    if (out.result.kind !== "accepted") return out.result;

    let ending = false;
    if (own !== null) ending = await this.endOwnPlan(own, now);
    await d.plus.notices.send({ userId: found.group.ownerUserId, template: "family_member_joined", data: { group_id: found.group.id } });
    return { kind: "accepted", groupId: found.group.id, ownPlanEnding: ending };
  }

  /** "Their own plan ends at period end, no double charge": cancel keeps benefits until the paid instant. */
  private async endOwnPlan(own: PlusSubscription, now: number): Promise<boolean> {
    if (own.status === "CANCELLED_AT_PERIOD_END") return true;
    try {
      const next = cancel(own, now);
      const r = await applyTransition(this.d.plus, own, next, now, [
        { type: "plus.cancel_requested", subscriptionId: own.id, userId: own.userId, effectiveAtMs: next.periodEndMs },
      ]);
      return r === "ok";
    } catch (e) {
      if (e instanceof InvalidSubscriptionTransition || e instanceof SubscriptionRuleError) return false;
      throw e;
    }
  }
}

// ---- remove, leave ---------------------------------------------------------------------------

export type SeatChangeResult =
  | { readonly kind: "ok"; readonly seatEndAtMs: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "owner_cannot_leave" }
  | { readonly kind: "family_unavailable" };

export class RemoveMember {
  constructor(private readonly d: FamilyDeps) {}

  async execute(ownerUserId: string, memberId: string): Promise<SeatChangeResult> {
    const d = this.d;
    if (!(await d.plus.flags.enabled(PLUS_FLAGS.family))) return { kind: "family_unavailable" };
    const now = d.plus.clock.nowMs();
    const group = await d.family.getGroupByOwner(ownerUserId);
    if (group === null) return { kind: "not_found" };
    const paidThrough = await ownerPaidThrough(d, group, now);
    const out = await d.family.mutateGroup(group.id, now, (ctx) => {
      const m = ctx.members.find((x) => x.id === memberId);
      if (m === undefined || m.role !== "member" || m.status !== "ACTIVE" || m.userId === null) {
        return { result: null as { userId: string; seatEndAtMs: number } | null, events: [] };
      }
      const next = endSeat(m, "owner", now, paidThrough);
      return {
        result: { userId: m.userId, seatEndAtMs: next.seatEndAtMs ?? paidThrough },
        members: [next],
        events: [
          { type: "family.member_removed", groupId: ctx.group.id, memberId: m.id, userId: m.userId, by: "owner", seatEndAtMs: next.seatEndAtMs ?? paidThrough },
        ],
      };
    });
    if (out.kind !== "applied" || out.result === null) return { kind: "not_found" };
    await d.plus.notices.send({
      userId: out.result.userId,
      template: "family_member_removed",
      data: { ends_at_ms: out.result.seatEndAtMs },
    });
    return { kind: "ok", seatEndAtMs: out.result.seatEndAtMs };
  }
}

export class LeaveFamily {
  constructor(private readonly d: FamilyDeps) {}

  async execute(userId: string): Promise<SeatChangeResult> {
    const d = this.d;
    if (!(await d.plus.flags.enabled(PLUS_FLAGS.family))) return { kind: "family_unavailable" };
    const now = d.plus.clock.nowMs();
    const ms = await d.family.membershipOf(userId);
    if (ms === null) return { kind: "not_found" };
    if (ms.member.role === "owner") return { kind: "owner_cannot_leave" };
    const paidThrough = await ownerPaidThrough(d, ms.group, now);
    const out = await d.family.mutateGroup(ms.group.id, now, (ctx) => {
      const m = ctx.members.find((x) => x.id === ms.member.id);
      if (m === undefined || m.status !== "ACTIVE" || m.userId !== userId) return { result: null as number | null, events: [] };
      const next = endSeat(m, "self", now, paidThrough);
      const end = next.seatEndAtMs ?? paidThrough;
      return {
        result: end,
        members: [next],
        events: [{ type: "family.member_removed", groupId: ctx.group.id, memberId: m.id, userId, by: "self", seatEndAtMs: end }],
      };
    });
    if (out.kind !== "applied" || out.result === null) return { kind: "not_found" };
    await d.plus.notices.send({ userId: ms.group.ownerUserId, template: "family_member_left", data: { group_id: ms.group.id } });
    return { kind: "ok", seatEndAtMs: out.result };
  }
}

// ---- sweeper and termination -----------------------------------------------------------------

export interface FamilySweepSummary {
  readonly examined: number;
  readonly ended: number;
  readonly noticed: number;
  readonly errors: number;
}

type EndReason = "subscription_ended" | "plan_changed" | "owner_deleted";

async function endGroup(d: FamilyDeps, group: FamilyGroup, reason: EndReason, nowMs: number): Promise<number> {
  const out = await d.family.mutateGroup(group.id, nowMs, (ctx) => {
    if (ctx.group.status !== "ACTIVE") return { result: [] as string[], events: [] };
    const notify = ctx.members.filter((m) => m.role === "member" && m.userId !== null && (m.status === "ACTIVE" || m.status === "REMOVED")).map((m) => m.userId as string);
    return {
      result: notify,
      group: { ...ctx.group, status: familyGroupMachine.transition(ctx.group.status, "TERMINATE") },
      members: ctx.members.filter((m) => m.status !== "ENDED").map(endMemberWithGroup),
      events: [{ type: "family.ended", groupId: ctx.group.id, reason } as FamilyEvent],
    };
  });
  if (out.kind !== "applied") return 0;
  for (const userId of out.result) await d.plus.notices.send({ userId, template: "family_plan_ended", data: { group_id: group.id } });
  return 1;
}

export class RunFamilySweep {
  constructor(private readonly d: FamilyDeps) {}

  async execute(pageSize = 100): Promise<FamilySweepSummary> {
    const d = this.d;
    let examined = 0;
    let ended = 0;
    let noticed = 0;
    let errors = 0;
    let after: string | null = null;
    for (;;) {
      const page = await d.family.listActiveGroups(after, pageSize);
      if (page.length === 0) break;
      for (const g of page) {
        examined += 1;
        try {
          const r = await this.one(g);
          ended += r === "ended" ? 1 : 0;
          noticed += r === "noticed" ? 1 : 0;
        } catch {
          errors += 1;
        }
      }
      after = page[page.length - 1]?.id ?? null;
      if (page.length < pageSize) break;
    }
    return { examined, ended, noticed, errors };
  }

  private async one(g: FamilyGroup): Promise<"ended" | "noticed" | "none"> {
    const d = this.d;
    const now = d.plus.clock.nowMs();
    const sub = await d.plus.store.getSubscription(g.subscriptionId);
    if (sub === null || sub.status === "EXPIRED") {
      await endGroup(d, g, "subscription_ended", now);
      return "ended";
    }
    const current = kindOf(await d.plus.store.getPlan(sub.planId));
    if (current !== "family") {
      await endGroup(d, g, "plan_changed", now);
      return "ended";
    }
    let leaving = sub.status === "CANCELLED_AT_PERIOD_END";
    if (!leaving && sub.pendingPlanCode !== null) {
      const pending = selectPlanVersion(await d.plus.store.listPlanVersions(sub.pendingPlanCode), now);
      leaving = kindOf(pending) !== "family";
    }
    if (!leaving || g.endingNoticeSentAtMs !== null) {
      // Still settles expired invites and elapsed seats inside the lock.
      await d.family.mutateGroup(g.id, now, () => ({ result: null, events: [] }));
      return "none";
    }
    const out = await d.family.mutateGroup(g.id, now, (ctx) => {
      if (ctx.group.endingNoticeSentAtMs !== null) return { result: [] as string[], events: [] };
      const ids = ctx.members.filter((m) => m.role === "member" && m.userId !== null && m.status === "ACTIVE").map((m) => m.userId as string);
      return {
        result: ids,
        group: { ...ctx.group, endingNoticeSentAtMs: now },
        events: [{ type: "family.ending_notified", groupId: ctx.group.id } as FamilyEvent],
      };
    });
    if (out.kind !== "applied") return "none";
    for (const userId of out.result) {
      await d.plus.notices.send({ userId, template: "family_plan_ending", data: { ends_at_ms: sub.periodEndMs } });
    }
    return "noticed";
  }
}

/** Owner account deleted: the plan terminates and members are told (pro-rata refund is the refund policy's). */
export class TerminateFamilyForOwner {
  constructor(private readonly d: FamilyDeps) {}
  async execute(ownerUserId: string): Promise<{ readonly ended: boolean }> {
    const g = await this.d.family.getGroupByOwner(ownerUserId);
    if (g === null) return { ended: false };
    await endGroup(this.d, g, "owner_deleted", this.d.plus.clock.nowMs());
    return { ended: true };
  }
}

// ---- student ---------------------------------------------------------------------------------

export type StudentStartOutcome =
  | { readonly kind: "started"; readonly verificationId: string; readonly clientAction: { readonly type: "redirect"; readonly url: string } }
  | { readonly kind: "student_unavailable" }
  | { readonly kind: "domain_not_allowed" };

export class StartStudentVerification {
  constructor(private readonly d: FamilyDeps) {}

  async execute(i: {
    readonly userId: string;
    readonly method: StudentStartMethod;
    readonly universityEmail: string | null;
  }): Promise<StudentStartOutcome> {
    const d = this.d;
    if (!(await d.plus.flags.enabled(PLUS_FLAGS.student))) return { kind: "student_unavailable" };
    const started = await d.verifier.start({ userId: i.userId, method: i.method, universityEmail: i.universityEmail });
    if (started.kind === "unavailable") return { kind: "student_unavailable" };
    if (started.kind === "domain_not_allowed") return { kind: "domain_not_allowed" };
    const now = d.plus.clock.nowMs();
    const latest = await d.students.latestForUser(i.userId);
    if (latest !== null && latest.status === "PENDING") {
      // A restarted flow supersedes the abandoned one: one pending verification per person.
      await d.students.save(rejectStudent(latest), latest.version, []);
    }
    const v: StudentVerification = {
      id: d.plus.ids.uuidV7(),
      userId: i.userId,
      verifier: d.verifier.name,
      ref: started.ref,
      status: "PENDING",
      verifiedAtMs: null,
      validUntilMs: null,
      noticeSentAtMs: null,
      createdAtMs: now,
      version: 0,
    };
    const r = await d.students.save(v, null, [{ type: "student.verification_started", userId: i.userId, verificationId: v.id }]);
    if (r !== "ok") return { kind: "student_unavailable" };
    return { kind: "started", verificationId: v.id, clientAction: started.clientAction };
  }
}

export type StudentCallbackOutcome =
  | { readonly kind: "applied"; readonly status: StudentVerification["status"] }
  | { readonly kind: "ignored" }
  | { readonly kind: "rejected" };

/** Verifier callback. Idempotent by the verifier reference: a replay finds the settled row and does nothing. */
export class HandleStudentCallback {
  constructor(private readonly d: FamilyDeps) {}

  async execute(i: {
    readonly rawBody: Uint8Array;
    readonly headers: Readonly<Record<string, string | undefined>>;
  }): Promise<StudentCallbackOutcome> {
    const d = this.d;
    const v = await d.verifier.verifyCallback(i);
    if (v.kind === "rejected") return { kind: "rejected" };
    const row = await d.students.getByRef(d.verifier.name, v.callback.ref);
    if (row === null || row.status !== "PENDING") return { kind: "ignored" };
    const now = d.plus.clock.nowMs();
    if (v.callback.kind === "rejected") {
      const next = rejectStudent(row);
      const r = await d.students.save(next, row.version, [{ type: "student.rejected", userId: row.userId, verificationId: row.id }]);
      return r === "ok" ? { kind: "applied", status: next.status } : { kind: "ignored" };
    }
    const next = verifyStudent(row, now, v.callback.validUntilMs);
    const r = await d.students.save(next, row.version, [
      { type: "student.verified", userId: row.userId, verificationId: row.id, validUntilMs: next.validUntilMs ?? now },
    ]);
    return r === "ok" ? { kind: "applied", status: next.status } : { kind: "ignored" };
  }
}

export interface StudentStatusView {
  readonly status: StudentVerification["status"] | "NONE";
  readonly validUntilMs: number | null;
  readonly priceApplies: boolean;
}

export class GetStudentStatus {
  constructor(private readonly d: FamilyDeps) {}
  async execute(userId: string): Promise<StudentStatusView> {
    const now = this.d.plus.clock.nowMs();
    const latest = await this.d.students.latestForUser(userId);
    if (latest === null) return { status: "NONE", validUntilMs: null, priceApplies: false };
    const verified = latest.status === "VERIFIED" ? latest : await this.d.students.latestVerifiedForUser(userId);
    return {
      status: latest.status,
      validUntilMs: latest.validUntilMs ?? verified?.validUntilMs ?? null,
      priceApplies: studentPriceApplies(verified, now),
    };
  }
}

/** Plan gating and renewal price for student plans. Fails closed on any missing evidence. */
export class StudentEligibility implements StudentEligibilityPort {
  constructor(
    private readonly students: StudentStore,
    private readonly notices: PlusDeps["notices"],
    private readonly clock: PlusDeps["clock"],
  ) {}

  async validAt(userId: string, atMs: number): Promise<boolean> {
    return studentPriceApplies(await this.students.latestVerifiedForUser(userId), atMs);
  }

  /**
   * Student price renews while verified. After a lapse the price reverts only once a notice has
   * been out for 30 days; an unnoticed lapse sends the notice now and keeps the student price for
   * this one renewal, so a member is never moved to a higher price silently.
   */
  async renewalPrice(userId: string, atMs: number): Promise<"student" | "individual"> {
    const v = await this.students.latestVerifiedForUser(userId);
    if (v === null) return "individual";
    if (studentPriceApplies(v, atMs)) return "student";
    if (v.noticeSentAtMs !== null && atMs - v.noticeSentAtMs >= STUDENT_NOTICE_DAYS * DAY_MS) return "individual";
    if (v.noticeSentAtMs === null) {
      const now = this.clock.nowMs();
      const r = await this.students.save({ ...v, noticeSentAtMs: now }, v.version, []);
      if (r === "ok") {
        await this.notices.send({ userId, template: "student_status_expiring", data: { valid_until_ms: v.validUntilMs ?? 0 } });
      }
    }
    return "student";
  }
}

export interface StudentSweepSummary {
  readonly noticed: number;
  readonly expired: number;
}

export class RunStudentSweep {
  constructor(private readonly d: FamilyDeps) {}

  async execute(limit = 200): Promise<StudentSweepSummary> {
    const d = this.d;
    const now = d.plus.clock.nowMs();
    let noticed = 0;
    let expired = 0;
    for (const v of await d.students.listNoticeDue(now, limit)) {
      const r = await d.students.save({ ...v, noticeSentAtMs: now }, v.version, []);
      if (r !== "ok") continue;
      await d.plus.notices.send({ userId: v.userId, template: "student_status_expiring", data: { valid_until_ms: v.validUntilMs ?? 0 } });
      noticed += 1;
    }
    for (const v of await d.students.listLapsed(now, limit)) {
      if (!studentLapsed(v, now)) continue;
      const r = await d.students.save(expireStudent(v), v.version, [{ type: "student.expired", userId: v.userId, verificationId: v.id }]);
      if (r === "ok") expired += 1;
    }
    return { noticed, expired };
  }
}

// ---- subscribe gate --------------------------------------------------------------------------

export type SubscribeByKindResult = SubscribeResult | { readonly kind: "student_verification_required" };

/**
 * Wraps `Subscribe` with the plan kind rules: a student plan needs a verified, unexpired status and
 * its own kill switch; a family plan needs the family kill switch. Individual plans pass through.
 */
export class SubscribeByKind {
  constructor(
    private readonly d: FamilyDeps,
    private readonly subscribe: Subscribe,
    private readonly eligibility: StudentEligibilityPort,
  ) {}

  async execute(i: SubscribeInput): Promise<SubscribeByKindResult> {
    const d = this.d.plus;
    const now = d.clock.nowMs();
    const plan = selectPlanVersion(await d.store.listPlanVersions(i.planCode), now);
    const kind = kindOf(plan);
    if (kind === "family" && !(await d.flags.enabled(PLUS_FLAGS.family))) return { kind: "unavailable" };
    if (kind === "student") {
      if (!(await d.flags.enabled(PLUS_FLAGS.student))) return { kind: "unavailable" };
      if (!(await this.eligibility.validAt(i.userId, now))) return { kind: "student_verification_required" };
    }
    const r = await this.subscribe.execute(i);
    if (kind === "family" && (r.kind === "subscribed" || r.kind === "existing")) await ensureGroup(this.d, i.userId);
    return r;
  }
}
