import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { ResourceType } from "@outlet/policy";
import { z } from "zod";
import { AuthenticatedSelf, Idempotent, RateLimit } from "../../../platform/decorators";
import type { ApiRequest } from "../../../platform/http-types";
import type { AuditSink, Clock } from "../../../platform/ports";
import { ProblemError, Problems } from "../../../platform/problem";
import { AUDIT_SINK, CLOCK } from "../../../platform/tokens";
import { ZodPipe } from "../../../platform/zod.pipe";
import type {
  DualApprovals,
  FeatureFlagAdmin,
  KycOutcome,
  KycTransitionView,
  RoleElevations,
  SellerKycAdmin,
  ViewPii,
} from "../application/admin";
import { computeAccess, hasAnyRole, ROUTE_ROLES, type AdminAccess } from "../domain/access";
import {
  ADMIN_REASON_CODES,
  ADMIN_ROLE_NAMES,
  APPROVAL_KINDS,
  KYC_STATES,
  type AdminRoleName,
  type ApprovalRecord,
  type ElevationRecord,
  type SuspensionReview,
} from "../domain/bridge";
import { PII_FIELDS, type AdminStore, type FlagView, type SellerKycView } from "../domain/ports";
import {
  ADMIN_STORE,
  DUAL_APPROVALS,
  FEATURE_FLAG_ADMIN,
  ROLE_ELEVATIONS,
  SELLER_KYC_ADMIN,
  VIEW_PII,
} from "./tokens";

const IdParam = z.object({ id: z.uuid() }).strict();
const SellerParam = z.object({ sellerId: z.uuid() }).strict();
const KeyParam = z.object({ key: z.string().regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/).max(80) }).strict();
const Reason = z.enum(ADMIN_REASON_CODES);
const Note = z.string().trim().min(1).max(500);
const Limit = z.coerce.number().int().min(1).max(200).default(50);

const ApprovalCreate = z
  .object({
    kind: z.enum(APPROVAL_KINDS),
    subject_type: z.string().regex(/^[a-z_]{1,40}$/),
    subject_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/),
    amount_minor: z.string().regex(/^\d{1,15}$/).optional(),
    reason_code: Reason,
  })
  .strict();
const ApprovalList = z
  .object({
    state: z.enum(["REQUESTED", "APPROVED", "REJECTED", "EXPIRED"]).optional(),
    kind: z.enum(APPROVAL_KINDS).optional(),
    mine: z.enum(["true", "false"]).optional(),
    limit: Limit,
  })
  .strict();
const DecisionBody = z.object({ note: Note.optional() }).strict();
const ElevationCreate = z
  .object({
    role: z.enum(ADMIN_ROLE_NAMES),
    reason_code: Reason,
    ttl_minutes: z.number().int().min(1).max(240).optional(),
  })
  .strict();
const PiiBody = z
  .object({
    subject_user_id: z.uuid(),
    fields: z.array(z.enum(PII_FIELDS)).min(1).max(PII_FIELDS.length),
    reason_code: Reason,
  })
  .strict();
const FlagSet = z.object({ enabled: z.boolean(), reason_code: Reason }).strict();
const FlagList = z.object({ kind: z.enum(["kill_switch", "release"]).optional() }).strict();
const KycQueueQuery = z.object({ state: z.enum(KYC_STATES).optional(), limit: Limit }).strict();
const KycAction = z.object({ reason_code: Reason }).strict();
const ReviewList = z.object({ state: z.enum(["OPEN", "UPHELD", "REINSTATED"]).optional(), limit: Limit }).strict();

const approvalWire = (a: ApprovalRecord) => ({
  id: a.id,
  kind: a.kind,
  subject_type: a.subjectType,
  subject_id: a.subjectId,
  amount_minor: a.amountMinor === null ? null : a.amountMinor.toString(),
  currency: "EGP",
  reason_code: a.reasonCode,
  requester_id: a.requesterId,
  state: a.state,
  approver_id: a.approverId,
  requested_at: new Date(a.requestedAtMs).toISOString(),
  expires_at: new Date(a.expiresAtMs).toISOString(),
  decided_at: a.decidedAtMs === null ? null : new Date(a.decidedAtMs).toISOString(),
});
const elevationWire = (e: ElevationRecord) => ({
  id: e.id,
  user_id: e.userId,
  role: e.role,
  reason_code: e.reasonCode,
  approval_id: e.approvalId,
  state: e.state,
  requested_at: new Date(e.requestedAtMs).toISOString(),
  activated_at: e.activatedAtMs === null ? null : new Date(e.activatedAtMs).toISOString(),
  expires_at: e.expiresAtMs === null ? null : new Date(e.expiresAtMs).toISOString(),
});
const flagWire = (f: FlagView) => ({
  key: f.key,
  kind: f.kind,
  description: f.description,
  enabled: f.enabled,
  is_default: f.isDefault,
});
const sellerWire = (s: SellerKycView) => ({
  seller_id: s.sellerId,
  kyc_state: s.state,
  store_count: s.storeCount,
  store_names: s.storeNames,
  updated_at: new Date(s.updatedAtMs).toISOString(),
});
const reviewWire = (r: SuspensionReview, nowMs: number) => ({
  id: r.id,
  seller_id: r.sellerId,
  state: r.state,
  reason_code: r.reasonCode,
  suspended_at: new Date(r.suspendedAtMs).toISOString(),
  due_at: new Date(r.dueAtMs).toISOString(),
  overdue: r.state === "OPEN" && nowMs > r.dueAtMs,
  automatic: r.suspendedBy === null,
  reviewed_at: r.reviewedAtMs === null ? null : new Date(r.reviewedAtMs).toISOString(),
});

const transitionWire = (v: KycTransitionView, nowMs: number) => ({
  ...sellerWire(v.seller),
  review: v.review === null ? null : reviewWire(v.review, nowMs),
});

const conflict = (code: string) => new ProblemError(409, code.replaceAll("_", "-"), "The request conflicts with the current state", { code });
const forbidden = (code: string) => Problems.forbidden(code);
const idempotent = { required: true } as const;
const rl = (limit: number) => [{ dimension: "user", limit, windowSeconds: 60 }] as const;

/**
 * Admin console endpoints (spec 23). Gate on every route, in order: admin audience (guard) ->
 * active actor (guard) -> passkey session -> role from standing grants or a LIVE elevation ->
 * route allow-list. A missing role is 403 with no detail, an object the caller may not see is 404.
 * Standing super_admin opens no route by itself; it needs a live, dual-approved break-glass session.
 * Every decision is written to the AuditSink; state changes and PII views also go to the hash chain.
 */
@Controller("admin")
export class AdminController {
  constructor(
    @Inject(ADMIN_STORE) private readonly store: AdminStore,
    @Inject(DUAL_APPROVALS) private readonly approvals: DualApprovals,
    @Inject(ROLE_ELEVATIONS) private readonly elevations: RoleElevations,
    @Inject(VIEW_PII) private readonly pii: ViewPii,
    @Inject(FEATURE_FLAG_ADMIN) private readonly flags: FeatureFlagAdmin,
    @Inject(SELLER_KYC_ADMIN) private readonly kyc: SellerKycAdmin,
    @Inject(AUDIT_SINK) private readonly audit: AuditSink,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async gate(
    req: ApiRequest,
    routeId: string,
    resourceType: ResourceType,
    action: "read" | "create" | "update" | "approve" | "invoke",
    allowed: readonly AdminRoleName[] | "any_standing",
    resourceId: string | null = null,
  ): Promise<{ access: AdminAccess; meta: { access: AdminAccess; requestId: string | null } }> {
    const actor = req.principal?.actor;
    if (actor === undefined) throw Problems.unauthenticated();
    const now = this.clock.nowMs();
    const live = await this.store.liveElevations(actor.id, now);
    const access = computeAccess(actor, live, now);
    let reason: "missing_role" | "passkey_required" | null = null;
    if (access.standing.length === 0) reason = "missing_role";
    else if (!access.passkey) reason = "passkey_required";
    else if (allowed !== "any_standing" && !hasAnyRole(access.effective, allowed)) reason = "missing_role";
    try {
      await this.audit.record({
        effect: reason === null ? "allow" : "deny",
        actorId: actor.id,
        action: action === "invoke" ? "update" : action,
        resourceType,
        resourceId,
        ruleId: `admin.${routeId}`,
        reason: reason ?? "allowed",
        httpStatus: reason === null ? 200 : 403,
        approverIds: [],
        atMs: now,
      });
    } catch {
      if (reason === null) throw Problems.unavailable("audit_unavailable");
    }
    if (reason !== null) throw forbidden(reason);
    return { access, meta: { access, requestId: req.ctx?.requestId ?? null } };
  }

  // ------------------------------------------------------------ approvals

  @Get("approvals")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async listApprovals(@Req() req: ApiRequest, @Query(new ZodPipe(ApprovalList, "/query")) q: z.infer<typeof ApprovalList>) {
    const { access } = await this.gate(req, "approvals.list", "admin_console", "read", "any_standing");
    const rows = await this.approvals.list(access, {
      ...(q.state !== undefined ? { states: [q.state] } : {}),
      ...(q.kind !== undefined ? { kinds: [q.kind] } : {}),
      mineOnly: q.mine === "true",
      limit: q.limit,
    });
    return { items: rows.map(approvalWire) };
  }

  @Post("approvals")
  @HttpCode(201)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idempotent)
  @RateLimit(rl(20))
  async requestApproval(@Req() req: ApiRequest, @Body(new ZodPipe(ApprovalCreate)) b: z.infer<typeof ApprovalCreate>) {
    const { meta } = await this.gate(req, "approvals.create", "admin_console", "create", "any_standing");
    const r = await this.approvals.request(meta, {
      kind: b.kind,
      subjectType: b.subject_type,
      subjectId: b.subject_id,
      amountMinor: b.amount_minor === undefined ? null : BigInt(b.amount_minor),
      reasonCode: b.reason_code,
    });
    switch (r.kind) {
      case "created":
        return approvalWire(r.record);
      case "not_required":
        // Below the threshold: no second approver is needed; the owning module proceeds.
        return { approval_required: false };
      case "denied":
        throw forbidden(r.reason);
      case "invalid":
        throw Problems.validation([{ pointer: "/body/reason_code", code: r.reason }]);
    }
  }

  @Get("approvals/:id")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async getApproval(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { access } = await this.gate(req, "approvals.read", "admin_console", "read", "any_standing", p.id);
    const r = await this.approvals.get(access, p.id);
    if (r === null) throw Problems.notFound();
    return approvalWire(r);
  }

  private async decide(req: ApiRequest, id: string, decision: "APPROVE" | "REJECT", note: string | undefined) {
    const { meta } = await this.gate(
      req,
      decision === "APPROVE" ? "approvals.approve" : "approvals.reject",
      "admin_console",
      "approve",
      "any_standing",
      id,
    );
    const r = await this.approvals.decide(meta, id, decision, note ?? null);
    switch (r.kind) {
      case "decided":
        return approvalWire(r.record);
      case "not_found":
        throw Problems.notFound();
      case "expired":
        throw conflict("approval_expired");
      case "conflict":
        throw conflict("approval_conflict");
      case "denied":
        if (r.reason === "not_pending") throw conflict("approval_not_pending");
        throw forbidden(r.reason);
    }
  }

  @Post("approvals/:id/approve")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(30))
  approve(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>,
  ) {
    return this.decide(req, p.id, "APPROVE", b.note);
  }

  @Post("approvals/:id/reject")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(30))
  reject(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>,
    @Body(new ZodPipe(DecisionBody)) b: z.infer<typeof DecisionBody>,
  ) {
    return this.decide(req, p.id, "REJECT", b.note);
  }

  // ---------------------------------------------------------- elevations

  @Post("elevations")
  @HttpCode(201)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idempotent)
  @RateLimit(rl(10))
  async requestElevation(@Req() req: ApiRequest, @Body(new ZodPipe(ElevationCreate)) b: z.infer<typeof ElevationCreate>) {
    const { meta } = await this.gate(req, "elevations.create", "role_grant", "create", "any_standing");
    const r = await this.elevations.request(meta, {
      role: b.role,
      reasonCode: b.reason_code,
      ttlMs: b.ttl_minutes === undefined ? null : b.ttl_minutes * 60_000,
    });
    if (r.kind === "denied") throw forbidden(r.reason);
    if (r.kind === "invalid") throw Problems.validation([{ pointer: "/body", code: r.reason }]);
    return { elevation: elevationWire(r.elevation), approval: approvalWire(r.approval) };
  }

  @Get("elevations/mine")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async myElevations(@Req() req: ApiRequest) {
    const { access } = await this.gate(req, "elevations.mine", "admin_console", "read", "any_standing");
    return { items: (await this.elevations.mine(access.actorId)).map(elevationWire) };
  }

  @Get("elevations")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(30))
  async activeElevations(@Req() req: ApiRequest) {
    await this.gate(req, "elevations.list", "audit_log", "read", ROUTE_ROLES.elevationsAdmin);
    return { items: (await this.elevations.active()).map(elevationWire) };
  }

  private elevationOutcome(r: Awaited<ReturnType<RoleElevations["activate"]>>) {
    switch (r.kind) {
      case "ok":
        return elevationWire(r.elevation);
      case "not_found":
        throw Problems.notFound();
      case "conflict":
        throw conflict("elevation_conflict");
      case "denied":
        throw forbidden(r.reason);
    }
  }

  @Post("elevations/:id/activate")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(10))
  async activate(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { meta } = await this.gate(req, "elevations.activate", "role_grant", "invoke", "any_standing", p.id);
    return this.elevationOutcome(await this.elevations.activate(meta, p.id));
  }

  @Post("elevations/:id/revoke")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(10))
  async revoke(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { access, meta } = await this.gate(req, "elevations.revoke", "role_grant", "update", "any_standing", p.id);
    const admin = hasAnyRole(access.effective, ROUTE_ROLES.elevationsAdmin);
    return this.elevationOutcome(await this.elevations.revoke(meta, p.id, admin));
  }

  // ------------------------------------------------------------ PII views

  @Post("pii-views")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(30))
  async piiView(@Req() req: ApiRequest, @Body(new ZodPipe(PiiBody)) b: z.infer<typeof PiiBody>) {
    const { meta } = await this.gate(req, "pii_view.read", "pii_view", "read", ROUTE_ROLES.piiView, b.subject_user_id);
    let r;
    try {
      r = await this.pii.execute(meta, { subjectUserId: b.subject_user_id, fields: b.fields, reasonCode: b.reason_code });
    } catch {
      // A failed audit append means no data: closed.
      throw Problems.unavailable("audit_unavailable");
    }
    if (r.kind === "invalid") throw Problems.validation([{ pointer: "/body/reason_code", code: r.reason }]);
    if (r.kind === "not_found") throw Problems.notFound();
    return { subject_user_id: b.subject_user_id, fields: r.fields, reason_code: b.reason_code };
  }

  // ---------------------------------------------------------------- flags

  @Get("flags")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async listFlags(@Req() req: ApiRequest, @Query(new ZodPipe(FlagList, "/query")) q: z.infer<typeof FlagList>) {
    await this.gate(req, "feature_flag.read", "feature_flag", "read", ROUTE_ROLES.flagsRead);
    return { items: (await this.flags.list(q.kind)).map(flagWire) };
  }

  /** The kill switches named in spec A2.12, with their current state. */
  @Get("kill-switches")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async killSwitches(@Req() req: ApiRequest) {
    await this.gate(req, "kill_switch.read", "feature_flag", "read", ROUTE_ROLES.flagsRead);
    return { items: (await this.flags.list("kill_switch")).map(flagWire) };
  }

  @Get("flags/:key")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async getFlag(@Req() req: ApiRequest, @Param(new ZodPipe(KeyParam, "/params")) p: z.infer<typeof KeyParam>) {
    await this.gate(req, "feature_flag.read", "feature_flag", "read", ROUTE_ROLES.flagsRead);
    const f = await this.flags.get(p.key);
    if (f === null) throw Problems.notFound();
    return flagWire(f);
  }

  @Put("flags/:key")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idempotent)
  @RateLimit(rl(20))
  async setFlag(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(KeyParam, "/params")) p: z.infer<typeof KeyParam>,
    @Body(new ZodPipe(FlagSet)) b: z.infer<typeof FlagSet>,
  ) {
    const { meta } = await this.gate(req, "feature_flag.update", "feature_flag", "update", ROUTE_ROLES.flagsWrite);
    let r;
    try {
      r = await this.flags.set(meta, p.key, b.enabled, b.reason_code);
    } catch {
      throw Problems.unavailable("audit_unavailable");
    }
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "invalid") throw Problems.validation([{ pointer: "/body/reason_code", code: r.reason }]);
    return { ...flagWire(r.after), previous_enabled: r.before.enabled };
  }

  // ------------------------------------------------------------------ KYC

  @Get("kyc/queue")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async kycQueue(@Req() req: ApiRequest, @Query(new ZodPipe(KycQueueQuery, "/query")) q: z.infer<typeof KycQueueQuery>) {
    await this.gate(req, "kyc.read", "admin_console", "read", ROUTE_ROLES.kycRead);
    const rows = await this.kyc.queue({ ...(q.state !== undefined ? { states: [q.state] } : {}), limit: q.limit });
    return { items: rows.map(sellerWire) };
  }

  @Get("kyc/sellers/:sellerId")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async kycSeller(@Req() req: ApiRequest, @Param(new ZodPipe(SellerParam, "/params")) p: z.infer<typeof SellerParam>) {
    await this.gate(req, "kyc.read", "admin_console", "read", ROUTE_ROLES.kycRead, p.sellerId);
    const v = await this.kyc.seller(p.sellerId);
    if (v === null) throw Problems.notFound();
    return { ...sellerWire(v.seller), open_review: v.review === null ? null : reviewWire(v.review, this.clock.nowMs()) };
  }

  private kycOutcome<V, T>(r: KycOutcome<V>, ok: (v: V) => T): T {
    switch (r.kind) {
      case "ok":
        return ok(r.value);
      case "not_found":
        throw Problems.notFound();
      case "invalid_transition":
        throw conflict("invalid_kyc_transition");
      case "conflict":
        throw conflict("kyc_conflict");
      case "denied":
        throw forbidden(r.reason);
      case "invalid":
        throw Problems.validation([{ pointer: "/body/reason_code", code: r.reason }]);
    }
  }

  @Post("kyc/sellers/:sellerId/suspend")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idempotent)
  @RateLimit(rl(20))
  async suspend(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(SellerParam, "/params")) p: z.infer<typeof SellerParam>,
    @Body(new ZodPipe(KycAction)) b: z.infer<typeof KycAction>,
  ) {
    const { meta } = await this.gate(req, "kyc.suspend", "admin_console", "update", ROUTE_ROLES.kycWrite, p.sellerId);
    const now = this.clock.nowMs();
    return this.kycOutcome(await this.kyc.suspend(meta, p.sellerId, b.reason_code), (v: KycTransitionView) =>
      transitionWire(v, now),
    );
  }

  @Post("kyc/sellers/:sellerId/reinstate")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @Idempotent(idempotent)
  @RateLimit(rl(20))
  async reinstate(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(SellerParam, "/params")) p: z.infer<typeof SellerParam>,
    @Body(new ZodPipe(KycAction)) b: z.infer<typeof KycAction>,
  ) {
    const { meta } = await this.gate(req, "kyc.reinstate", "admin_console", "update", ROUTE_ROLES.kycWrite, p.sellerId);
    const now = this.clock.nowMs();
    return this.kycOutcome(await this.kyc.reinstate(meta, p.sellerId, b.reason_code), (v: KycTransitionView) =>
      transitionWire(v, now),
    );
  }

  @Get("kyc/suspension-reviews")
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(60))
  async reviews(@Req() req: ApiRequest, @Query(new ZodPipe(ReviewList, "/query")) q: z.infer<typeof ReviewList>) {
    await this.gate(req, "kyc.review.read", "admin_console", "read", ROUTE_ROLES.kycReviewRead);
    const now = this.clock.nowMs();
    const rows = await this.kyc.reviews({ ...(q.state !== undefined ? { state: q.state } : {}), limit: q.limit });
    return { items: rows.map((r) => reviewWire(r, now)) };
  }

  @Post("kyc/suspension-reviews/:id/uphold")
  @HttpCode(200)
  @AuthenticatedSelf("admin_api")
  @RateLimit(rl(20))
  async uphold(@Req() req: ApiRequest, @Param(new ZodPipe(IdParam, "/params")) p: z.infer<typeof IdParam>) {
    const { meta } = await this.gate(req, "kyc.review.decide", "admin_console", "update", ROUTE_ROLES.kycWrite, p.id);
    const now = this.clock.nowMs();
    return this.kycOutcome(await this.kyc.uphold(meta, p.id), (v: SuspensionReview) => reviewWire(v, now));
  }
}
