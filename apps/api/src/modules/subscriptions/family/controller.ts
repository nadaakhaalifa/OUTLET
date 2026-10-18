import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import { subscriptionWire } from "../adapters/wire";
import { PAYMENT_METHODS } from "../domain/ports";
import {
  PLUS_ACCEPT_INVITE,
  PLUS_CREATE_FAMILY,
  PLUS_GET_FAMILY,
  PLUS_INVITE_MEMBER,
  PLUS_LEAVE_FAMILY,
  PLUS_REMOVE_MEMBER,
  PLUS_REVOKE_INVITE,
  PLUS_START_STUDENT,
  PLUS_STUDENT_CALLBACK,
  PLUS_STUDENT_STATUS,
} from "../adapters/tokens";
import type {
  AcceptInvite,
  CreateFamily,
  FamilyView,
  GetFamily,
  GetStudentStatus,
  HandleStudentCallback,
  InviteMember,
  LeaveFamily,
  RemoveMember,
  RevokeInvite,
  StartStudentVerification,
} from "./application";

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const CreateBody = z
  .object({
    payment_token_ref: z.string().min(1).max(200),
    method: z.enum(PAYMENT_METHODS).default("card"),
    device_id: z.string().min(1).max(128).optional(),
  })
  .strict();
const InviteBody = z
  .object({
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    nickname: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
const AcceptBody = z.object({ existing_plan: z.enum(["end_at_period_end"]).optional() }).strict();
const MemberParam = z.object({ memberId: z.string().uuid() }).strict();
const TokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/) }).strict();
const StudentBody = z
  .object({
    method: z.enum(["university_email", "verifier_session"]),
    university_email: z.string().email().max(254).optional(),
  })
  .strict()
  .refine((b) => b.method !== "university_email" || b.university_email !== undefined, {
    message: "university_email is required for the university_email method",
    path: ["university_email"],
  });

type RawBodyRequest = ApiRequest & { readonly rawBody?: Buffer | Uint8Array };

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};
const unprocessable = (code: string, title: string): ProblemError =>
  new ProblemError(422, code.replaceAll("_", "-"), title, { code });
const unavailable = (code: string, title: string): ProblemError => new ProblemError(503, code.replaceAll("_", "-"), title, { code });

function lowerHeaders(h: ApiRequest["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Owner sees seats by nickname only; a member sees only their own seat. No user ids, names or phones. */
function familyWire(v: FamilyView) {
  if (v.role === "owner") {
    return {
      role: "owner" as const,
      group_id: v.groupId,
      status: v.status,
      seat_limit: v.seatLimit,
      seats_held: v.seatsHeld,
      seats_free: v.seatsFree,
      seat_changes_90d: v.seatChangesInWindow,
      members: v.members.map((m) => ({
        id: m.id,
        role: m.role,
        status: m.status,
        nickname: m.nickname,
        seat_no: m.seatNo,
        seat_effective_from: isoOrNull(m.seatEffectiveFromMs),
        seat_end_at: isoOrNull(m.seatEndAtMs),
        invite_expires_at: isoOrNull(m.inviteExpiresAtMs),
      })),
    };
  }
  return {
    role: "member" as const,
    group_id: v.groupId,
    status: v.status,
    seat_status: v.seatStatus,
    seat_effective_from: isoOrNull(v.seatEffectiveFromMs),
    seat_end_at: isoOrNull(v.seatEndAtMs),
    entitlement_ends_at: isoOrNull(v.entitlementEndsAtMs),
  };
}

/**
 * Family and student plan routes (spec P3-03). Every route is scoped to the caller: group routes
 * resolve the caller's own group server side, so an id from another family answers 404 exactly
 * like a missing one (BOLA). Writes require an Idempotency-Key.
 */
@Controller()
export class FamilyController {
  constructor(
    @Inject(PLUS_CREATE_FAMILY) private readonly create: CreateFamily,
    @Inject(PLUS_GET_FAMILY) private readonly getFamily: GetFamily,
    @Inject(PLUS_INVITE_MEMBER) private readonly invite: InviteMember,
    @Inject(PLUS_REVOKE_INVITE) private readonly revoke: RevokeInvite,
    @Inject(PLUS_ACCEPT_INVITE) private readonly accept: AcceptInvite,
    @Inject(PLUS_REMOVE_MEMBER) private readonly remove: RemoveMember,
    @Inject(PLUS_LEAVE_FAMILY) private readonly leave: LeaveFamily,
    @Inject(PLUS_START_STUDENT) private readonly startStudent: StartStudentVerification,
    @Inject(PLUS_STUDENT_CALLBACK) private readonly studentCallback: HandleStudentCallback,
    @Inject(PLUS_STUDENT_STATUS) private readonly studentStatus: GetStudentStatus,
  ) {}

  @Post("plus/family")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 600 }])
  async createRoute(@Req() req: ApiRequest, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    const userId = principalOf(req).actor.id;
    const r = await this.create.execute({
      userId,
      tokenRef: b.payment_token_ref,
      deviceId: b.device_id ?? null,
      method: b.method,
      requestKey: headerValue(req, "idempotency-key") ?? "",
    });
    switch (r.kind) {
      case "subscribed":
      case "existing": {
        const family = await this.getFamily.execute(userId);
        return {
          subscription: subscriptionWire(r.subscription),
          trial: r.kind === "subscribed" ? r.trial : false,
          family: family === null ? null : familyWire(family),
        };
      }
      case "requires_action":
        return { status: "requires_action", signup_id: r.signupId, client_action: r.action };
      case "family_unavailable":
      case "unavailable":
        throw unavailable("family_unavailable", "Family plans are temporarily unavailable");
      case "method_unavailable":
        throw unavailable("method_unavailable", "This payment method is not available for Plus");
      case "wrong_plan":
        throw new ProblemError(409, "wrong-plan", "Switch plan from your current Plus plan to the family plan", { code: "wrong_plan" });
      case "age_gate":
        throw new ProblemError(403, "age-gate", "Plus requires a higher minimum age", { code: "age_gate", extensions: { min_age: r.minAge } });
      case "plan_not_found":
        throw Problems.notFound();
      case "invalid_payment_method":
        throw unprocessable("invalid_payment_method", "The payment method is not valid");
      case "payment_failed":
        throw new ProblemError(402, "payment-failed", "The payment was not completed", { code: "payment_failed" });
    }
  }

  @Get("me/plus/family")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async mine(@Req() req: ApiRequest) {
    const v = await this.getFamily.execute(principalOf(req).actor.id);
    if (v === null) throw Problems.notFound();
    return familyWire(v);
  }

  @Post("plus/family/invites")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async inviteRoute(@Req() req: ApiRequest, @Body(new ZodPipe(InviteBody)) b: z.infer<typeof InviteBody>) {
    const r = await this.invite.execute({
      ownerUserId: principalOf(req).actor.id,
      phoneE164: b.phone,
      nickname: b.nickname ?? null,
    });
    switch (r.kind) {
      case "invited":
        return { id: r.memberId, invite_id: r.inviteId, status: "INVITED", expires_at: iso(r.expiresAtMs) };
      case "family_unavailable":
        throw unavailable("family_unavailable", "Family plans are temporarily unavailable");
      case "not_owner":
        throw Problems.notFound();
      case "delivery_failed":
        throw unavailable("invite_delivery_failed", "The invitation could not be sent, try again");
      case "conflict":
        throw new ProblemError(409, "conflict", "The family changed, reload and retry", { code: "conflict" });
      case "refused":
        if (r.reason === "age_gate") {
          throw new ProblemError(403, "age-gate", "The invited person does not meet the plan's minimum age", {
            code: "age_gate",
            extensions: { min_age: r.minAge ?? 18 },
          });
        }
        throw new ProblemError(422, `invite-${r.reason.replaceAll("_", "-")}`, "This invitation cannot be sent", { code: `invite_${r.reason}` });
    }
  }

  @Delete("plus/family/invites/:memberId")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async revokeRoute(@Req() req: ApiRequest, @Param(new ZodPipe(MemberParam, "/params")) p: z.infer<typeof MemberParam>) {
    const r = await this.revoke.execute(principalOf(req).actor.id, p.memberId.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
    return { revoked: true };
  }

  @Post("plus/family/invites/:token/accept")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async acceptRoute(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(TokenParam, "/params")) p: z.infer<typeof TokenParam>,
    @Body(new ZodPipe(AcceptBody)) b: z.infer<typeof AcceptBody>,
  ) {
    const r = await this.accept.execute({
      userId: principalOf(req).actor.id,
      token: p.token,
      existingPlan: b.existing_plan ?? null,
    });
    switch (r.kind) {
      case "accepted":
        return { accepted: true, group_id: r.groupId, own_plan_ending: r.ownPlanEnding };
      case "not_found":
        throw Problems.notFound();
      case "family_unavailable":
        throw unavailable("family_unavailable", "Family plans are temporarily unavailable");
      case "invite_expired":
        throw new ProblemError(410, "invite-expired", "This invitation has expired", { code: "invite_expired" });
      case "invite_unavailable":
        throw new ProblemError(410, "invite-unavailable", "This invitation is no longer available", { code: "invite_unavailable" });
      case "age_gate":
        throw new ProblemError(403, "age-gate", "Joining requires a higher minimum age", { code: "age_gate", extensions: { min_age: r.minAge } });
      case "already_in_family":
        throw new ProblemError(409, "already-in-family", "You already belong to a family plan", { code: "already_in_family" });
      case "owner_not_entitled":
        throw new ProblemError(409, "owner-not-entitled", "This family plan is not active", { code: "owner_not_entitled" });
      case "existing_plan_choice_required":
        throw new ProblemError(409, "existing-plan-choice-required", "You have your own Plus plan: choose to end it at its period end to join", {
          code: "existing_plan_choice_required",
        });
      case "conflict":
        throw new ProblemError(409, "conflict", "The family changed, reload and retry", { code: "conflict" });
    }
  }

  @Delete("plus/family/members/:memberId")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 60 }])
  async removeRoute(@Req() req: ApiRequest, @Param(new ZodPipe(MemberParam, "/params")) p: z.infer<typeof MemberParam>) {
    const r = await this.remove.execute(principalOf(req).actor.id, p.memberId.toLowerCase());
    switch (r.kind) {
      case "ok":
        return { removed: true, seat_end_at: iso(r.seatEndAtMs) };
      case "family_unavailable":
        throw unavailable("family_unavailable", "Family plans are temporarily unavailable");
      default:
        throw Problems.notFound();
    }
  }

  @Post("plus/family/leave")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 600 }])
  async leaveRoute(@Req() req: ApiRequest) {
    const r = await this.leave.execute(principalOf(req).actor.id);
    switch (r.kind) {
      case "ok":
        return { left: true, seat_end_at: iso(r.seatEndAtMs) };
      case "owner_cannot_leave":
        throw unprocessable("owner_cannot_leave", "The owner ends the plan by cancelling it");
      case "family_unavailable":
        throw unavailable("family_unavailable", "Family plans are temporarily unavailable");
      case "not_found":
        throw Problems.notFound();
    }
  }

  // ---- student ----

  @Post("plus/student/verify")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 600 }])
  async studentVerify(@Req() req: ApiRequest, @Body(new ZodPipe(StudentBody)) b: z.infer<typeof StudentBody>) {
    const r = await this.startStudent.execute({
      userId: principalOf(req).actor.id,
      method: b.method,
      universityEmail: b.university_email ?? null,
    });
    switch (r.kind) {
      case "started":
        return { verification_id: r.verificationId, status: "PENDING", client_action: r.clientAction };
      case "student_unavailable":
        throw unavailable("student_unavailable", "Student verification is temporarily unavailable");
      case "domain_not_allowed":
        throw unprocessable("domain_not_allowed", "This university email domain is not supported");
    }
  }

  @Get("me/plus/student")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async studentMine(@Req() req: ApiRequest) {
    const v = await this.studentStatus.execute(principalOf(req).actor.id);
    return { status: v.status, valid_until: isoOrNull(v.validUntilMs), price_applies: v.priceApplies };
  }

  /** Verifier callback: authenticated by the verifier's MAC, never by a user token. Replays are no-ops. */
  @Post("plus/student/verify/callback")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 120, windowSeconds: 60 }], "open")
  async studentCallbackRoute(@Req() req: RawBodyRequest) {
    if (req.rawBody === undefined) throw Problems.internal();
    const r = await this.studentCallback.execute({ rawBody: req.rawBody, headers: lowerHeaders(req.headers) });
    if (r.kind === "rejected") throw Problems.unauthenticated("invalid_credentials");
    return { received: true };
  }
}
