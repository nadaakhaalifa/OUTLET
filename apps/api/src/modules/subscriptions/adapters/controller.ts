import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, AuthenticatedSelf, Idempotent, Public, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { GetSubscriptionMetrics } from "../application/metrics";
import type { GetMyPlus } from "../application/member";
import type {
  CancelPlus,
  ManageResult,
  PausePlus,
  ReactivatePlus,
  RefundPlus,
  ResumePlus,
  SwitchPlan,
} from "../application/manage";
import type { ListPlanVersions, ListPlans, PublishPlanVersion, SetPlanActive } from "../application/plans";
import type { SubscribeByKind } from "../family/application";
import type { HandleRecurringWebhook } from "../application/sweeper";
import { PAYMENT_METHODS, type RecurringWebhookVerifierPort } from "../domain/ports";
import {
  PLUS_ADMIN_RESOLVER,
  PLUS_CANCEL,
  PLUS_LIST_PLAN_VERSIONS,
  PLUS_LIST_PLANS,
  PLUS_METRICS,
  PLUS_MINE,
  PLUS_PAUSE,
  PLUS_PUBLISH_PLAN,
  PLUS_REACTIVATE,
  PLUS_REFUND,
  PLUS_RESUME,
  PLUS_SET_PLAN_ACTIVE,
  PLUS_SUBSCRIBE,
  PLUS_SWITCH,
  PLUS_WEBHOOK,
  PLUS_WEBHOOK_VERIFIER,
} from "./tokens";
import { adminPlanWire, mePlusWire, paywallWire, subscriptionWire } from "./wire";

const PlanCode = z.string().regex(/^plus_[a-z0-9_]{1,40}$/);
const SubscribeBody = z
  .object({
    plan_code: PlanCode,
    payment_token_ref: z.string().min(1).max(200),
    method: z.enum(PAYMENT_METHODS).default("card"),
    device_id: z.string().min(1).max(128).optional(),
  })
  .strict();
const PauseBody = z.object({ months: z.number().int().min(1).max(3) }).strict();
const SwitchBody = z.object({ plan_code: PlanCode }).strict();
const PublishBody = z
  .object({
    code: PlanCode,
    interval: z.enum(["month", "year"]),
    price_minor: z.string().regex(/^[1-9]\d{0,11}$/),
    trial_days: z.number().int().min(0).max(60).default(0),
    effective_from: z.iso.datetime(),
    approval_id: z.string().uuid(),
    kind: z.enum(["individual", "family", "student"]).optional(),
    seat_limit: z.number().int().min(2).max(8).optional(),
  })
  .strict();
const MetricsQuery = z.object({ window_days: z.coerce.number().int().min(1).max(365).default(30) }).strict();
const PlanIdParam = z.object({ planId: z.string().uuid() }).strict();
const ActiveBody = z.object({ active: z.boolean() }).strict();
const ProviderParam = z.object({ provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) }).strict();

const FINANCE_ROLES = ["finance", "super_admin"] as const;
const READ_ROLES = ["finance", "ops", "super_admin"] as const;

type RawBodyRequest = ApiRequest & { readonly rawBody?: Buffer | Uint8Array };

const principalOf = (req: ApiRequest) => {
  const p = req.principal;
  if (p === null || p === undefined) throw Problems.unauthenticated();
  return p;
};

const unprocessable = (code: string, title: string): ProblemError =>
  new ProblemError(422, code.replaceAll("_", "-"), title, { code });

function manage(r: ManageResult) {
  switch (r.kind) {
    case "ok":
      return { subscription: subscriptionWire(r.subscription) };
    case "not_found":
      throw Problems.notFound();
    case "invalid_state":
      throw new ProblemError(409, "invalid-state", "This action is not available in the current state", {
        code: "invalid_state",
      });
    case "invalid_months":
      throw Problems.validation([{ pointer: "/body/months", code: "invalid" }]);
    case "conflict":
      throw new ProblemError(409, "conflict", "The subscription changed, reload and retry", { code: "conflict" });
  }
}

function lowerHeaders(h: ApiRequest["headers"]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

@Controller()
export class SubscriptionsController {
  constructor(
    @Inject(PLUS_LIST_PLANS) private readonly plans: ListPlans,
    @Inject(PLUS_SUBSCRIBE) private readonly subscribe: SubscribeByKind,
    @Inject(PLUS_CANCEL) private readonly cancel: CancelPlus,
    @Inject(PLUS_REACTIVATE) private readonly reactivate: ReactivatePlus,
    @Inject(PLUS_PAUSE) private readonly pause: PausePlus,
    @Inject(PLUS_RESUME) private readonly resume: ResumePlus,
    @Inject(PLUS_SWITCH) private readonly switchPlan: SwitchPlan,
    @Inject(PLUS_REFUND) private readonly refund: RefundPlus,
    @Inject(PLUS_MINE) private readonly mine: GetMyPlus,
    @Inject(PLUS_WEBHOOK) private readonly webhook: HandleRecurringWebhook,
    @Inject(PLUS_WEBHOOK_VERIFIER) private readonly verifier: RecurringWebhookVerifierPort,
    @Inject(PLUS_PUBLISH_PLAN) private readonly publish: PublishPlanVersion,
    @Inject(PLUS_SET_PLAN_ACTIVE) private readonly setActive: SetPlanActive,
    @Inject(PLUS_LIST_PLAN_VERSIONS) private readonly versions: ListPlanVersions,
    @Inject(PLUS_METRICS) private readonly metrics: GetSubscriptionMetrics,
  ) {}

  // ---- shopper: no object id appears in any path, so the subject is always the caller (no BOLA surface) ----

  @Get("plus/plans")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async listPlans() {
    return paywallWire(await this.plans.execute());
  }

  @Get("me/plus")
  @AuthenticatedSelf()
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async me(@Req() req: ApiRequest) {
    return mePlusWire(await this.mine.execute(principalOf(req).actor.id));
  }

  @Post("plus/subscribe")
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 600 }])
  async subscribeRoute(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(SubscribeBody)) b: z.infer<typeof SubscribeBody>,
  ) {
    const key = headerValue(req, "idempotency-key") ?? "";
    const r = await this.subscribe.execute({
      userId: principalOf(req).actor.id,
      planCode: b.plan_code,
      tokenRef: b.payment_token_ref,
      deviceId: b.device_id ?? null,
      method: b.method,
      requestKey: key,
    });
    switch (r.kind) {
      case "subscribed":
        return { subscription: subscriptionWire(r.subscription), trial: r.trial };
      case "existing":
        return { subscription: subscriptionWire(r.subscription), trial: false };
      case "requires_action":
        return { status: "requires_action", signup_id: r.signupId, client_action: r.action };
      case "unavailable":
        throw new ProblemError(503, "plus-unavailable", "Plus sign-up is temporarily unavailable", { code: "plus_unavailable" });
      case "method_unavailable":
        throw new ProblemError(503, "method-unavailable", "This payment method is not available for Plus", {
          code: "method_unavailable",
        });
      case "age_gate":
        throw new ProblemError(403, "age-gate", "Plus requires a higher minimum age", {
          code: "age_gate",
          extensions: { min_age: r.minAge },
        });
      case "plan_not_found":
        throw Problems.notFound();
      case "student_verification_required":
        throw new ProblemError(403, "student-verification-required", "A verified student status is required for this plan", {
          code: "student_verification_required",
        });
      case "invalid_payment_method":
        throw unprocessable("invalid_payment_method", "The payment method is not valid");
      case "payment_failed":
        throw new ProblemError(402, "payment-failed", "The payment was not completed", { code: "payment_failed" });
    }
  }

  @Post("plus/cancel")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 600 }])
  async cancelRoute(@Req() req: ApiRequest) {
    return manage(await this.cancel.execute(principalOf(req).actor.id));
  }

  @Post("plus/reactivate")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 600 }])
  async reactivateRoute(@Req() req: ApiRequest) {
    return manage(await this.reactivate.execute(principalOf(req).actor.id));
  }

  @Post("plus/pause")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 600 }])
  async pauseRoute(@Req() req: ApiRequest, @Body(new ZodPipe(PauseBody)) b: z.infer<typeof PauseBody>) {
    return manage(await this.pause.execute(principalOf(req).actor.id, b.months));
  }

  @Post("plus/resume")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 600 }])
  async resumeRoute(@Req() req: ApiRequest) {
    return manage(await this.resume.execute(principalOf(req).actor.id));
  }

  @Post("plus/switch-plan")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 5, windowSeconds: 600 }])
  async switchRoute(@Req() req: ApiRequest, @Body(new ZodPipe(SwitchBody)) b: z.infer<typeof SwitchBody>) {
    const r = await this.switchPlan.execute(principalOf(req).actor.id, b.plan_code);
    switch (r.kind) {
      case "plan_not_found":
        throw Problems.notFound();
      case "same_plan":
        throw unprocessable("same_plan", "You are already on this plan");
      case "student_verification_required":
        throw new ProblemError(403, "student-verification-required", "A verified student status is required for this plan", {
          code: "student_verification_required",
        });
      case "payment_failed":
        throw new ProblemError(402, "payment-failed", "The payment was not completed", { code: "payment_failed" });
      case "requires_action":
        return { status: "requires_action", client_action: r.action };
      default:
        return manage(r);
    }
  }

  @Post("plus/refund")
  @HttpCode(200)
  @AuthenticatedSelf()
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 3, windowSeconds: 600 }])
  async refundRoute(@Req() req: ApiRequest) {
    const r = await this.refund.execute(principalOf(req).actor.id);
    switch (r.kind) {
      case "refunded":
        return {
          refunded: true,
          amount_minor: r.amountMinor.toString(),
          currency: "EGP",
          destination: "original_payment_method",
          subscription: subscriptionWire(r.subscription),
        };
      case "not_found":
        throw Problems.notFound();
      case "not_eligible":
        throw unprocessable(`refund_${r.reason}`, "This charge cannot be refunded");
      case "refund_failed":
        throw new ProblemError(502, "refund-failed", "The refund could not be started, try again", { code: "refund_failed" });
      case "conflict":
        throw new ProblemError(409, "conflict", "The subscription changed, reload and retry", { code: "conflict" });
    }
  }

  // ---- PSP recurring webhook: authenticated by MAC, never by a user token ----

  @Post("webhooks/:provider/recurring")
  @HttpCode(200)
  @Public()
  @RateLimit([{ dimension: "ip", limit: 600, windowSeconds: 60 }], "open")
  async recurringWebhook(
    @Req() req: RawBodyRequest,
    @Param(new ZodPipe(ProviderParam, "/params")) p: z.infer<typeof ProviderParam>,
  ) {
    if (req.rawBody === undefined) throw Problems.internal();
    const v = await this.verifier.verify({
      provider: p.provider,
      rawBody: req.rawBody,
      headers: lowerHeaders(req.headers),
      ip: req.ip,
    });
    if (v.kind === "rejected") throw Problems.unauthenticated("invalid_credentials");
    await this.webhook.execute(v.event);
    return { received: true };
  }

  // ---- admin: finance manages plan versions; price changes need an approved dual approval ----

  private requireRole(req: ApiRequest, roles: readonly string[]): string {
    const actor = principalOf(req).actor;
    const ok = actor.grants.some((g) => g.kind === "admin" && roles.includes(g.role));
    if (!ok) throw Problems.forbidden();
    return actor.id;
  }

  @Get("admin/subscriptions/metrics")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: PLUS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async adminMetrics(@Req() req: ApiRequest, @Query(new ZodPipe(MetricsQuery, "/query")) q: z.output<typeof MetricsQuery>) {
    this.requireRole(req, READ_ROLES);
    const m = await this.metrics.execute(q.window_days);
    return {
      window_days: m.windowDays,
      active: m.active,
      trialing: m.counts.byStatus.TRIALING,
      past_due: m.counts.byStatus.PAST_DUE,
      paused: m.paused,
      cancelled_at_period_end: m.cancelledAtPeriodEnd,
      expired: m.counts.byStatus.EXPIRED,
      new_in_window: m.counts.createdSince,
      live_at_window_start: m.counts.liveAtStart,
      ended_in_window: m.counts.endedSince,
      churn_bps: m.churnBps,
    };
  }

  @Get("admin/plus/plans")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: PLUS_ADMIN_RESOLVER, idParam: "none" })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async adminList(@Req() req: ApiRequest) {
    this.requireRole(req, READ_ROLES);
    return { items: (await this.versions.execute()).map(adminPlanWire) };
  }

  @Post("admin/plus/plans")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: PLUS_ADMIN_RESOLVER, idParam: "none" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async adminPublish(@Req() req: ApiRequest, @Body(new ZodPipe(PublishBody)) b: z.infer<typeof PublishBody>) {
    const actorId = this.requireRole(req, FINANCE_ROLES);
    const r = await this.publish.execute({
      actorId,
      code: b.code,
      interval: b.interval,
      priceMinor: BigInt(b.price_minor),
      trialDays: b.trial_days,
      effectiveFromMs: Date.parse(b.effective_from),
      approvalId: b.approval_id,
      ...(b.kind !== undefined ? { kind: b.kind } : {}),
      ...(b.seat_limit !== undefined ? { seatLimit: b.seat_limit } : {}),
    });
    switch (r.kind) {
      case "published":
        return { plan: adminPlanWire(r.plan), members_notified: r.notified };
      case "notice_too_short":
        throw new ProblemError(422, "notice-too-short", "A price change needs at least 30 days notice", {
          code: "notice_too_short",
          extensions: { min_effective_from: new Date(r.minEffectiveFromMs).toISOString() },
        });
      case "interval_mismatch":
        throw unprocessable("interval_mismatch", "A plan code keeps its billing interval");
      case "kind_mismatch":
        throw unprocessable("kind_mismatch", "A plan code keeps its plan kind");
      case "seat_limit_invalid":
        throw unprocessable("seat_limit_invalid", "Seat limit applies to family plans only, between 2 and 8");
      case "approval_required":
        throw new ProblemError(403, "dual-approval-required", "An approved dual approval is required", {
          code: "dual_approval_required",
        });
    }
  }

  @Patch("admin/plus/plans/:planId")
  @Authorize({ audience: "admin_api", action: "read", resourceType: "admin_console", resolver: PLUS_ADMIN_RESOLVER, idParam: "planId" })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 60 }])
  async adminSetActive(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(PlanIdParam, "/params")) p: z.infer<typeof PlanIdParam>,
    @Body(new ZodPipe(ActiveBody)) b: z.infer<typeof ActiveBody>,
  ) {
    this.requireRole(req, FINANCE_ROLES);
    const plan = await this.setActive.execute(p.planId.toLowerCase(), b.active);
    if (plan === null) throw Problems.notFound();
    return { plan: adminPlanWire(plan) };
  }
}

