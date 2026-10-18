import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, msOrNull, toPortError, ms, type AdapterContext } from "../../services/wire";
import {
  isPlausibleInviteToken, safeVerifierUrl,
  type AcceptOutcome, type AcceptRefusalReason, type FamilyPort, type FamilySeat, type FamilySnapshot, type FamilyView, type InviteOutcome,
  type InviteRefusalReason, type PlanInfo, type StudentMethod, type StudentStartOutcome, type StudentStatus,
} from "./model";

const INVITE_CODES: Readonly<Record<string, InviteRefusalReason>> = {
  invite_group_ended: "groupEnded",
  invite_owner_not_entitled: "ownerNotEntitled",
  invite_seats_full: "seatsFull",
  invite_seat_churn_limit: "seatChurnLimit",
  invite_already_in_family: "alreadyInFamily",
  invite_self_invite: "selfInvite",
  invite_already_invited: "alreadyInvited",
  invite_delivery_failed: "deliveryFailed",
  family_unavailable: "unavailable",
  conflict: "conflict",
};

const ACCEPT_CODES: Readonly<Record<string, AcceptRefusalReason>> = {
  invite_expired: "expired",
  invite_unavailable: "unavailable",
  already_in_family: "alreadyInFamily",
  owner_not_entitled: "ownerNotEntitled",
  conflict: "conflict",
  family_unavailable: "serviceUnavailable",
};

function seat(s: schemas.PlusFamilySeat): FamilySeat {
  return {
    id: s.id, role: s.role, status: s.status, nickname: s.nickname, seatNo: s.seat_no,
    seatEffectiveFromMs: msOrNull(s.seat_effective_from), seatEndAtMs: msOrNull(s.seat_end_at), inviteExpiresAtMs: msOrNull(s.invite_expires_at),
  };
}

export function familyFromWire(v: schemas.PlusFamilyView): FamilyView {
  if (v.role === "owner") {
    return { role: "owner", groupId: v.group_id, status: v.status, seatLimit: v.seat_limit, seatsHeld: v.seats_held, seatsFree: v.seats_free, members: v.members.map(seat) };
  }
  return {
    role: "member", groupId: v.group_id, status: v.status, seatStatus: v.seat_status,
    seatEndAtMs: msOrNull(v.seat_end_at), entitlementEndsAtMs: msOrNull(v.entitlement_ends_at),
  };
}

function planInfo(p: schemas.PlusPaywallPlan): PlanInfo {
  return { code: p.code, price: BigInt(p.price.amount_minor), interval: p.interval, seatLimit: p.seat_limit };
}

function minAgeOf(e: ApiError): number | null {
  const v = e.problem["min_age"];
  return typeof v === "number" ? v : null;
}

/**
 * /v1/plus/family*, /v1/me/plus/family, /v1/plus/student/verify, /v1/me/plus/student. Creating a family plan
 * needs a PSP payment token (same gap as Plus subscribe), so it is not part of this port. The student status
 * wire has no verifier name (gap): `verifier` stays null and the copy says "our verification partner".
 */
export class ApiFamilyPort implements FamilyPort {
  constructor(private readonly ctx: AdapterContext) {}

  load(): Promise<FamilySnapshot> {
    return guard(async () => {
      const [family, student, paywall] = await Promise.all([
        this.ctx.client.getMyPlusFamily().then((r) => familyFromWire(dataOf(r)), (e: unknown) => {
          // 404 means "not in a family", not a failure.
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }),
        this.ctx.client.getMyStudentStatus().then(dataOf),
        this.ctx.client.getPlusPaywall().then(dataOf),
      ]);
      const status: StudentStatus = {
        status: student.status, validUntilMs: msOrNull(student.valid_until), priceApplies: student.price_applies, verifier: null,
      };
      const fam = paywall.plans.find((p) => p.kind === "family");
      const stu = paywall.plans.find((p) => p.kind === "student");
      return { family, student: status, familyPlan: fam !== undefined ? planInfo(fam) : null, studentPlan: stu !== undefined ? planInfo(stu) : null };
    });
  }

  async invite(phoneE164: string, nickname: string | null, idempotencyKey: string): Promise<InviteOutcome> {
    try {
      const r = dataOf(await this.ctx.client.inviteFamilyMember({ body: { phone: phoneE164, ...(nickname !== null ? { nickname } : {}) } }, { idempotencyKey }));
      return { kind: "invited", expiresAtMs: ms(r.expires_at) };
    } catch (e) {
      if (e instanceof ApiError) {
        const code = e.code ?? "";
        if (e.status === 403 && code === "age_gate") return { kind: "refused", reason: "ageGate", minAge: minAgeOf(e) };
        const reason = INVITE_CODES[code];
        if (reason !== undefined) return { kind: "refused", reason, minAge: null };
        if (e.status === 503) return { kind: "refused", reason: "unavailable", minAge: null };
      }
      throw toPortError(e);
    }
  }

  revokeInvite(seatId: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.revokeFamilyInvite({ path: { memberId: seatId } }, { idempotencyKey }));
    });
  }

  removeMember(seatId: string, idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.removeFamilyMember({ path: { memberId: seatId } }, { idempotencyKey }));
    });
  }

  leave(idempotencyKey: string): Promise<void> {
    return guard(async () => {
      dataOf(await this.ctx.client.leaveFamily(undefined, { idempotencyKey }));
    });
  }

  async acceptInvite(token: string, endOwnPlanAtPeriodEnd: boolean, idempotencyKey: string): Promise<AcceptOutcome> {
    // A malformed token never reaches the network; the shopper sees "this invitation is not valid".
    if (!isPlausibleInviteToken(token)) return { kind: "refused", reason: "unknown", minAge: null };
    try {
      const r = dataOf(await this.ctx.client.acceptFamilyInvite(
        { path: { token }, body: endOwnPlanAtPeriodEnd ? { existing_plan: "end_at_period_end" } : {} },
        { idempotencyKey },
      ));
      return r.accepted ? { kind: "accepted", ownPlanEnding: r.own_plan_ending } : { kind: "refused", reason: "unknown", minAge: null };
    } catch (e) {
      if (e instanceof ApiError) {
        const code = e.code ?? "";
        if (code === "existing_plan_choice_required") return { kind: "choiceRequired" };
        if (e.status === 403 && code === "age_gate") return { kind: "refused", reason: "ageGate", minAge: minAgeOf(e) };
        if (e.status === 404) return { kind: "refused", reason: "unknown", minAge: null };
        const reason = ACCEPT_CODES[code];
        if (reason !== undefined) return { kind: "refused", reason, minAge: null };
      }
      throw toPortError(e);
    }
  }

  async startStudentVerification(method: StudentMethod, universityEmail: string | null, idempotencyKey: string): Promise<StudentStartOutcome> {
    try {
      const body: schemas.PlusStudentVerifyRequest = {
        method: method === "universityEmail" ? "university_email" : "verifier_session",
        ...(universityEmail !== null ? { university_email: universityEmail } : {}),
      };
      const r = dataOf(await this.ctx.client.startStudentVerification({ body }, { idempotencyKey }));
      return { kind: "started", redirectUrl: safeVerifierUrl(r.client_action.url) };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.code === "domain_not_allowed") return { kind: "refused", reason: "domainNotAllowed" };
        if (e.status === 503) return { kind: "refused", reason: "unavailable" };
      }
      throw toPortError(e);
    }
  }
}

